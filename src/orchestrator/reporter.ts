import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import type { RunResult, AgentResult, WorkspaceResult } from "./types.js";

/**
 * Changed lines (+/-) in a unified diff, ignoring headers and context.
 *
 * `"".split("\n")` is `[""]`, i.e. length 1 — which is why an empty diff used to
 * report "1 line changed" for every single agent (#29).
 */
export function countDiffLines(diff: string): number {
  if (!diff.trim()) return 0;
  let changed = 0;
  for (const line of diff.split("\n")) {
    const added = line.startsWith("+") && !line.startsWith("+++");
    const removed = line.startsWith("-") && !line.startsWith("---");
    if (added || removed) changed++;
  }
  return changed;
}

/**
 * Under a subscription (OAuth) the SDK reports no per-call price. Zero cost
 * alongside real token usage means "unknown", not "free" — printing $0.0000
 * there is a lie the report tells about itself (#29).
 */
export function formatCost(costUsd: number | undefined, hasTokens: boolean): string {
  if (hasTokens && (costUsd ?? 0) === 0) return "N/A";
  return `$${(costUsd ?? 0).toFixed(4)}`;
}

export function collectAgentResults(workspace: WorkspaceResult): AgentResult[] {
  const results: AgentResult[] = [];

  for (const [agentId, wsPath] of workspace.paths) {
    // Agents commit their work, so `git diff HEAD` (uncommitted only) is empty by
    // construction. Diff against the commit the worktree branched off instead —
    // that covers committed AND uncommitted changes (#29).
    const diffMeasured = workspace.type === "worktree";
    const diff = !diffMeasured
      ? ""
      : workspace.baseSha
        ? safeExec(`git diff ${workspace.baseSha}`, wsPath)
        : safeExec("git diff HEAD", wsPath);

    const compilationOk = workspace.type !== "none"
      ? tscCompilationStatus(wsPath)
      : undefined;
    // tsc n'a pas pu tourner (npx/tsc introuvable) sur un workspace où on
    // l'attendait : ce n'est PAS « OK », c'est « non vérifié » — on le dit, sinon
    // un rapport vert masquerait qu'aucune compilation n'a eu lieu (#152).
    if (workspace.type !== "none" && compilationOk === undefined) {
      console.warn(`reporter: tsc injoignable dans ${wsPath} — compilation NON vérifiée (colonne N/A, pas OK)`);
    }

    results.push({
      agent_id: agentId,
      agent_name: agentId,
      exit_code: 0,
      diff,
      diff_measured: diffMeasured,
      compilation_ok: compilationOk,
      stdout_length: 0,
    });
  }

  return results;
}

/**
 * A report basename that is free for every extension it will be written under.
 *
 * `Date.now()` alone is not unique: two reports produced in the same millisecond
 * (pipeline steps, notably) silently overwrote each other — the second run's
 * report simply replaced the first, and nobody was told.
 */
export function uniqueReportBase(dir: string, prefix: string, extensions: string[]): string {
  let base = prefix;
  for (let n = 2; extensions.some((ext) => fs.existsSync(path.join(dir, base + ext))); n++) {
    base = `${prefix}-${n}`;
  }
  return base;
}

