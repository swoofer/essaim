# Security Subsystem — Plan 3: Coordinator Integration, Verification & Orchestrator Wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the deterministic engine layer into an essaim run: resolve secrets into a container env-file, normalize findings into coordinator threads via the **existing** `/api/announce`, re-scan fixed worktrees to verify closure, add the optional `MiniProject.security` / `RunResult.security` fields, insert the two guarded orchestrator steps (pre-scan + verify), harden child-process env with an **allowlist**, and render the security report section.

**Architecture:** New `src/security/{secrets,ingest,verify,pre-phase}.ts` plus a small `src/agent-loop/child-env.ts`. The orchestrator gains two guarded calls (`runSecurityPrePhase` before `createWorkspaces`, `runSecurityVerifyPhase` after the swarm) that delegate to well-tested functions; everything stays dead code unless `project.security` is set. Coordinator interaction reuses the exact `/api/announce` + `/api/register` paths essaim already uses (via `authHeaders()` + global `fetch`). Verification is **report-only** in v1 (records verified/reopened; does not mutate the coordinator — the vendored coordinator has no reopen endpoint).

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Node ≥ 20, vitest with `vi.stubGlobal("fetch", …)` and injectable registry/diff functions.

## Global Constraints

_(From the spec + Plans 1–2, still in force.)_

