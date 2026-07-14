import path from "path";
import fs, { readFileSync } from "fs";
import { execSync, ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import { resolve } from "path";
import { createLogger } from "../logger.js";
import { authHeaders, mcpAuthHeaders } from "../coordinator-auth.js";
import { ensureRunId } from "../run-id.js";
import { startServer } from "mcp-coordinator";
type ServerHandle = Awaited<ReturnType<typeof startServer>>;
const log = createLogger("orchestrator");

let __filename: string;
try {
  __filename = fileURLToPath(import.meta.url);
} catch {
  __filename = process.execPath;  // fall back to binary path under Bun --compile
}
const __dirname = path.dirname(__filename);
import { createWorkspaces, cleanupWorkspaces, resetBase } from "./workspace.js";
import { launchAgent, launchAgentLoop, waitForProcess, randomDelay, fixedDelay } from "./agent-launcher.js";
import type { AgentLoopResult } from "../agent-loop/agent-loop.js";
import { fetchCoordinatorMetrics } from "./metrics.js";
import { collectAgentResults } from "./reporter.js";
import type { AgentConfig, MiniProject, AgentProcess, RunResult } from "./types.js";
import { scanProject } from "./scanner.js";

import { getCatalogRoots, getScriptsDirs } from "../../cli/bce-resolver.js";
import { runPipeline } from "@swoofer/promptweave";
import { preflightQuotaCheck, resolveMaxUtilizationPct } from "./preflight.js";

const CLAUDE_HOOK_EVENT_MAP: Record<string, string> = {
  "session-start": "SessionStart",
  "pre-tool-use": "PreToolUse",
  "post-tool-use": "PostToolUse",
  "session-stop": "Stop",
};

const POST_TOOL_USE_MATCHER = "Edit|Write|NotebookEdit";

/**
 * Cross-platform replacement for `execSync(\`curl -d '...'\`)`. The shell-quoted
 * form silently breaks under Windows cmd.exe (single quotes aren't grouping
 * tokens there → curl receives mangled JSON, the request never reaches the
 * server, the `try/catch {}` swallows the failure and downstream code wrongly
 * believes the agent was registered). Returns true on 2xx, false otherwise.
 */
async function postJson(url: string, body: unknown, timeoutMs = 5000): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log.warn(`POST ${url} → HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    log.warn(`POST ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

const COORDINATOR_URL = process.env.COORDINATOR_URL || "http://localhost:3100";
const DEFAULT_BASE = process.cwd(); // default to current working directory

export interface RunProjectOptions {
  /** Override max quota utilization % for the pre-flight check. */
  maxQuotaPct?: number;
  /**
   * Use an external coordinator at this URL instead of starting one in-process.
   * When omitted, Strategy A: startServer() is called to spin up the broker
   * in-process and the URL is set to http://localhost:<PORT>.
   */
  coordinatorUrl?: string;
}

export async function runProject(
  project: MiniProject,
  mode: "with_coordinator" | "without_coordinator" = "with_coordinator",
  cleanup = false,
  runOpts: RunProjectOptions = {},
): Promise<RunResult> {
  // Strategy A: start in-process coordinator unless caller provided an external URL.
  // mcp-coordinator >=0.13 returns a ServerHandle from startServer({...}); we
  // hold onto it so the finally block can release the HTTP server, MQTT broker,
  // SSE listeners, DB, and quota timer without waiting for process exit.
  // registerSignalHandlers:false because essaim owns SIGTERM/SIGINT itself.
  let coordinatorHandle: ServerHandle | null = null;
  if (mode === "with_coordinator" && !runOpts.coordinatorUrl) {
    const port = parseInt(process.env.PORT || "3100", 10);
    const dataDir = process.env.COORDINATOR_DATA_DIR || "./tmp-essaim/coordinator-data";
    log.info(`Starting in-process coordinator on port ${port} (dataDir: ${dataDir})`);
    coordinatorHandle = await startServer({ port, dataDir, registerSignalHandlers: false });
    runOpts = { ...runOpts, coordinatorUrl: `http://localhost:${coordinatorHandle.port}` };
    log.info(`In-process coordinator ready at ${runOpts.coordinatorUrl}`);
  }

  // Effective coordinator URL for this run: from opts (external or just-started in-process)
  // or fall back to the env/default for backward-compat with without_coordinator mode.
  const effectiveCoordinatorUrl = runOpts.coordinatorUrl ?? COORDINATOR_URL;
  // Skip /api/reset when we just spawned the coordinator in-process: its DB is
  // empty and a curl --max-time 2 that gives up before the server finishes
  // wiping causes a race where the agents pre-registered by the orchestrator
  // get wiped *after* registration → SQLITE_CONSTRAINT_FOREIGNKEY on announce.
  const coordinatorJustSpawned = coordinatorHandle !== null;

  try {
    return await _runProjectBody(project, mode, cleanup, runOpts, effectiveCoordinatorUrl, coordinatorJustSpawned);
  } finally {
    if (coordinatorHandle) {
      try {
        await coordinatorHandle.stop();
        log.info("In-process coordinator stopped");
      } catch (err) {
        log.warn("Failed to stop in-process coordinator cleanly", { err: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}

async function _runProjectBody(
  project: MiniProject,
  mode: "with_coordinator" | "without_coordinator",
  cleanup: boolean,
  runOpts: RunProjectOptions,
  effectiveCoordinatorUrl: string,
  coordinatorJustSpawned: boolean,
): Promise<RunResult> {
  const runDir = path.resolve("runs", `${project.id}-${mode}-${Date.now()}`);
  fs.mkdirSync(runDir, { recursive: true });

  // Mint the run id BEFORE any agent starts, so every thread this swarm opens
  // carries it and the next run doesn't inherit our leftovers (#32). Published
  // to the environment, which in-process loops and `claude -p` children share.
  const runId = ensureRunId(project.id);

  log.info(`=== ${project.name} (${mode}, ${project.agents.length} agents, run=${runId}) ===`);

  // 0. Pre-flight quota check — abort the raid before we commit to worktrees
  // if the Anthropic quota is already above the configured max. Fail-open if
  // the coordinator is unreachable or the platform has no credential reader —
  // we log the reason but proceed, matching the project-wide "guardrail not
  // gate" decision.
  const maxQuotaPct = resolveMaxUtilizationPct(runOpts.maxQuotaPct, process.env.MAX_QUOTA_PCT);
  if (mode === "with_coordinator") {
    const preflight = await preflightQuotaCheck({
      coordinatorUrl: effectiveCoordinatorUrl,
      maxUtilizationPct: maxQuotaPct,
    });
    if (!preflight.canProceed) {
      log.error(`Pre-flight BLOCKED: ${preflight.reason}`);
      throw new Error(`Pre-flight quota check failed: ${preflight.reason}`);
    }
    if (preflight.quota) {
      log.info(`Pre-flight OK: 5h=${preflight.quota.five_hour.utilization.toFixed(1)}% (reset in ${preflight.quota.five_hour.minutesUntilReset}min), 7d=${preflight.quota.seven_day.utilization.toFixed(1)}% (max=${maxQuotaPct}%)`);
    }
  }
  // Agents reuse the same ceiling so their in-raid check matches the pre-flight.
  const agentLoopMaxQuotaPct = mode === "with_coordinator" ? maxQuotaPct : undefined;

  // 1. Reset coordinator state — only when reusing an external coordinator.
  // For in-process spawns the DB is empty; calling reset there races with
  // the orchestrator's own pre-register step (curl --max-time 2 gives up,
  // but the server keeps wiping; pre-registered agents get nuked just
  // before they POST /api/announce → SQLITE_CONSTRAINT_FOREIGNKEY).
  if (!coordinatorJustSpawned) {
    if (await postJson(`${effectiveCoordinatorUrl}/api/reset`, {})) {
      log.info("Coordinator state reset");
    } else {
      log.warn("Could not reset coordinator");
    }
  }

  // 1b. Push run config to dashboard
  await postJson(`${effectiveCoordinatorUrl}/api/run-config`, {
    name: project.name,
    description: project.description,
    phase: project.phase,
    agents: project.agents.map(a => ({ name: a.name, profile: a.profile, role: a.role })),
    workspace: project.workspace,
    stagger: project.stagger,
    timeout_minutes: project.timeout_minutes,
    compare_mode: project.compare_mode,
  });

  // 2. Create workspaces (resetBase FIRST, then setup, then worktrees)
  const basePath = project.workspace.base || DEFAULT_BASE;
  if (project.workspace.type === "worktree") {
    resetBase(basePath);
  }

  // 3. Setup script (AFTER resetBase, BEFORE worktree creation so worktrees inherit the setup)
  if (project.setup) {
    log.info("Running setup script...");
    const scriptPath = path.resolve(__dirname, "..", project.setup);
    execSync(`bash "${scriptPath}"`, { cwd: basePath, stdio: "inherit" });
  }

  // 4. Create worktrees (now includes setup changes like injected bugs)
  const workspace = createWorkspaces(project.workspace, project.agents, runDir);
  log.info(`Workspaces created: ${workspace.paths.size} (${workspace.type})`);

  // 5. Setup profiles + launch agents
  const agentProcesses: AgentProcess[] = [];
  const agentLoopPromises = new Map<string, Promise<AgentLoopResult>>();
  const sequentialResults = new Map<string, { stdout: string; stderr: string; code: number }>();
  const start = Date.now();

  // During-run script (background)
  let duringRunProcess: ChildProcess | null = null;
  if (project.during_run) {
    const { spawn } = await import("child_process");
    const duringScript = path.resolve(__dirname, "..", project.during_run);
    duringRunProcess = spawn("bash", [duringScript], { cwd: runDir, stdio: "ignore" });
  }

  // Timeout — works for both legacy (kill ChildProcess) and agent-loop
  // (abort signal + SIGKILL propagation into claude children via claude-stream).
  // Previously the agent-loop subprocess hierarchy survived "Killing all agents"
  // because the orchestrator never tracked the nested claude children, leading
  // to hour-long zombie turns after rate-limit resumes.
  const timeoutMs = (project.timeout_minutes || 15) * 60 * 1000;
  const deadlineMs = Date.now() + timeoutMs;
  // One shared controller fires the abort signal for every agent-loop on timeout.
  const agentLoopAbort = new AbortController();
  let timeoutReject: (() => void) | null = null;
  const timeoutTimer = setTimeout(() => {
    log.error(`TIMEOUT: ${project.timeout_minutes || 15} minutes exceeded. Killing all agents.`);
    for (const ap of agentProcesses) {
      try { ap.process.kill("SIGKILL"); } catch { /* already gone */ }
    }
    // agent-loop mode: signal propagates through runAgentLoop â†' claude-stream,
    // which SIGKILLs each child and rejects the current send().
    agentLoopAbort.abort();
    if (timeoutReject) timeoutReject();
  }, timeoutMs);

  const isCoordinated = mode === "with_coordinator";
  // Agent-loop is the default for coordinated mode.
  // Set use_legacy_mode: true in the project to fall back to claude -p one-shot.
  const useAgentLoop = isCoordinated && !project.use_legacy_mode;

  // Group agents by launch_delay if any agent uses it, otherwise use stagger
  const hasLaunchDelays = project.agents.some(a => a.launch_delay !== undefined);

  // Pre-register all agents via REST (don't rely on LLMs to register correctly)
  if (isCoordinated) {
    let registered = 0;
    for (const agent of project.agents) {
      // Use the agent's declared modules so consultation.ts can match it as a
      // respondent. With `[]` here, target_modules.some()/agentModules.some()
      // is always false → expected_respondents = [] → propose_resolution can
      // never reach quorum → threads only close via the periodic timeout
      // sweeper, defeating the whole collaboration layer.
      const modules = agent.modules ?? [];
      if (await postJson(`${effectiveCoordinatorUrl}/api/register`, {
        agent_id: agent.id,
        name: agent.name,
        modules,
      })) {
        registered++;
      }
    }
    log.info(`Pre-registered ${registered}/${project.agents.length} agents`);
    if (registered < project.agents.length) {
      log.error(`Pre-registration incomplete (${registered}/${project.agents.length}); /api/announce will fail with FK violations.`);
    }
  }

  function setupAndLaunch(agent: typeof project.agents[0]): ChildProcess | null {
    const wsPath = workspace.paths.get(agent.id) || basePath;
    let mcpConfigPath: string | null = null;

    if (isCoordinated) {
      mcpConfigPath = writeAgentWorkspace(wsPath, agent, effectiveCoordinatorUrl);
    }

    const identityBlock = [
      `## IDENTITÉ (OBLIGATOIRE)`,
      `Tu es "${agent.name}". Ton agent_id est "${agent.id}".`,
      `Tu es DÉJÀ enregistré au coordinator. N'appelle PAS register_agent.`,
      `Pour TOUS tes appels au coordinator (announce_work, post_to_thread, etc.), utilise agent_id="${agent.id}".`,
    ].join("\n");

    const coordinatorPrompt = isCoordinated
      ? `${identityBlock}\nTu es connecté au coordinateur. Appelle announce_work avec agent_id="${agent.id}" avant de travailler.`
      : undefined;

    log.info(`Launching ${agent.name} (${agent.profile})${useAgentLoop ? " [agent-loop]" : ""}...`);

    if (useAgentLoop) {
      // Agent-loop mode: programmatic loop with MQTT push.
      // Pass the shared abort signal + deadline so the agent-loop can terminate
      // itself (and SIGKILL its claude children) when the orchestrator times out.
      const loopPromise = launchAgentLoop(agent, wsPath, effectiveCoordinatorUrl, mcpConfigPath, coordinatorPrompt, {
        deadlineMs,
        abortSignal: agentLoopAbort.signal,
        maxQuotaPct: agentLoopMaxQuotaPct,
      });
      agentLoopPromises.set(agent.id, loopPromise);
      return null; // no ChildProcess to track
    }

    // Legacy mode: claude -p one-shot
    const proc = launchAgent(agent, wsPath, effectiveCoordinatorUrl, mcpConfigPath, coordinatorPrompt);
    agentProcesses.push({ config: agent, process: proc, workspacePath: wsPath });
    return proc;
  }

  if (hasLaunchDelays) {
    // Group-based launching: group agents by launch_delay, launch each group together
    const groups = new Map<number, typeof project.agents>();
    for (const agent of project.agents) {
      const delay = agent.launch_delay ?? 0;
      if (!groups.has(delay)) groups.set(delay, []);
      groups.get(delay)!.push(agent);
    }
    const sortedDelays = [...groups.keys()].sort((a, b) => a - b);
    let elapsed = 0;
    for (const delayTarget of sortedDelays) {
      const wait = delayTarget - elapsed;
      if (wait > 0) {
        log.info(`Waiting ${wait}s before next group...`);
        await new Promise(r => setTimeout(r, wait * 1000));
      }
      elapsed = delayTarget;
      for (const agent of groups.get(delayTarget)!) {
        setupAndLaunch(agent);
      }
    }
  } else {
    // Standard stagger-based launching
    for (let i = 0; i < project.agents.length; i++) {
      const agent = project.agents[i];
      const proc = setupAndLaunch(agent);

      // Stagger
      if (i < project.agents.length - 1) {
        if (project.stagger.mode === "sequential" && proc) {
          log.info(`Waiting for ${agent.name} to finish (sequential)...`);
          const seqResult = await waitForProcess(proc);
          sequentialResults.set(agent.id, seqResult);
        } else if (project.stagger.delay) {
          const [min, max] = project.stagger.delay;
          if (project.stagger.mode === "fixed") {
            const fixedSec = (min + max) / 2;
            log.info(`Waiting ${fixedSec.toFixed(1)}s (fixed) before next agent...`);
            await fixedDelay(min, max);
          } else {
            log.info(`Waiting ${min}-${max}s (random) before next agent...`);
            await randomDelay(min, max);
          }
        }
      }
    }
  }

  // 5. Wait for all agents
  if (project.stagger.mode !== "sequential") {
    log.info("Waiting for all agents to finish...");
  }

  let processResults: Array<{ stdout: string; stderr: string; code: number }>;
  const agentLoopResults = new Map<string, AgentLoopResult>();

  if (useAgentLoop) {
    // Agent-loop mode: await all promises, race against timeout
    const entries = [...agentLoopPromises.entries()];
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutReject = () => reject(new Error("TIMEOUT"));
    });
    const racePromises = entries.map(([, p]) => Promise.race([p, timeoutPromise]));
    const results = await Promise.allSettled(racePromises);
    processResults = results.map((r, i) => {
      if (r.status === "fulfilled") {
        agentLoopResults.set(entries[i][0], r.value);
        return { stdout: r.value.summary, stderr: "", code: r.value.exitReason === "done" ? 0 : 1 };
      }
      return { stdout: "", stderr: (r.reason as Error).message, code: 1 };
    });
  } else {
    // Legacy mode: wait for child processes
    processResults = await Promise.all(
      agentProcesses.map((ap) => {
        const seqResult = sequentialResults.get(ap.config.id);
        if (seqResult) return Promise.resolve(seqResult);
        return waitForProcess(ap.process);
      })
    );
  }

  clearTimeout(timeoutTimer);
  if (duringRunProcess) duringRunProcess.kill();

  const duration = Date.now() - start;
  log.info(`Done in ${(duration / 1000).toFixed(1)}s`);

  // 6. Collect metrics
  const coordinatorMetrics = isCoordinated
    ? await fetchCoordinatorMetrics(effectiveCoordinatorUrl)
    : {
        agents_count: project.agents.length,
        duration_total_ms: duration,
        threads_opened: 0, threads_resolved_consensus: 0,
        threads_auto_resolved: 0, messages_exchanged: 0,
        conflicts_by_layer: {}, introspections_triggered: 0,
        introspections_concerned: 0, avg_resolution_time_ms: 0,
        hot_files: [],
      };
  coordinatorMetrics.agents_count = project.agents.length;
  coordinatorMetrics.duration_total_ms = duration;

  // Agent results
  const agentResults = collectAgentResults(workspace);
  for (let i = 0; i < agentResults.length; i++) {
    agentResults[i].agent_name = project.agents[i].name;
    agentResults[i].exit_code = processResults[i].code;
    agentResults[i].stdout_length = processResults[i].stdout.length;
    // Copy token + cost diagnostics from the agent-loop result when available
    const agentId = project.agents[i].id;
    const loopResult = agentLoopResults.get(agentId);
    if (loopResult) {
      agentResults[i].turns_count = loopResult.turnsCount;
      agentResults[i].total_cost_usd = loopResult.totalCostUsd;
      agentResults[i].tokens = loopResult.tokens;
      agentResults[i].cost_by_phase = loopResult.costByPhase;
      agentResults[i].cost_by_model = loopResult.costByModel;
    }
  }

  // 7. Cleanup or keep worktrees
  if (cleanup) {
    cleanupWorkspaces(workspace);
  } else if (workspace.type === "worktree") {
    log.info("Worktrees preserved (use --cleanup to auto-remove)");
    for (const [agentId, wsPath] of workspace.paths) {
      const branchName = `mini-project-${agentId}`;
      log.info(`  ${agentId}: ${wsPath}  (branch: ${branchName})`);
    }
  }

  // 8. Teardown
  if (project.teardown) {
    const teardownScript = path.resolve(__dirname, "..", project.teardown);
    execSync(`bash "${teardownScript}"`, { cwd: runDir, stdio: "inherit" });
  }

  const worktrees = workspace.type === "worktree"
    ? [...workspace.paths.entries()].map(([agentId, wsPath]) => ({
        agent_id: agentId,
        path: wsPath,
        branch: `mini-project-${agentId}`,
      }))
    : undefined;

  return {
    project_id: project.id,
    project_name: project.name,
    mode,
    duration_ms: duration,
    coordinator_metrics: coordinatorMetrics,
    agent_results: agentResults,
    custom_metrics: {},
    worktrees,
  };
}

export interface SetupOptions {
  url: string;
  name: string;
  modules: string;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Write BCE-assembled hooks, envVars and settings.json into a .claude/ directory.
 * Shared between setupProject (interactive dev init) and writeAgentWorkspace
 * (per-agent orchestrated runs).
 */
export interface WriteClaudeHooksDirResult {
  settingsPath: string;
  envPath: string;
  writtenFiles: string[];
}

export function writeClaudeHooksDir(params: {
  claudeDir: string;
  hooks: Record<string, string>;
  envVars: Record<string, string>;
  existingSettings?: Record<string, unknown>;
}): WriteClaudeHooksDirResult {
  const { claudeDir, hooks, envVars, existingSettings = {} } = params;
  const hooksDir = path.join(claudeDir, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });

  const writtenFiles: string[] = [];
  const writtenHookFiles: Record<string, string> = {};
  for (const [lifecycle, script] of Object.entries(hooks)) {
    // Un behavior d'un catalogue EXTERNE peut déclarer un hook `$BCE_SCRIPTS_DIR/x.sh`.
    // Résoudre systématiquement vers le scripts/ bundlé pointerait sur un fichier
    // absent — et Claude Code n'échoue PAS fort sur un hook manquant. On prend donc
    // le premier dossier scripts/ qui contient réellement le script, en partant de
    // la racine la plus locale.
    const scriptDirs = getScriptsDirs();
    const scriptsDir = [...scriptDirs].reverse().find((d) => {
      const m = script.match(/\$BCE_SCRIPTS_DIR\/([\w.-]+)/);
      return m ? fs.existsSync(path.join(d, m[1])) : false;
    }) ?? scriptDirs[0] ?? "";
    const resolvedScript = script.replace(/\$BCE_SCRIPTS_DIR/g, scriptsDir);
    const filename = `${lifecycle}.sh`;
    const hookPath = path.join(hooksDir, filename);
    fs.writeFileSync(hookPath, resolvedScript, { mode: 0o755 });
    writtenHookFiles[lifecycle] = hookPath;
    writtenFiles.push(hookPath);
  }

  const envContent = Object.entries(envVars)
    .map(([k, v]) => `export ${k}=${shellSingleQuote(v)}`)
    .join("\n") + "\n";
  const envPath = path.join(claudeDir, ".coordinator-env");
  fs.writeFileSync(envPath, envContent);
  writtenFiles.push(envPath);

  const settings: Record<string, unknown> = { ...existingSettings };
  const hooksConfig: Record<string, unknown[]> = {};
  for (const [lifecycle, hookPath] of Object.entries(writtenHookFiles)) {
    const eventName = CLAUDE_HOOK_EVENT_MAP[lifecycle];
    if (!eventName) continue;
    // Single-quote both the outer `bash -c` argument AND the inner path args,
    // so $, ", `, \ in paths (including envPath/hookPath) stay literal.
    const innerScript = `source ${shellSingleQuote(envPath)} && bash ${shellSingleQuote(hookPath)}`;
    const command = `bash -c ${shellSingleQuote(innerScript)}`;
    const hookEntry: Record<string, unknown> = {
      hooks: [{ type: "command", command }],
    };
    if (eventName === "PostToolUse" || eventName === "PreToolUse") {
      hookEntry.matcher = POST_TOOL_USE_MATCHER;
    }
    hooksConfig[eventName] = [hookEntry];
  }
  settings.hooks = hooksConfig;
  const settingsPath = path.join(claudeDir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  writtenFiles.push(settingsPath);

  return { settingsPath, envPath, writtenFiles };
}

export function setupProject(projectPath: string, options: SetupOptions): void {
  log.info(`Setting up MCP Coordinator in ${projectPath}`);

  const coordinatorUrl = options.url;
  const agentName = options.name;
  const agentModules = options.modules;

  const absProjectPath = resolve(projectPath);
  const projectBasename = path.basename(absProjectPath);
  const agentId = `${agentName}@${projectBasename}`;

  const claudeDir = path.join(absProjectPath, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });

  // 1. Run BCE pipeline with the `dev` preset to get hooks + envVars
  const modulesList = agentModules
    ? agentModules.split(",").map((m) => m.trim()).filter(Boolean)
    : [];
  const launchParams: Record<string, Record<string, unknown>> = {
    "project-context": {
      language: "",
      test_command: "",
      modules: modulesList,
    },
  };
  const bceAgent = {
    name: agentId,
    displayName: agentName,
    preset: "dev",
    add: [] as string[],
    remove: [] as string[],
    params: {} as Record<string, Record<string, unknown>>,
  };
  const result = runPipeline(bceAgent, getCatalogRoots(), launchParams);

  // 2. Merge BCE envVars with init-time values
  const envVars: Record<string, string> = {
    ...result.output.envVars,
    COORDINATOR_URL: coordinatorUrl,
    COORDINATOR_AGENT_MODULES: agentModules,
  };

  // 3. Preserve existing settings.json (e.g. editor preferences) while replacing hooks
  const settingsPath = path.join(claudeDir, "settings.json");
  let existingSettings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try { existingSettings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); } catch {}
  }

  // 4. Write hooks, .coordinator-env and settings.json via the shared helper
  const { writtenFiles } = writeClaudeHooksDir({
    claudeDir,
    hooks: result.output.hooks,
    envVars,
    existingSettings,
  });
  for (const filePath of writtenFiles) {
    log.info(`Wrote ${path.relative(absProjectPath, filePath)}`);
  }

  // 5. Create .mcp.json if it doesn't exist
  const mcpConfigPath = path.join(absProjectPath, ".mcp.json");
  if (!fs.existsSync(mcpConfigPath)) {
    const coordinatorServer: Record<string, unknown> = {
      type: "http",
      url: `${coordinatorUrl}/mcp`,
    };
    const auth = mcpAuthHeaders();
    if (Object.keys(auth).length > 0) coordinatorServer.headers = auth;
    const mcpConfig = { mcpServers: { coordinator: coordinatorServer } };
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + "\n");
    log.info("Wrote .mcp.json");
  } else {
    log.info(".mcp.json already exists -- skipped");
  }

  log.info(`Setup complete! Preset: dev (${result.behaviors.map((b) => b.name).join(", ")}), Agent: ${agentId}, Coordinator: ${coordinatorUrl}, Modules: ${agentModules || "(auto-detect)"}`);
}

/**
 * Materialize a per-agent workspace for an orchestrated run: writes .mcp.json
 * and invokes writeClaudeHooksDir with the BCE-assembled hooks/envVars of the
 * agent. Returns the .mcp.json path so launchAgent can pass it via --mcp-config.
 */
export function writeAgentWorkspace(
  workspacePath: string,
  agent: AgentConfig,
  coordinatorUrl: string,
): string {
  const coordinatorServer: Record<string, unknown> = {
    type: "http",
    url: `${coordinatorUrl}/mcp`,
  };
  const auth = mcpAuthHeaders();
  if (Object.keys(auth).length > 0) coordinatorServer.headers = auth;
  const mcpConfig = { mcpServers: { coordinator: coordinatorServer } };
  const mcpPath = path.join(workspacePath, ".mcp.json");
  fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + "\n");

  const envVars: Record<string, string> = {
    ...agent.envVars,
    COORDINATOR_URL: coordinatorUrl,
  };
  const claudeDir = path.join(workspacePath, ".claude");
  writeClaudeHooksDir({
    claudeDir,
    hooks: agent.hooks,
    envVars,
  });

  return mcpPath;
}