export function writeReport(results: RunResult[], outputDir: string): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const base = uniqueReportBase(outputDir, `report-${Date.now()}`, [".json", ".md"]);

  const jsonPath = path.join(outputDir, `${base}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

  const mdPath = path.join(outputDir, `${base}.md`);
  let md = `# Mini-projet Report\n\n*${new Date().toISOString()}*\n\n`;

  for (const r of results) {
    md += `## ${r.project_name} (${r.mode})\n\n`;
    md += `| Métrique | Valeur |\n|----------|--------|\n`;
    md += `| Durée | ${(r.duration_ms / 1000).toFixed(1)}s |\n`;
    md += `| Agents | ${r.coordinator_metrics.agents_count} |\n`;
    const cm = r.coordinator_metrics;
    const finalState = cm.threads_final;
    // The table stays entirely SSE-derived — one source, one window, rows
    // that add up against each other. finalState (mcp-coordinator ≥2.3.0,
    // scoped by run_id server-side) answers a DIFFERENT question than the
    // SSE replay (windowed by event id, NOT scoped by run — see the
    // docstring on fetchCoordinatorMetrics) and the two must never share a
    // row: mixing "Threads ouverts" from finalState with "Consensus" from
    // SSE let a coordinator shared with a concurrent run print a total
    // smaller than the consensus count it's supposed to contain — the same
    // class of silent contradiction already ruled out for "Sans consensus".
    // finalState surfaces only in the footnote below, clearly labeled as a
    // separate, authoritative source — that's what makes 'poisoned' and
    // 'cancelled' visible, and it needs nothing from the table to do it.
    md += `| Threads ouverts | ${cm.threads_opened} |\n`;
    md += `| Consensus (approuvé par tous) | ${cm.threads_resolved_consensus} |\n`;
    md += `| Auto-résolus (aucun agent concerné) | ${cm.threads_auto_resolved} |\n`;
    // « Sans consensus » est une ESTIMATION SSE (fenêtrée). Quand l'état final
    // autoritaire (finalState) est là, il donne le vrai décompte empoisonnés/
    // annulés/résolus dans le footnote : afficher EN PLUS l'estimation SSE créait
    // une paire de nombres qui se contredisent dans le même rapport (« Sans
    // consensus : 3 » vs « empoisonnés : 0, annulés : 0 »). On ne la montre donc
    // que faute d'autorité — sinon le footnote parle seul (#154).
    if (!finalState) {
      md += `| Sans consensus (estimation SSE : timeout/empoisonnés/abandonnés) | ${cm.threads_without_consensus} |\n`;
    }
    md += `| Messages | ${cm.messages_exchanged} |\n`;
    md += `| Introspections | ${cm.introspections_triggered} |\n`;
    md += `| Hot files | ${cm.hot_files.length} |\n`;

    if (finalState) {
      md += `\n> État final (coordinator, faisant autorité) : ${finalState.total} thread(s) au total — ${finalState.open} ouvert(s), ${finalState.resolving} en résolution, ${finalState.poisoned} empoisonné(s), ${finalState.cancelled} annulé(s), ${finalState.resolved} résolu(s).\n`;
    }

    if (Object.keys(r.coordinator_metrics.conflicts_by_layer).length > 0) {
      md += `\n### Conflits par layer\n\n`;
      for (const [layer, count] of Object.entries(r.coordinator_metrics.conflicts_by_layer)) {
        md += `- ${layer}: ${count}\n`;
      }
    }

    if (Object.keys(r.custom_metrics).length > 0) {
      md += `\n### Métriques spécifiques\n\n`;
      for (const [key, value] of Object.entries(r.custom_metrics)) {
        md += `- ${key}: ${JSON.stringify(value)}\n`;
      }
    }

    md += `\n### Agents\n\n`;
    md += `| Agent | Exit | Raison | Compilation | Diff (lignes) |\n|-------|------|--------|-------------|---------------|\n`;
    for (const a of r.agent_results) {
      const diffCell = a.diff_measured === false ? "N/A" : countDiffLines(a.diff);
      // exit_reason est absent quand l'agent n'a JAMAIS démarré : orchestrator.ts:574-575
      // pose exit_code 1 sans AgentLoopResult. "N/A" est donc une information
      // (« jamais lancé »), pas un trou de données.
      md += `| ${a.agent_name} | ${a.exit_code} | ${a.exit_reason ?? "N/A"} | ${a.compilation_ok === undefined ? "N/A" : a.compilation_ok ? "OK" : "FAIL"} | ${diffCell} |\n`;
    }

    // Token + cost breakdown (populated from agent-loop runs)
    const agentsWithTokens = r.agent_results.filter((a) => a.tokens);
    if (agentsWithTokens.length > 0) {
      md += `\n### Coût par agent\n\n`;
      md += `| Agent | Turns | Cost | Input | Output | Cache read | Cache write | Cache hit |\n`;
      md += `|-------|-------|------|-------|--------|------------|-------------|-----------|\n`;
      let sumCost = 0, sumIn = 0, sumOut = 0, sumCacheR = 0, sumCacheW = 0;
      for (const a of agentsWithTokens) {
        const t = a.tokens!;
        const totalIn = t.input + t.cacheRead + t.cacheCreation;
        const hit = totalIn > 0 ? Math.round((t.cacheRead / totalIn) * 100) : 0;
        md += `| ${a.agent_name} | ${a.turns_count ?? "-"} | ${formatCost(a.total_cost_usd, totalIn + t.output > 0)} | ${fmtTokens(t.input)} | ${fmtTokens(t.output)} | ${fmtTokens(t.cacheRead)} | ${fmtTokens(t.cacheCreation)} | ${hit}% |\n`;
        sumCost += a.total_cost_usd ?? 0;
        sumIn += t.input;
        sumOut += t.output;
        sumCacheR += t.cacheRead;
        sumCacheW += t.cacheCreation;
      }
      const totalInAll = sumIn + sumCacheR + sumCacheW;
      const totalHit = totalInAll > 0 ? Math.round((sumCacheR / totalInAll) * 100) : 0;
      const anyTokens = totalInAll + sumOut > 0;
      md += `| **Total** | - | **${formatCost(sumCost, anyTokens)}** | ${fmtTokens(sumIn)} | ${fmtTokens(sumOut)} | ${fmtTokens(sumCacheR)} | ${fmtTokens(sumCacheW)} | **${totalHit}%** |\n`;

      if (anyTokens && sumCost === 0) {
        md += `\n> Coût **N/A** : sous abonnement (OAuth), l'API ne renvoie aucun prix par appel.\n> Les compteurs de tokens ci-dessus restent, eux, fiables.\n`;
      }

      // Per-phase breakdown across all agents
      const phaseTotals: Record<string, number> = {};
      const modelTotals: Record<string, number> = {};
      for (const a of agentsWithTokens) {
        for (const [p, c] of Object.entries(a.cost_by_phase ?? {})) {
          phaseTotals[p] = (phaseTotals[p] || 0) + c;
        }
        for (const [m, c] of Object.entries(a.cost_by_model ?? {})) {
          modelTotals[m] = (modelTotals[m] || 0) + c;
        }
      }
      // Skip the cost breakdowns entirely when no price is available (OAuth):
      // a table of $0.0000 / 0.0% says nothing and reads as "these phases were free".
      if (sumCost > 0 && Object.keys(phaseTotals).length > 0) {
        md += `\n**Coût par phase** (agents agrégés):\n\n`;
        md += `| Phase | Cost | % |\n|-------|------|---|\n`;
        const sortedPhases = Object.entries(phaseTotals).sort(([, a], [, b]) => b - a);
        for (const [phase, cost] of sortedPhases) {
          const pct = sumCost > 0 ? ((cost / sumCost) * 100).toFixed(1) : "0.0";
          md += `| ${phase} | $${cost.toFixed(4)} | ${pct}% |\n`;
        }
      }
      if (sumCost > 0 && Object.keys(modelTotals).length > 0) {
        md += `\n**Coût par modèle** (agents agrégés):\n\n`;
        md += `| Modèle | Cost | % |\n|--------|------|---|\n`;
        const sortedModels = Object.entries(modelTotals).sort(([, a], [, b]) => b - a);
        for (const [model, cost] of sortedModels) {
          const pct = sumCost > 0 ? ((cost / sumCost) * 100).toFixed(1) : "0.0";
          md += `| ${model} | $${cost.toFixed(4)} | ${pct}% |\n`;
        }
      }
    }
    if (r.worktrees && r.worktrees.length > 0) {
      md += `\n### Worktrees\n\n`;
      md += `| Agent | Branch | Path |\n|-------|--------|------|\n`;
      for (const wt of r.worktrees) {
        md += `| ${wt.agent_id} | \`${wt.branch}\` | \`${wt.path}\` |\n`;
      }
    }

    if (r.security) {
      const s = r.security;
      md += `\n### Moteur de sécurité\n\n`;
      md += `| Moteur | Licence | Statut | Durée | Exit | Version | Image |\n`;
      md += `|--------|---------|--------|-------|------|---------|-------|\n`;
      md += `| ${s.engine} | ${s.license} | ${s.status}${s.degraded ? " (degraded)" : ""} | ${Math.round(s.durationMs / 1000)}s | ${s.exitCode ?? "N/A"} | ${s.engineVersion ?? "N/A"} | \`${s.imageDigest ?? "N/A"}\` |\n`;
      md += `\n**Findings par sévérité:** `;
      md += `critical ${s.findingsBySeverity.critical}, high ${s.findingsBySeverity.high}, medium ${s.findingsBySeverity.medium}, low ${s.findingsBySeverity.low}, info ${s.findingsBySeverity.info}\n`;
      md += `\n**Remédiation:** ${s.ingested} ingérés · ${s.verified} verified · ${s.reopened} reopened · ${s.falsePositives} faux-positifs · ${s.suppressed} baselinés · ${s.outOfScopeDropped} hors-scope écartés`;
      // Nommer les findings perdus au semis (thème #137) : sinon `degraded` est
      // vrai sans dire pourquoi, et N vulnérabilités non consignées restent muettes.
      md += s.ingestFailed > 0 ? ` · **${s.ingestFailed} ÉCHECS de semis (findings non consignés)**\n` : `\n`;
      if (s.reopened > 0) {
        md += `\n> ⚠️ ${s.reopened} finding(s) re-détecté(s) à la vérification — le run n'est PAS "clean" (révision humaine requise).\n`;
      }
    }

    md += "\n---\n\n";
  }

  fs.writeFileSync(mdPath, md);
  console.log(`Report: ${mdPath}`);
  return mdPath;
}