- Reuse coordinator machinery **verbatim**: `POST /api/announce` body keys `{ agent_id, subject, plan, target_modules, target_files, keep_open, ... }`; `POST /api/register` `{ agent_id, name, modules }`. **No new coordinator tool, no schema change in v1.** (The coordinator ignores `run_id` entirely — confirmed — hence reset-before-seed.)
- **Auth:** attach `authHeaders()` (`Authorization: Bearer $COORDINATOR_TOKEN`) to every coordinator request, matching `work-stealing.ts`.
- **Single redaction/sanitization chokepoint:** `redact()` + `sanitizeUntrusted()` run **inside** `findingToAnnounce`/`renderPlan`. Raw evidence/PoC never reaches a thread — only a redacted, fenced summary + the fingerprint.
- **Env allowlist (load-bearing):** the spawned `claude` child's env is built from an **explicit allowlist**, not `...process.env`. It MUST keep `PATH`, `HOME`, `ANTHROPIC_*`, `COORDINATOR_*`, `ESSAIM_*`, `CLAUDE_*`, and OS-essential Windows vars, and MUST drop engine secrets (`LLM_API_KEY`, `STRIX_LLM`, `HEXSTRIKE_TOKEN`, any other `*_API_KEY`/`*_TOKEN`).
- **Verification is report-only in v1:** re-scan a fixed worktree; a re-detected fingerprint → `reopened` (blocks the "clean" label, does **not** fail the run — decision #5). No coordinator mutation (no reopen endpoint on the vendored coordinator; real reopen is a v2 coordinator change).
- **Zero regressions:** all new orchestrator behavior is guarded by `if (project.security && isCoordinated)`; existing fixtures see byte-identical behavior.
- **Secrets never in `process.env`:** engine secrets are read lazily into a temp `--env-file` (0600) and unlinked in `finally`.

**Test commands:** single file `npx vitest run tests/unit/<file>.test.ts`; build `npm run build`; full suite `npm test`.

---

### Task 1: Engine secrets → temp env-file

**Files:**
- Create: `src/security/secrets.ts`
- Test: `tests/unit/security-secrets.test.ts`

**Interfaces:**
- Consumes: `node:fs`, `node:os`, `node:path`, `node:crypto`.
- Produces:
  - `resolveEngineSecrets(secretsFile?: string): Record<string, string>` (parses `KEY=VALUE` lines; returns `{}` when no file).
  - `writeEnvFile(secrets: Record<string, string>): string | undefined` (writes a 0600 temp file, returns its path; `undefined` when `secrets` is empty).
  - `removeEnvFile(path: string | undefined): void`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/security-secrets.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { resolveEngineSecrets, writeEnvFile, removeEnvFile } from "../../src/security/secrets.js";

const created: (string | undefined)[] = [];
afterEach(() => {
  for (const p of created) removeEnvFile(p);
  created.length = 0;
});

describe("resolveEngineSecrets", () => {
  it("returns {} when no file is given", () => {
    expect(resolveEngineSecrets(undefined)).toEqual({});
  });

  it("parses KEY=VALUE lines, ignoring comments and blanks", () => {
    const dir = mkdtempSync(join(tmpdir(), "sec-"));
    const f = join(dir, "secrets.env");
    writeFileSync(f, "# comment\nLLM_API_KEY=sk-abc123\n\nSTRIX_LLM=anthropic/claude\n");
    expect(resolveEngineSecrets(f)).toEqual({ LLM_API_KEY: "sk-abc123", STRIX_LLM: "anthropic/claude" });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("writeEnvFile", () => {
  it("returns undefined for empty secrets", () => {
    expect(writeEnvFile({})).toBeUndefined();
  });

  it("writes KEY=VALUE lines to a temp file (0600 on POSIX)", () => {
    const p = writeEnvFile({ LLM_API_KEY: "sk-abc", STRIX_LLM: "anthropic/claude" });
    created.push(p);
    expect(p).toBeTruthy();
    expect(existsSync(p!)).toBe(true);
    const body = readFileSync(p!, "utf8");
    expect(body).toContain("LLM_API_KEY=sk-abc");
    expect(body).toContain("STRIX_LLM=anthropic/claude");
    if (platform() !== "win32") {
      expect(statSync(p!).mode & 0o777).toBe(0o600);
    }
  });
});

describe("removeEnvFile", () => {
  it("is a no-op on undefined and removes an existing file", () => {
    expect(() => removeEnvFile(undefined)).not.toThrow();
    const p = writeEnvFile({ K: "v" })!;
    removeEnvFile(p);
    expect(existsSync(p)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/security-secrets.test.ts`
Expected: FAIL — cannot resolve `../../src/security/secrets.js`.

- [ ] **Step 3: Write the implementation (`src/security/secrets.ts`)**

```ts
// src/security/secrets.ts — read engine secrets lazily; hand them to the engine container via a
// temp 0600 env-file. NEVER placed in process.env, argv, prompts, threads, or logs.
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Parse a dotenv-style file into a map. Returns {} when no path is given or the file is absent. */
export function resolveEngineSecrets(secretsFile?: string): Record<string, string> {
  if (!secretsFile || !existsSync(secretsFile)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(secretsFile, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/** Write secrets to a 0600 temp env-file for `docker run --env-file`. Returns undefined if empty. */
export function writeEnvFile(secrets: Record<string, string>): string | undefined {
  const keys = Object.keys(secrets);
  if (keys.length === 0) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "essaim-sec-"));
  const path = join(dir, `${randomUUID()}.env`);
  const body = keys.map((k) => `${k}=${secrets[k]}`).join("\n") + "\n";
  writeFileSync(path, body, { mode: 0o600 });
  return path;
}

export function removeEnvFile(path: string | undefined): void {
  if (path && existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      /* best-effort */
    }
  }
}
```

> **Windows note (decision #6 — primary target):** `writeFileSync(..., { mode: 0o600 })` is a **no-op on Windows** (NTFS ACLs ignore POSIX mode). The env-file lives under the per-user `os.tmpdir()` (already user-scoped) and is unlinked in `finally`, so the exposure window is short. This is documented as **POSIX-enforced / Windows-best-effort**; the `platform() !== "win32"` guard in the test above reflects it. A hardened Windows ACL (`icacls <file> /inheritance:r /grant:r "%USERNAME%:F"`) is a v2 follow-up, not a v1 blocker.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/security-secrets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/security/secrets.ts tests/unit/security-secrets.test.ts
git commit -m "feat(security): engine secrets → temp 0600 env-file (never in process.env)"
```

---

### Task 2: Type wiring (`SecurityRunConfig`, `SecurityRunLedger`, optional MiniProject/RunResult fields)

**Files:**
- Modify: `src/security/types.ts` (append new types)
- Modify: `src/orchestrator/types.ts:28-52` (add `security?` to `MiniProject`) and `:81-90` (add `security?` to `RunResult`)
- Test: verified by `npm run build` (type-check) — no runtime test needed for pure type additions.

**Interfaces:**
- Produces (in `src/security/types.ts`):
  - `MiniProjectSecurity` = `{ config: SecurityConfig; secretsFile?: string; envAffirmed?: boolean }`
  - `SecurityRunLedger` = the shape rendered by the reporter (see below).

- [ ] **Step 1: Append to `src/security/types.ts`**

```ts
// ---- Run-time integration types (Plan 3) ----

/** Attached to MiniProject.security to drive the orchestrator's security steps. */
export interface MiniProjectSecurity {
  config: SecurityConfig;
  secretsFile?: string; // path to a 0600 dotenv file with LLM_API_KEY / STRIX_LLM
  envAffirmed?: boolean; // ESSAIM_SECURITY_AFFIRMED=1 (CI static scans)
}

/** Summary of a security run, attached to RunResult.security and rendered by the reporter. */
export interface SecurityRunLedger {
  engine: EngineId;
  status: EngineStatus;
  findingsBySeverity: Record<Severity, number>;
  ingested: number;
  verified: number;
  reopened: number;
  falsePositives: number;
  degraded: boolean;
  durationMs: number;
  exitCode?: number;
  engineVersion?: string;
  license: string;
  imageDigest?: string;
  outOfScopeDropped: number;
  suppressed: number;
}
```

- [ ] **Step 2: Add `security?` to `MiniProject` (`src/orchestrator/types.ts`)**

At the top of `src/orchestrator/types.ts`, add the import:

```ts
import type { MiniProjectSecurity, SecurityRunLedger } from "../security/types.js";
```

Inside `interface MiniProject { … }` (after `compare_mode?: boolean;`), add:

```ts
  security?: MiniProjectSecurity; // set by `essaim security`; gates the orchestrator security steps
```

- [ ] **Step 3: Add `security?` to `RunResult` (`src/orchestrator/types.ts`)**

Inside `interface RunResult { … }` (after `worktrees?…;`), add:

```ts
  security?: SecurityRunLedger; // present only for security runs; rendered by the reporter
```

- [ ] **Step 4: Type-check**

Run: `npm run build`
Expected: PASS (tsc emits with no errors). The new fields are optional, so no existing construction site breaks.

- [ ] **Step 5: Commit**

```bash
git add src/security/types.ts src/orchestrator/types.ts
git commit -m "feat(security): optional MiniProject.security + RunResult.security wiring types"
```

---

### Task 3: Coordinator ingest (`findingToAnnounce`, `ingestFindings`, synthetic author)

**Files:**
- Create: `src/security/ingest.ts`
- Test: `tests/unit/security-ingest.test.ts`

**Interfaces:**
- Consumes: `Finding`, `EngineId` (from `types.js`); `toSubjectSeverity` (from `finding.js`); `redact`, `sanitizeUntrusted`, `renderUntrustedBlock` (from `redact.js`); `authHeaders` (from `../coordinator-auth.js`); global `fetch`.
- Produces:
  - `AnnouncePayload` = `{ agent_id: string; subject: string; plan: string; target_files: string[]; target_modules: string[]; keep_open: true }`
  - `IngestResult` = `{ posted: { threadId: string; finding: Finding }[]; failed: number }`
  - `renderPlan(f: Finding): string`
  - `findingToAnnounce(f: Finding, agentId: string): AnnouncePayload`
  - `syntheticAuthorId(projectPath: string): string`
  - `registerSyntheticAuthor(coordinatorUrl: string, agentId: string): Promise<void>`
  - `ingestFindings(coordinatorUrl: string, agentId: string, findings: Finding[]): Promise<IngestResult>`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/security-ingest.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { findingToAnnounce, ingestFindings, registerSyntheticAuthor, syntheticAuthorId } from "../../src/security/ingest.js";
import type { Finding } from "../../src/security/types.js";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "id-1", engine: "strix", ruleId: "sqli-concat", title: "SQL injection", description: "user input in query",
    severity: "high", category: "sqli", cwe: "CWE-89", file: "src/db.ts", line: 42,
    evidence: "q = '...' + id // sk-abcDEF0123456789ghijklmnop", remediation: "use params",
    fingerprint: "abc123def456", status: "new", discoveredAt: "t", raw: null, ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("findingToAnnounce", () => {
  it("builds a coordinator payload with 3-level subject prefix, target_files, keep_open", () => {
    const p = findingToAnnounce(finding(), "security-scanner@repo");
    expect(p.subject.startsWith("critical: ")).toBe(true); // high → critical prefix
    expect(p.subject).toContain("src/db.ts:42");
    expect(p.target_files).toEqual(["src/db.ts"]);
    expect(p.keep_open).toBe(true);
    expect(p.agent_id).toBe("security-scanner@repo");
  });

  it("NEVER leaks a raw secret into the plan (redaction chokepoint)", () => {
    const p = findingToAnnounce(finding(), "a");
    expect(p.plan).not.toContain("sk-abcDEF0123456789ghijklmnop");
    expect(p.plan).toContain("[fingerprint:abc123def456]");
    expect(p.plan).toContain("CWE-89");
  });

  it("caps the subject at 200 chars", () => {
    const p = findingToAnnounce(finding({ title: "x".repeat(500) }), "a");
    expect(p.subject.length).toBeLessThanOrEqual(200);
  });
});

describe("ingestFindings + registerSyntheticAuthor", () => {
  it("registers the author then announces each finding, collecting thread ids", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      if (url.includes("/api/register")) return { ok: true, json: async () => ({}) };
      return { ok: true, json: async () => ({ thread_id: `t-${calls.length}`, status: "open" }) };
    });
    vi.stubGlobal("fetch", mockFetch);

    await registerSyntheticAuthor("http://c", "security-scanner@repo");
    const res = await ingestFindings("http://c", "security-scanner@repo", [finding(), finding({ id: "id-2", fingerprint: "f2" })]);

    expect(calls[0].url).toContain("/api/register");
    expect(calls[1].url).toContain("/api/announce");
    expect(calls[1].body).toMatchObject({ keep_open: true, target_files: ["src/db.ts"] });
    expect(res.posted).toHaveLength(2);
    expect(res.posted[0].threadId).toBe("t-2");
    // no secret anywhere in any request body
    expect(JSON.stringify(calls)).not.toContain("sk-abcDEF0123456789ghijklmnop");
  });

  it("counts failures without throwing", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/announce")) return { ok: false, status: 500 };
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", mockFetch);
    const res = await ingestFindings("http://c", "a", [finding()]);
    expect(res.failed).toBe(1);
    expect(res.posted).toHaveLength(0);
  });
});

describe("syntheticAuthorId", () => {
  it("derives a stable id from the project basename", () => {
    expect(syntheticAuthorId("C:/Users/gagno/projet/essaim-new")).toBe("security-scanner@essaim-new");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/security-ingest.test.ts`
Expected: FAIL — cannot resolve `../../src/security/ingest.js`.

- [ ] **Step 3: Write the implementation (`src/security/ingest.ts`)**

```ts
// src/security/ingest.ts — turn normalized Findings into coordinator threads via the EXISTING
// /api/announce. Redaction + sanitization happen HERE (the single mandatory chokepoint).
import { basename } from "node:path";
import type { Finding } from "./types.js";
import { toSubjectSeverity } from "./finding.js";
import { sanitizeUntrusted, renderUntrustedBlock } from "./redact.js";
import { authHeaders } from "../coordinator-auth.js";
import { createLogger } from "../logger.js";

const log = createLogger("security");

export interface AnnouncePayload {
  agent_id: string;
  subject: string;
  plan: string;
  target_files: string[];
  target_modules: string[];
  keep_open: true;
}

export interface IngestResult {
  posted: { threadId: string; finding: Finding }[];
  failed: number;
}

/** Redacted + sanitized context for the fixer. Raw PoC never included — only a fenced summary + fingerprint. */
export function renderPlan(f: Finding): string {
  const lines = [
    `Severity: ${f.severity}${f.cwe ? ` (${f.cwe})` : ""}`,
    `Category: ${f.category}`,
    f.file ? `Location: ${f.file}${f.line ? `:${f.line}` : ""}` : "",
    "",
    "Description:",
    renderUntrustedBlock(f.description),
    f.remediation ? `\nRemediation hint:\n${renderUntrustedBlock(f.remediation)}` : "",
    f.evidence ? `\nEvidence (redacted):\n${renderUntrustedBlock(f.evidence)}` : "",
    "",
    `[fingerprint:${f.fingerprint}]`,
  ];
  return lines.filter((l) => l !== "").join("\n");
}

export function findingToAnnounce(f: Finding, agentId: string): AnnouncePayload {
  const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
  const subject = `${toSubjectSeverity(f.severity)}: ${sanitizeUntrusted(f.title, 160)}${loc}`.slice(0, 200);
  return {
    agent_id: agentId,
    subject,
    plan: renderPlan(f),
    target_files: f.file ? [f.file] : [],
    target_modules: [],
    keep_open: true,
  };
}

export function syntheticAuthorId(projectPath: string): string {
  return `security-scanner@${basename(projectPath)}`;
}

async function coordPost(url: string, body: unknown): Promise<Record<string, unknown>> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`coordinator ${url} -> ${resp.status}`);
  return (await resp.json()) as Record<string, unknown>;
}

/** Register the poster-only synthetic author (needed for the composite-PK FK on announce). */
export async function registerSyntheticAuthor(coordinatorUrl: string, agentId: string): Promise<void> {
  await coordPost(`${coordinatorUrl}/api/register`, { agent_id: agentId, name: agentId, modules: [] });
}

export async function ingestFindings(coordinatorUrl: string, agentId: string, findings: Finding[]): Promise<IngestResult> {
  const posted: { threadId: string; finding: Finding }[] = [];
  let failed = 0;
  for (const f of findings) {
    try {
      const data = await coordPost(`${coordinatorUrl}/api/announce`, findingToAnnounce(f, agentId));
      posted.push({ threadId: String(data.thread_id ?? ""), finding: f });
    } catch (err) {
      failed++;
      log.error("security: failed to ingest finding", { fingerprint: f.fingerprint, err: (err as Error).message });
    }
  }
  return { posted, failed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/security-ingest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/security/ingest.ts tests/unit/security-ingest.test.ts
git commit -m "feat(security): coordinator ingest via /api/announce + redaction chokepoint"
```

---

### Task 4: Verification re-scan (report-only)

**Files:**
- Create: `src/security/verify.ts`
- Test: `tests/unit/security-verify.test.ts`

**Interfaces:**
- Consumes: `AdapterRegistry`, `EngineId`, `Finding`, `ResolvedScope` (from `types.js`); `runSecurityScan` (from `scan.js`).
- Produces:
  - `VerifyItem` = `{ finding: Finding; worktreePath: string; threadId: string; engineId: EngineId }`
  - `VerifyResult` = `{ threadId: string; fingerprint: string; status: "verified" | "reopened" }`
  - `verifyFixes(registry: AdapterRegistry, items: VerifyItem[], signal: AbortSignal, deps?: { existsFn?: (p: string) => boolean }): Promise<VerifyResult[]>` (a missing worktree → `reopened`, conservative)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/security-verify.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { verifyFixes, type VerifyItem } from "../../src/security/verify.js";
import { createRegistry } from "../../src/security/registry.js";
import type { EngineAdapter, EngineId, Finding } from "../../src/security/types.js";

function finding(fp: string): Finding {
  return {
    id: fp, engine: "strix", ruleId: "r", title: "t", description: "d", severity: "high",
    category: "sqli", file: "src/a.ts", fingerprint: fp, status: "fixed", discoveredAt: "t", raw: null,
  };
}

// Adapter whose re-scan returns findings with the given fingerprints.
function rescanAdapter(returnFingerprints: string[]): EngineAdapter {
  return {
    capabilities: { id: "strix", displayName: "s", modes: ["sast"], requiresRunningTarget: false, supportsDiffScope: true, transport: "process", license: "Apache-2.0" },
    async healthCheck() { return { ok: true, detail: "" }; },
    async run() {
      return {
        engine: "strix" as EngineId, status: returnFingerprints.length ? "vulns_found" : "no_vulns",
        findings: returnFingerprints.map(finding), startedAt: "t", finishedAt: "t", durationMs: 1,
      };
    },
  };
}

describe("verifyFixes", () => {
  const existsTrue = { existsFn: () => true };

  it("marks a finding VERIFIED when the re-scan no longer detects its fingerprint", async () => {
    const reg = createRegistry();
    reg.register(rescanAdapter([])); // clean re-scan
    const items: VerifyItem[] = [{ finding: finding("fp1"), worktreePath: "/wt/a", threadId: "t-1", engineId: "strix" }];
    const res = await verifyFixes(reg, items, new AbortController().signal, existsTrue);
    expect(res).toEqual([{ threadId: "t-1", fingerprint: "fp1", status: "verified" }]);
  });

  it("marks a finding REOPENED when the re-scan still detects its fingerprint", async () => {
    const reg = createRegistry();
    reg.register(rescanAdapter(["fp1"])); // still there
    const items: VerifyItem[] = [{ finding: finding("fp1"), worktreePath: "/wt/a", threadId: "t-1", engineId: "strix" }];
    const res = await verifyFixes(reg, items, new AbortController().signal, existsTrue);
    expect(res[0].status).toBe("reopened");
  });

  it("marks REOPENED (conservative) when the worktree is gone (e.g. --cleanup)", async () => {
    const reg = createRegistry();
    reg.register(rescanAdapter([])); // even a clean adapter cannot save a missing worktree
    const items: VerifyItem[] = [{ finding: finding("fp1"), worktreePath: "/gone", threadId: "t-1", engineId: "strix" }];
    const res = await verifyFixes(reg, items, new AbortController().signal, { existsFn: () => false });
    expect(res[0].status).toBe("reopened");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/security-verify.test.ts`
Expected: FAIL — cannot resolve `../../src/security/verify.js`.

- [ ] **Step 3: Write the implementation (`src/security/verify.ts`)**

```ts
// src/security/verify.ts — deterministic re-scan of fixed worktrees. REPORT-ONLY in v1:
// records verified/reopened; does NOT mutate the coordinator. (Corrected justification: an
// /api/unclaim-task endpoint EXISTS, but it cannot reopen these threads — by the time verify runs
// the thread is already `resolving`/resolved and the caller is the synthetic author, not the
// claimer, so the unclaim SQL (`WHERE status='open' AND claimed_by=?`) matches nothing. A real
// reopen needs a coordinator change and is DEFERRED to v2 — spec §7.3/§14.)
import { existsSync } from "node:fs";
import type { AdapterRegistry, EngineId, Finding, ResolvedScope } from "./types.js";
import { runSecurityScan } from "./scan.js";

export interface VerifyItem {
  finding: Finding;
  worktreePath: string; // the agent branch that should contain the fix
  threadId: string;
  engineId: EngineId;
}

export interface VerifyResult {
  threadId: string;
  fingerprint: string;
  status: "verified" | "reopened";
}

export async function verifyFixes(
  registry: AdapterRegistry,
  items: VerifyItem[],
  signal: AbortSignal,
  deps: { existsFn?: (p: string) => boolean } = {},
): Promise<VerifyResult[]> {
  const exists = deps.existsFn ?? existsSync;
  const out: VerifyResult[] = [];
  for (const it of items) {
    // Conservative: if the worktree is gone (e.g. --cleanup removed it) we cannot prove closure → reopened.
    if (!exists(it.worktreePath)) {
      out.push({ threadId: it.threadId, fingerprint: it.finding.fingerprint, status: "reopened" });
      continue;
    }
    const scope: ResolvedScope = { targetPath: it.worktreePath, mode: "full", scanMode: "quick", excludeMatchers: [] };
    const scan = await runSecurityScan(registry, [it.engineId], scope, signal);
    const stillThere = scan.findings.some((f) => f.fingerprint === it.finding.fingerprint);
    out.push({ threadId: it.threadId, fingerprint: it.finding.fingerprint, status: stillThere ? "reopened" : "verified" });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/security-verify.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/security/verify.ts tests/unit/security-verify.test.ts
git commit -m "feat(security): report-only fix-verification re-scan"
```

---

### Task 5: Pre-phase + verify-phase orchestration functions

**Files:**
- Create: `src/security/pre-phase.ts`
- Test: `tests/unit/security-pre-phase.test.ts`

**Interfaces:**
- Consumes: everything from Plans 1–2 + Tasks 1/3/4 above; `execSync` from `node:child_process` (via injectable `diffFn`).
- Produces:
  - `runSecurityPrePhase(params: PrePhaseParams, deps?: { registry?: AdapterRegistry; halt?: () => boolean; sweep?: () => Promise<unknown> }): Promise<PrePhaseResult>` (halt-checks, sweeps orphan containers in `finally`, asserts coordinator-pool purity before seeding, writes a redacted audit report)
    - `PrePhaseParams` = `{ coordinatorUrl: string; runId: string; projectPath: string; baseSha?: string; security: MiniProjectSecurity }`
    - `PrePhaseResult` = `{ ledger: SecurityRunLedger; postedMap: { threadId: string; finding: Finding }[]; engineId: EngineId }`
  - `buildVerifyItems(params: { postedMap; workspacePaths: Map<string, string>; baseSha?: string; engineId: EngineId }, deps?: { diffFn?: (worktree: string, base: string) => string[] }): VerifyItem[]`
  - `runSecurityVerifyPhase(params: { postedMap; workspacePaths: Map<string, string>; baseSha?: string; engineId: EngineId; scanTimeoutMs: number }, deps?: { registry?: AdapterRegistry; diffFn?: (worktree: string, base: string) => string[] }): Promise<{ verified: number; reopened: number; details: VerifyResult[] }>`
  - `buildLedger(scan: ScanResult, extra: { ingested: number; outOfScopeDropped: number; suppressed: number }): SecurityRunLedger`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/security-pre-phase.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSecurityPrePhase, buildVerifyItems } from "../../src/security/pre-phase.js";
import { createRegistry } from "../../src/security/registry.js";
import type { EngineAdapter, EngineId, Finding, MiniProjectSecurity } from "../../src/security/types.js";
import { DEFAULT_SECURITY_CONFIG } from "../../src/security/config.js";

function finding(fp: string, file = "src/a.ts"): Finding {
  return {
    id: fp, engine: "strix", ruleId: "r", title: "t", description: "d", severity: "high",
    category: "sqli", file, fingerprint: fp, status: "new", discoveredAt: "t", raw: null,
  };
}

function fakeRegistry(findings: Finding[]) {
  const reg = createRegistry();
  const a: EngineAdapter = {
    capabilities: { id: "strix", displayName: "s", modes: ["sast"], requiresRunningTarget: false, supportsDiffScope: true, transport: "process", license: "Apache-2.0" },
    async healthCheck() { return { ok: true, detail: "" }; },
    async run() {
      return { engine: "strix" as EngineId, status: findings.length ? "vulns_found" : "no_vulns", findings, startedAt: "t", finishedAt: "t", durationMs: 5, exitCode: findings.length ? 2 : 0 };
    },
  };
  reg.register(a);
  return reg;
}

afterEach(() => vi.unstubAllGlobals());

describe("runSecurityPrePhase", () => {
  it("scans, ingests, and returns a ledger + posted map", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prephase-"));
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/register")) return { ok: true, json: async () => ({}) };
      if (url.includes("/api/threads-active")) return { ok: true, json: async () => [] }; // pool clean
      return { ok: true, json: async () => ({ thread_id: "t-1", status: "open" }) };
    });
    vi.stubGlobal("fetch", mockFetch);

    const security: MiniProjectSecurity = {
      config: { ...DEFAULT_SECURITY_CONFIG, authorization: { affirmed: true, authorized_by: "test" }, scope: { mode: "diff", diff_base: "HEAD~1", exclude_paths: [] } },
    };
    const res = await runSecurityPrePhase(
      { coordinatorUrl: "http://c", runId: "run-1", projectPath: dir, baseSha: "abc", security },
      { registry: fakeRegistry([finding("fp1")]), halt: () => false, sweep: async () => undefined },
    );

    expect(res.ledger.engine).toBe("strix");
    expect(res.ledger.ingested).toBe(1);
    expect(res.ledger.findingsBySeverity.high).toBe(1);
    expect(res.postedMap).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses (throws) when authorization is not affirmed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prephase-"));
    const security: MiniProjectSecurity = {
      config: { ...DEFAULT_SECURITY_CONFIG, authorization: { affirmed: false, authorized_by: "" } },
    };
    await expect(
      runSecurityPrePhase({ coordinatorUrl: "http://c", runId: "r", projectPath: dir, baseSha: "abc", security }, { registry: fakeRegistry([]) }),
    ).rejects.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("buildVerifyItems (git-diff mapping)", () => {
  it("maps each posted finding to the worktree whose diff touched its file", () => {
    const postedMap = [
      { threadId: "t-1", finding: finding("fp1", "src/a.ts") },
      { threadId: "t-2", finding: finding("fp2", "src/b.ts") },
    ];
    const workspacePaths = new Map([["agentA", "/wt/a"], ["agentB", "/wt/b"]]);
    const diffFn = (worktree: string) => (worktree === "/wt/a" ? ["src/a.ts"] : ["src/b.ts"]);
    const items = buildVerifyItems({ postedMap, workspacePaths, baseSha: "abc", engineId: "strix" }, { diffFn });
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.finding.fingerprint === "fp1")?.worktreePath).toBe("/wt/a");
    expect(items.find((i) => i.finding.fingerprint === "fp2")?.worktreePath).toBe("/wt/b");
  });

  it("omits a finding no worktree touched (nobody fixed it)", () => {
    const postedMap = [{ threadId: "t-1", finding: finding("fp1", "src/a.ts") }];
    const workspacePaths = new Map([["agentA", "/wt/a"]]);
    const diffFn = () => ["src/other.ts"];
    const items = buildVerifyItems({ postedMap, workspacePaths, baseSha: "abc", engineId: "strix" }, { diffFn });
    expect(items).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/security-pre-phase.test.ts`
Expected: FAIL — cannot resolve `../../src/security/pre-phase.js`.

- [ ] **Step 3: Write the implementation (`src/security/pre-phase.ts`)**

```ts
// src/security/pre-phase.ts — orchestration glue that the orchestrator calls (steps 3.5 + 6).
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AdapterRegistry, EngineId, Finding, MiniProjectSecurity, SecurityRunLedger, Severity,
} from "./types.js";
import { resolveScope, dropOutOfScope } from "./scope.js";
import { assertAuthorizedRun } from "./authorization.js";
import { loadBaseline, applyBaseline } from "./baseline.js";
import { resolveEngineSecrets, writeEnvFile, removeEnvFile } from "./secrets.js";
import { createDefaultRegistry, runSecurityScan, type ScanResult } from "./scan.js";
import { registerSyntheticAuthor, ingestFindings, syntheticAuthorId } from "./ingest.js";
import { verifyFixes, type VerifyItem, type VerifyResult } from "./verify.js";
import { isHaltRequested, sweepOrphanContainers } from "./killswitch.js";
import { normPath } from "./finding.js";
import { authHeaders } from "../coordinator-auth.js";
import { createLogger } from "../logger.js";

const log = createLogger("security");

export interface PrePhaseParams {
  coordinatorUrl: string;
  runId: string;
  projectPath: string;
  baseSha?: string;
  security: MiniProjectSecurity;
}

export interface PrePhaseResult {
  ledger: SecurityRunLedger;
  postedMap: { threadId: string; finding: Finding }[];
  engineId: EngineId;
}

export function buildLedger(
  scan: ScanResult,
  extra: { ingested: number; outOfScopeDropped: number; suppressed: number },
): SecurityRunLedger {
  const r = scan.results[0];
  const bySev: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of scan.findings) bySev[f.severity]++;
  return {
    engine: r?.engine ?? "strix",
    status: r?.status ?? "skipped",
    findingsBySeverity: bySev,
    ingested: extra.ingested,
    verified: 0,
    reopened: 0,
    falsePositives: 0,
    degraded: scan.degraded,
    durationMs: r?.durationMs ?? 0,
    exitCode: r?.exitCode,
    engineVersion: r?.engineVersion,
    license: "Apache-2.0",
    outOfScopeDropped: extra.outOfScopeDropped,
    suppressed: extra.suppressed,
  };
}

/** Assert the coordinator pool contains no foreign threads (belt-and-suspenders on top of reset-before-seed). */
async function assertPoolClean(coordinatorUrl: string, authorId: string): Promise<void> {
  const resp = await fetch(`${coordinatorUrl}/api/threads-active`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: "{}",
  }).catch(() => null);
  if (!resp || !resp.ok) return; // best-effort; a fresh in-process coordinator is empty anyway
  const threads = (await resp.json()) as Array<{ initiator_id?: string }>;
  const foreign = threads.filter((t) => t.initiator_id && t.initiator_id !== authorId);
  if (foreign.length > 0) {
    throw new Error(
      `security: coordinator pool is not clean — ${foreign.length} foreign thread(s) present. A v1 security ` +
        `run requires a fresh/reset essaim-managed coordinator (decision #3). Refusing to seed into a shared pool.`,
    );
  }
}

/** Best-effort redacted audit report. Refuses (skips) if reports/security/ is not gitignored (§9.7). */
function writeEngineReport(projectPath: string, runId: string, scan: ScanResult): void {
  const gi = existsSync(join(projectPath, ".gitignore")) ? readFileSync(join(projectPath, ".gitignore"), "utf8") : "";
  if (!gi.includes("reports/security/")) {
    log.warn("security: reports/security/ is not gitignored — skipping report write (run `essaim init --security`)");
    return;
  }
  const dir = join(projectPath, "reports", "security");
  mkdirSync(dir, { recursive: true });
  for (const r of scan.results) {
    writeFileSync(join(dir, `${r.engine}-${runId}.txt`), r.stdoutExcerpt ?? "", "utf8");
  }
}

/** Step 3.5: halt-check → authorize → scan → scope-filter → baseline → purity-check → ingest. */
export async function runSecurityPrePhase(
  p: PrePhaseParams,
  deps: { registry?: AdapterRegistry; halt?: () => boolean; sweep?: () => Promise<unknown> } = {},
): Promise<PrePhaseResult> {
  const cfg = p.security.config;
  const halt = deps.halt ?? (() => isHaltRequested(p.projectPath));
  if (halt()) {
    throw new Error("security: halt requested (reports/security/STOP or ESSAIM_SECURITY_HALT=1) — aborting before scan");
  }

  const scope = resolveScope(cfg, { repoPath: p.projectPath, baseSha: p.baseSha });
  assertAuthorizedRun(cfg, { resolvedDiffBase: scope.diffBase, envAffirmed: p.security.envAffirmed });

  const secrets = resolveEngineSecrets(p.security.secretsFile);
  const envFile = writeEnvFile(secrets);
  const registry = deps.registry ?? createDefaultRegistry({ runId: p.runId, envFile });
  const sweep = deps.sweep ?? (() => sweepOrphanContainers(p.runId));

  let scan: ScanResult;
  try {
    scan = await runSecurityScan(registry, cfg.engines, scope, AbortSignal.timeout(cfg.scanTimeoutMs));
  } finally {
    removeEnvFile(envFile);
    await sweep().catch(() => undefined); // teardown any orphan container
  }

  const inScope = dropOutOfScope(scan.findings, scope);
  if (inScope.dropped > 0) log.info(`security: dropped ${inScope.dropped} out-of-scope findings`);
  const baseline = loadBaseline(p.projectPath);
  const fresh = applyBaseline(inScope.kept, baseline);
  if (fresh.suppressed > 0) log.info(`security: suppressed ${fresh.suppressed} baselined findings`);

  const authorId = syntheticAuthorId(p.projectPath);
  await registerSyntheticAuthor(p.coordinatorUrl, authorId);
  await assertPoolClean(p.coordinatorUrl, authorId);
  const ingest = await ingestFindings(p.coordinatorUrl, authorId, fresh.fresh);
  writeEngineReport(p.projectPath, p.runId, scan);

  const ledger = buildLedger(scan, { ingested: ingest.posted.length, outOfScopeDropped: inScope.dropped, suppressed: fresh.suppressed });
  return { ledger, postedMap: ingest.posted, engineId: cfg.engines[0] };
}

function gitDiffNames(worktree: string, base: string): string[] {
  try {
    return execSync(`git diff --name-only ${base}`, { cwd: worktree, encoding: "utf-8" })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Map each posted finding to the worktree whose diff touched its file (deterministic, no coordinator). */
export function buildVerifyItems(
  params: { postedMap: { threadId: string; finding: Finding }[]; workspacePaths: Map<string, string>; baseSha?: string; engineId: EngineId },
  deps: { diffFn?: (worktree: string, base: string) => string[] } = {},
): VerifyItem[] {
  const diffFn = deps.diffFn ?? gitDiffNames;
  const base = params.baseSha ?? "HEAD~1";
  // Precompute each worktree's changed file set.
  const changed = new Map<string, Set<string>>();
  for (const wt of params.workspacePaths.values()) {
    changed.set(wt, new Set(diffFn(wt, base).map(normPath)));
  }
  const items: VerifyItem[] = [];
  for (const { threadId, finding } of params.postedMap) {
    if (!finding.file) continue;
    const target = normPath(finding.file);
    for (const [wt, files] of changed) {
      if (files.has(target)) {
        items.push({ finding, worktreePath: wt, threadId, engineId: params.engineId });
        break;
      }
    }
  }
  return items;
}

/** Step 6: build verify items from worktree diffs, re-scan, tally. Report-only. */
export async function runSecurityVerifyPhase(
  params: { postedMap: { threadId: string; finding: Finding }[]; workspacePaths: Map<string, string>; baseSha?: string; engineId: EngineId; scanTimeoutMs: number },
  deps: { registry?: AdapterRegistry; diffFn?: (worktree: string, base: string) => string[] } = {},
): Promise<{ verified: number; reopened: number; details: VerifyResult[] }> {
  const items = buildVerifyItems(params, { diffFn: deps.diffFn });
  const registry = deps.registry ?? createDefaultRegistry({ runId: "verify" });
  const details = await verifyFixes(registry, items, AbortSignal.timeout(params.scanTimeoutMs));
  return {
    verified: details.filter((d) => d.status === "verified").length,
    reopened: details.filter((d) => d.status === "reopened").length,
    details,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/security-pre-phase.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/security/pre-phase.ts tests/unit/security-pre-phase.test.ts
git commit -m "feat(security): pre-phase (scan→ingest) + verify-phase (git-diff mapping→re-scan)"
```

---

### Task 6: Child-process env allowlist (the load-bearing secret-leak fix)

**Files:**
- Create: `src/agent-loop/child-env.ts`
- Modify: `src/agent-loop/claude-stream.ts:258`
- Test: `tests/unit/security-env-scrub.test.ts`

**Interfaces:**
- Produces: `buildChildEnv(parentEnv: NodeJS.ProcessEnv, optionsEnv?: Record<string, string>): Record<string, string>`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/security-env-scrub.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildChildEnv } from "../../src/agent-loop/child-env.js";

describe("buildChildEnv — allowlist (drops engine secrets)", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    ANTHROPIC_API_KEY: "sk-ant-keep-me",
    CLAUDE_BIN: "/usr/local/bin/claude",
    COORDINATOR_TOKEN: "coord-tok",
    COORDINATOR_URL: "http://localhost:3100",
    ESSAIM_RUN_ID: "run-1",
    DEBUG: "1",
    HTTPS_PROXY: "http://proxy:8080",
    ProgramFiles: "C:\\Program Files",
    // must be DROPPED:
    LLM_API_KEY: "sk-engine-secret",
    STRIX_LLM: "anthropic/claude",
    HEXSTRIKE_TOKEN: "hx-secret",
    RANDOM_API_KEY: "leak",
    SOME_TOKEN: "leak2",
  } as NodeJS.ProcessEnv;

  it("keeps vars the claude child legitimately needs", () => {
    const env = buildChildEnv(parent);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-keep-me");
    expect(env.CLAUDE_BIN).toBe("/usr/local/bin/claude");
    expect(env.COORDINATOR_TOKEN).toBe("coord-tok");
    expect(env.COORDINATOR_URL).toBe("http://localhost:3100");
    expect(env.ESSAIM_RUN_ID).toBe("run-1");
    expect(env.DEBUG).toBe("1");
    expect(env.HTTPS_PROXY).toBe("http://proxy:8080"); // proxy passes (corp networks)
    expect(env.ProgramFiles).toBe("C:\\Program Files"); // Windows essential passes
  });

  it("DROPS engine secrets and arbitrary *_API_KEY / *_TOKEN", () => {
    const env = buildChildEnv(parent);
    expect(env.LLM_API_KEY).toBeUndefined();
    expect(env.STRIX_LLM).toBeUndefined();
    expect(env.HEXSTRIKE_TOKEN).toBeUndefined();
    expect(env.RANDOM_API_KEY).toBeUndefined();
    expect(env.SOME_TOKEN).toBeUndefined();
  });

  it("lets options.env override / add (always wins)", () => {
    const env = buildChildEnv(parent, { COORDINATOR_AGENT_ID: "alice-1", COORDINATOR_URL: "http://other" });
    expect(env.COORDINATOR_AGENT_ID).toBe("alice-1");
    expect(env.COORDINATOR_URL).toBe("http://other");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/security-env-scrub.test.ts`
Expected: FAIL — cannot resolve `../../src/agent-loop/child-env.js`.

- [ ] **Step 3: Write the implementation (`src/agent-loop/child-env.ts`)**

```ts
// src/agent-loop/child-env.ts — build a spawned claude child's env from an explicit ALLOWLIST
// instead of spreading process.env, so engine secrets (LLM_API_KEY, STRIX_LLM, …) never leak into
// agent processes/hooks. options.env always wins.

// Exact keys the claude child + essaim rely on.
const ALLOW_EXACT = new Set([
  "PATH", "Path", "PATHEXT",
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR",
  "SYSTEMROOT", "SystemDrive", "WINDIR", "COMSPEC", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
  "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData", "CommonProgramFiles",
  "LANG", "LC_ALL", "SHELL", "TERM", "USER", "USERNAME", "LOGNAME",
  "DEBUG", "LOG_LEVEL", "NODE_ENV",
  // Proxy config — the claude child may need it to reach the Anthropic API on corp networks.
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
]);

// Prefix families that belong to claude / anthropic / essaim / the coordinator (not engines).
const ALLOW_PREFIX = ["ANTHROPIC_", "CLAUDE_", "COORDINATOR_", "ESSAIM_", "AWS_"];

function isAllowed(key: string): boolean {
  if (ALLOW_EXACT.has(key)) return true;
  return ALLOW_PREFIX.some((p) => key.startsWith(p));
}

export function buildChildEnv(parentEnv: NodeJS.ProcessEnv, optionsEnv: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parentEnv)) {
    if (v !== undefined && isAllowed(k)) out[k] = v;
  }
  // options.env always wins (explicit per-agent overrides like COORDINATOR_AGENT_ID).
  return { ...out, ...optionsEnv };
}
```

> Note: `ANTHROPIC_API_KEY` is kept (the claude child needs it) but `LLM_API_KEY` / `STRIX_LLM` / `HEXSTRIKE_TOKEN` and any other `*_API_KEY`/`*_TOKEN` are dropped because they match no allow rule. `AWS_` is included because Strix/Bedrock users may run essaim agents that legitimately need it; if that is undesirable in a given deployment, remove it from `ALLOW_PREFIX`.

- [ ] **Step 4: Wire it into `claude-stream.ts` (replace the `...process.env` spread at line 258)**

In `src/agent-loop/claude-stream.ts`, add the import near the top:

```ts
import { buildChildEnv } from "./child-env.js";
```

Replace the spawn `env` line (currently `env: { ...(process.env as Record<string, string>), ...options.env },`) with:

```ts
      env: buildChildEnv(process.env, options.env),
```

- [ ] **Step 5: Run the env-scrub test + the existing claude-stream test**

Run: `npx vitest run tests/unit/security-env-scrub.test.ts tests/unit/claude-stream.test.ts`
Expected: PASS both. (`claude-stream.test.ts` mocks spawn and does not assert on the full parent env, so the allowlist change is transparent to it; if any assertion there depends on a specific env var reaching the child, add that var to `ALLOW_EXACT`/`ALLOW_PREFIX`.)

- [ ] **Step 6: Commit**

```bash
git add src/agent-loop/child-env.ts src/agent-loop/claude-stream.ts tests/unit/security-env-scrub.test.ts
git commit -m "fix(security): build child env from allowlist, not process.env spread (no secret leak)"
```

---

### Task 7: Orchestrator wiring (steps 3.5 + 6)

**Files:**
- Modify: `src/orchestrator/orchestrator.ts` (insert two guarded blocks; import from `../security/pre-phase.js`)
- Test: full suite regression (`npm test`) + a targeted assertion via a new tiny test that the wiring compiles and is guarded.

**Interfaces:**
- Consumes: `runSecurityPrePhase`, `runSecurityVerifyPhase` (from `../security/pre-phase.js`).

- [ ] **Step 1: Add the import** near the other imports in `src/orchestrator/orchestrator.ts`:

```ts
import { runSecurityPrePhase, runSecurityVerifyPhase } from "../security/pre-phase.js";
```

- [ ] **Step 2: Insert step 3.5 (between line 201 and the `// 4. Create worktrees` block at 203)**

```ts
  // 3.5 Security pre-phase (deterministic): scan → normalize → ingest as coordinator threads.
  // Guarded: dead code unless `project.security` is set on a coordinated run.
  let securityLedger: import("../security/types.js").SecurityRunLedger | undefined;
  let securityPosted: { threadId: string; finding: import("../security/types.js").Finding }[] = [];
  let securityEngineId: import("../security/types.js").EngineId | undefined;
  let securityBaseSha: string | undefined;
  if (project.security && mode === "with_coordinator") {
    log.info("Security pre-phase: scanning + seeding coordinator...");
    // REQUIRED: resolve the base commit NOW (before createWorkspaces). With default config
    // (scope.mode=diff, diff_base=""), resolveScope needs a base or it throws — so compute it here.
    try {
      securityBaseSha = execSync(`git rev-parse ${project.workspace.baseRef || "HEAD"}`, { cwd: basePath, encoding: "utf-8" }).trim();
    } catch {
      securityBaseSha = undefined; // non-git repo: diff-scope will refuse loudly in resolveScope
    }
    const pre = await runSecurityPrePhase({
      coordinatorUrl: effectiveCoordinatorUrl,
      runId,
      projectPath: basePath,
      baseSha: securityBaseSha,
      security: project.security,
    });
    securityLedger = pre.ledger;
    securityPosted = pre.postedMap;
    securityEngineId = pre.engineId;
    if (pre.postedMap.length === 0 && project.security.config.requireFindings) {
      throw new Error("Security scan produced 0 ingestable findings — aborting before swarm launch");
    }
  }
```

> **Fix (was P0#3):** `baseSha` is now computed here via `git rev-parse` (essaim already imports `execSync`; see the setup-script step) and passed into the pre-phase, so a default-config run (`scope.mode=diff`, `diff_base=""`) resolves its base instead of throwing in `resolveScope`. On a non-git repo `resolveScope` still refuses loudly (correct — diff scope is impossible). Add a regression test asserting a default-config run reaches `runSecurityScan` (mock the registry).

- [ ] **Step 3: Insert step 6 — strictly AFTER the swarm wait (`log.info("Done in …")`, ~line 400) and BEFORE the `// 7. Cleanup/keep worktrees` block (~line 435)**

> **Fix (was P1):** verify MUST run before the `--cleanup` block removes the worktrees, otherwise it re-scans deleted paths. Pin the insertion between line 400 and line 435. (`runSecurityVerifyPhase` is also hardened: a missing worktree → `reopened`, see Task 4.)

```ts
  // 6. Security verify phase (deterministic, report-only): re-scan fixed worktrees.
  if (project.security && mode === "with_coordinator" && securityLedger && securityEngineId) {
    log.info("Security verify phase: re-scanning fixed worktrees...");
    const verify = await runSecurityVerifyPhase({
      postedMap: securityPosted,
      workspacePaths: workspace.paths,
      baseSha: workspace.baseSha,
      engineId: securityEngineId,
      scanTimeoutMs: project.security.config.scanTimeoutMs,
    });
    securityLedger = { ...securityLedger, verified: verify.verified, reopened: verify.reopened };
    log.info(`Security: ${verify.verified} verified, ${verify.reopened} reopened`);
  }
```

- [ ] **Step 4: Attach the ledger to the returned `RunResult` (the object literal at lines 460-469)**

Add one line inside the returned object:

```ts
    worktrees,
    security: securityLedger,
  };
```

- [ ] **Step 5: Type-check + full regression suite**

Run: `npm run build && npm test`
Expected: PASS. tsc compiles; every pre-existing test stays green (the new blocks are guarded by `project.security`, which no existing fixture sets, so behavior is byte-identical). The new `src/security` unit tests remain green.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/orchestrator.ts
git commit -m "feat(security): wire security pre-phase + verify-phase into the orchestrator (guarded)"
```

---

### Task 8: Reporter security section

**Files:**
- Modify: `src/orchestrator/reporter.ts` (add a `## Moteur de sécurité` block before the `---` at line 190)
- Test: `tests/unit/security-report.test.ts`

**Interfaces:**
- Consumes: `RunResult` (now with optional `security: SecurityRunLedger`).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/security-report.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeReport } from "../../src/orchestrator/reporter.js";
import type { RunResult } from "../../src/orchestrator/types.js";

function baseResult(over: Partial<RunResult> = {}): RunResult {
  return {
    project_id: "p", project_name: "proj", mode: "with_coordinator", duration_ms: 1000,
    coordinator_metrics: {
      agents_count: 1, duration_total_ms: 1000, threads_opened: 0, threads_resolved_consensus: 0,
      threads_auto_resolved: 0, messages_exchanged: 0, conflicts_by_layer: {}, introspections_triggered: 0,
      introspections_concerned: 0, avg_resolution_time_ms: 0, hot_files: [],
    },
    agent_results: [], custom_metrics: {}, ...over,
  };
}

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("writeReport — security section", () => {
  it("renders a Moteur de sécurité section when RunResult.security is present", () => {
    dir = mkdtempSync(join(tmpdir(), "rep-"));
    const result = baseResult({
      security: {
        engine: "strix", status: "vulns_found",
        findingsBySeverity: { critical: 0, high: 2, medium: 1, low: 0, info: 0 },
        ingested: 3, verified: 2, reopened: 1, falsePositives: 0, degraded: false,
        durationMs: 142000, exitCode: 2, engineVersion: "1.3.1", license: "Apache-2.0",
        imageDigest: "sha256:abc", outOfScopeDropped: 4, suppressed: 1,
      },
    });
    const md = readFileSync(writeReport([result], dir), "utf8");
    expect(md).toContain("### Moteur de sécurité"); // nested under the project block
    expect(md).toContain("strix");
    expect(md).toContain("Apache-2.0");
    expect(md).toContain("2 verified");
    expect(md).toContain("1 reopened");
    expect(md).toContain("high");
  });

  it("omits the section entirely for a non-security run", () => {
    dir = mkdtempSync(join(tmpdir(), "rep-"));
    const md = readFileSync(writeReport([baseResult()], dir), "utf8");
    expect(md).not.toContain("Moteur de sécurité");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/security-report.test.ts`
Expected: FAIL — the section is not rendered yet.

- [ ] **Step 3: Add the section in `src/orchestrator/reporter.ts` (before `md += "\n---\n\n";` at line 190)**

```ts
    if (r.security) {
      const s = r.security;
      md += `\n### Moteur de sécurité\n\n`;
      md += `| Moteur | Licence | Statut | Durée | Exit | Version | Image |\n`;
      md += `|--------|---------|--------|-------|------|---------|-------|\n`;
      md += `| ${s.engine} | ${s.license} | ${s.status}${s.degraded ? " (degraded)" : ""} | ${Math.round(s.durationMs / 1000)}s | ${s.exitCode ?? "N/A"} | ${s.engineVersion ?? "N/A"} | \`${s.imageDigest ?? "N/A"}\` |\n`;
      md += `\n**Findings par sévérité:** `;
      md += `critical ${s.findingsBySeverity.critical}, high ${s.findingsBySeverity.high}, medium ${s.findingsBySeverity.medium}, low ${s.findingsBySeverity.low}, info ${s.findingsBySeverity.info}\n`;
      md += `\n**Remédiation:** ${s.ingested} ingérés · ${s.verified} verified · ${s.reopened} reopened · ${s.falsePositives} faux-positifs · ${s.suppressed} baselinés · ${s.outOfScopeDropped} hors-scope écartés\n`;
      if (s.reopened > 0) {
        md += `\n> ⚠️ ${s.reopened} finding(s) re-détecté(s) à la vérification — le run n'est PAS "clean" (révision humaine requise).\n`;
      }
    }
```

- [ ] **Step 4: Run the test + full suite**

Run: `npx vitest run tests/unit/security-report.test.ts && npm test`
Expected: PASS. Existing report tests unaffected (the block is gated on `r.security`).

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/reporter.ts tests/unit/security-report.test.ts
git commit -m "feat(security): reporter 'Moteur de sécurité' section (gated on RunResult.security)"
```

---

## Self-Review

**1. Spec coverage (spec §5, §7, §9.1-env, §12):**
- §5 coordinator ingest via existing `/api/announce` + synthetic author `/api/register`; redaction chokepoint inside `findingToAnnounce` → Task 3. ✅
- §5.3 reset-before-seed rationale: the orchestrator already resets (grounded) and v1 uses the essaim-managed coordinator; `requireFindings` abort before worktrees → Task 7. ✅ (External-coordinator rejection is enforced in the CLI, Plan 4.)
- §7.1 insertion points (3.5 before createWorkspaces; 6 after swarm before return) → Task 7, grounded to real line numbers. ✅
- §7.3 verify re-scan → verified/reopened; **report-only** (corrected justification: `/api/unclaim-task` exists but can't reopen a `resolving`/resolved thread posted by the synthetic author — real reopen is DEFERRED to v2) → Tasks 4, 5, 8. ✅
- §9.3 kill-switch (`isHaltRequested`) + orphan-container sweep (`sweepOrphanContainers`, wired into the pre-phase `finally`) → Plan 2 Task 7 + Task 5 wiring. ✅
- §9.7 redacted audit report written only when `reports/security/` is gitignored (else skipped) → Task 5 `writeEngineReport`. ✅
- §5.3 pre-swarm coordinator-purity assertion (`assertPoolClean`: `threads-active` must contain only our author) → Task 5. ✅
- **Deferred to v2 (explicit):** thread reopen on re-detection (needs a coordinator change); functional-regression pass/fail *reporting* (the `security-fix` behavior still runs the project tests, but v1 does not deterministically capture/report the result) — recorded in spec §14.
- §9.1 secret env-file + **claude-stream env allowlist** (the load-bearing edit) + env-scrub test → Tasks 1, 6. ✅
- §12 reporter section (engine, license, digest, 5-level severity, verify status) → Task 8. ✅
- Types: `MiniProject.security` / `RunResult.security` → Task 2. ✅
- Deferred to Plan 4: CLI `essaim security` (assembles `MiniProject.security`, rejects external coordinator, exit codes), behaviors/presets, init, docs, hermeticity + types-integration guards.

**2. Placeholder scan:** No TODO/"handle edge cases"/"similar to". The `baseSha` note in Task 7 gives concrete alternatives, not a placeholder. Verify is honestly scoped as report-only with the reason. ✅

**3. Type consistency:** `Finding`, `SecurityRunLedger`, `MiniProjectSecurity`, `EngineId`, `Severity`, `AdapterRegistry`, `ScanResult`, `VerifyItem`, `VerifyResult` sourced once (Plan 1 `types.ts` + Task 2 additions + Plan 2 `scan.ts`). `runSecurityScan` (Plan 2) consumed by `verify.ts` and `pre-phase.ts`. `authHeaders` reused from `coordinator-auth.ts`. `buildChildEnv` declared once, imported by `claude-stream.ts`. The orchestrator's `securityPosted`/`securityLedger`/`securityEngineId` types match `PrePhaseResult`. `writeReport(results, outputDir)` signature unchanged (grounded). ✅

---

## Downstream plan

- **Plan 4 — Surface:** `behaviors/security-fix.yaml` + `security-untrusted-findings.yaml`, `presets/sentinelle.yaml` + `templates/sentinelle.yaml` (`--triage-only` = zero-agent run, no separate preset), `cli/security.ts` (`essaim security` — builds `MiniProject.security`, `--secrets-file`, `--authorize`, rejects external `--coordinator-url`, Strix-mirrored exit codes), `essaim init --security` (scaffold + `.gitignore` patch), `docs/security/{licensing,THIRD_PARTY_LICENSES}.md`, and the `security-no-real-engines` + `security-types-integration` guard tests.