function fmtTokens(n: number): string {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function safeExec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe" });
  } catch (e) {
    return (e as { stdout?: string }).stdout || "";
  }
}

/** Lance `npx tsc --noEmit` et rend {code, output}. code=0 en succès ; sur échec,
 *  le code de sortie du process (null s'il n'a pas pu spawn). */
function runTsc(cwd: string): { code: number | null; output: string } {
  try {
    execSync("npx tsc --noEmit", { cwd, encoding: "utf-8", stdio: "pipe" });
    return { code: 0, output: "" };
  } catch (e) {
    const err = e as { status?: number | null; stdout?: string; stderr?: string };
    return { code: err.status ?? null, output: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

/**
 * État de compilation TRI-ÉTAT (#152), fondé sur le CODE DE SORTIE de tsc — non
 * sur `includes("error")`, qui rendait un FAUX OK quand tsc était injoignable
 * (« command not found » ne contient pas « error »).
 *   - `true`      : tsc a tourné et rendu 0 (OK).
 *   - `false`     : tsc a tourné et rapporté des erreurs de type (FAIL) —
 *                   reconnu à sa signature `error TSxxxx`, ce qui le distingue
 *                   d'un échec de LANCEMENT.
 *   - `undefined` : tsc n'a PAS pu tourner (npx/tsc introuvable) — « non vérifié »,
 *                   JAMAIS confondu avec OK (acceptance #152 : injoignable ⇒ !== true).
 * `run` est injecté pour le test.
 */
export function tscCompilationStatus(
  cwd: string,
  run: (cwd: string) => { code: number | null; output: string } = runTsc,
): boolean | undefined {
  const { code, output } = run(cwd);
  if (code === 0) return true;                 // OK
  if (/error TS\d+/.test(output)) return false; // tsc a tourné et échoué -> FAIL
  return undefined;                             // tsc n'a pas pu tourner -> non vérifié
}


