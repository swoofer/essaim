# Security Subsystem — Plan 2: Engine Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic engine layer under `src/security/` — Docker invocation helpers, a captured-subprocess runner, the pluggable adapter registry with a **permissive-license gate**, the Strix adapter (exit-code mapping + report parsing + normalization to `Finding`), and the multi-engine scan orchestrator — all unit-tested with mocked subprocesses (no real Docker/Strix/network).

**Architecture:** `src/security/docker.ts` builds `docker run` argv and translates Windows paths to bind mounts; `adapters/base.ts` wraps `child_process.spawn` behind an injectable `SpawnFn`; `registry.ts` holds adapters and refuses any non-permissive license; `adapters/strix.ts` is the one real `EngineAdapter`, isolating **all** Strix-output-format dependence into a single `parseStrixReport` function + fixture; `scan.ts` fans out across adapters with `Promise.allSettled` and a `degraded` flag. Consumes Plan 1 (`types.ts`, `finding.ts`, `redact.ts`, `errors.ts`).

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Node ≥ 20 (`node:child_process`, `node:fs`, `node:os`, `node:path`), vitest with `vi.mock("child_process", …)` / injectable `SpawnFn`.

## Global Constraints

_(From `docs/superpowers/specs/2026-07-22-essaim-security-subsystem-design.md`. Plus the Plan 1 constraints, still in force.)_

- ESM `.js` import specifiers; `createLogger("security")` from `../logger.js`.
- **License gate:** `registry.register()` throws `EngineLicenseError` unless `capabilities.license ∈ {MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC}`. Adapters invoke engines **out-of-process only** (spawn/REST/MCP) — never import/link/vendor engine source.
- **Arm's-length invocation:** Strix runs via `docker run --rm usestrix/strix@sha256:<pinned>` — never a host binary. Image pinned by **digest**, never `:latest`.
- **Secrets:** engine secrets (`LLM_API_KEY`, `STRIX_LLM`) reach the engine container via a **temp `--env-file` (0600, unlinked in `finally`)**, never via `process.env` and never in argv (they'd show in `ps`).
- **Fail-open at engine level:** `run()` never rejects; failure rides `EngineRunResult.status`. **Fail-closed elsewhere** (authorization, license gate) throws.
- **Zero-reads-as-fact guard:** exit code 2 (vulns) with a non-empty stdout that parses to **zero** findings → `status:"error"`/`"partial"`, never a false `no_vulns`.
- **Windows-first:** win32 path → bind-mount translation is a first-class, tested path.
- **Hermetic tests:** no test spawns real Docker, real Strix, or a network call. All subprocess behavior goes through an injected `SpawnFn`.

**Test commands:** single file `npx vitest run tests/unit/<file>.test.ts`; full suite `npm test`.

---

### Task 1: Docker invocation helpers

**Files:**
- Create: `src/security/docker.ts`
- Test: `tests/unit/security-docker.test.ts`

**Interfaces:**
- Consumes: nothing from other security modules (pure string/argv builders).
- Produces:
  - `PINNED_STRIX_IMAGE: string` (e.g. `"usestrix/strix@sha256:PLACEHOLDER_DIGEST"` — the real digest is pinned in Plan 2 Task 5 / spec §16).
  - `toDockerHostPath(hostPath: string): string`
  - `dockerMountArg(hostPath: string, target?: string, ro?: boolean): string`
  - `containerName(runId: string): string`
  - `dockerRunArgs(opts: DockerRunOpts): string[]` where `DockerRunOpts = { image: string; containerName: string; mount: string; envFile?: string; target: string; scanMode: "quick" | "deep"; scopeMode: "diff" | "full"; diffBase?: string; instruction: string }`
  - `dockerKillArgs(name: string): string[]`
  - `dockerInspectArgs(image: string): string[]`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/security-docker.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  toDockerHostPath,
  dockerMountArg,
  containerName,
  dockerRunArgs,
  dockerKillArgs,
  dockerInspectArgs,
  PINNED_STRIX_IMAGE,
} from "../../src/security/docker.js";

describe("toDockerHostPath", () => {
  it("normalizes Windows backslashes to forward slashes, keeping the drive", () => {
    expect(toDockerHostPath("C:\\Users\\gagno\\repo")).toBe("C:/Users/gagno/repo");
  });
  it("leaves POSIX paths unchanged", () => {
    expect(toDockerHostPath("/home/user/repo")).toBe("/home/user/repo");
  });
});

describe("dockerMountArg", () => {
  it("builds a read-only bind mount to /src by default", () => {
    expect(dockerMountArg("C:\\Users\\gagno\\repo")).toBe("C:/Users/gagno/repo:/src:ro");
  });
  it("supports a custom target and rw", () => {
    expect(dockerMountArg("/repo", "/work", false)).toBe("/repo:/work");
  });
});

describe("containerName", () => {
  it("is deterministic from the runId", () => {
    expect(containerName("run-123")).toBe("essaim-security-run-123");
  });
});

describe("dockerRunArgs", () => {
  const base = {
    image: PINNED_STRIX_IMAGE,
    containerName: "essaim-security-run-1",
    mount: "C:/Users/gagno/repo:/src:ro",
    envFile: "/tmp/sec.env",
    target: "/src",
    scanMode: "quick" as const,
    scopeMode: "diff" as const,
    diffBase: "abc123",
    instruction: "Scope: only files changed since abc123",
  };

  it("builds a --rm, named, mounted, env-filed docker run with Strix flags", () => {
    const args = dockerRunArgs(base);
    expect(args[0]).toBe("run");
    expect(args).toContain("--rm");
    expect(args).toEqual(expect.arrayContaining(["--name", "essaim-security-run-1"]));
    expect(args).toEqual(expect.arrayContaining(["-v", "C:/Users/gagno/repo:/src:ro"]));
    expect(args).toEqual(expect.arrayContaining(["--env-file", "/tmp/sec.env"]));
    expect(args).toContain(PINNED_STRIX_IMAGE);
    // Strix flags after the image
    expect(args).toEqual(expect.arrayContaining(["-n", "-t", "/src", "--scan-mode", "quick"]));
    expect(args).toEqual(expect.arrayContaining(["--scope-mode", "diff", "--diff-base", "abc123"]));
    expect(args).toEqual(expect.arrayContaining(["--instruction", "Scope: only files changed since abc123"]));
    // the image must come BEFORE the engine flags
    expect(args.indexOf(PINNED_STRIX_IMAGE)).toBeLessThan(args.indexOf("-n"));
    // secrets never appear in argv
    expect(args.join(" ")).not.toContain("LLM_API_KEY");
  });

  it("omits diff flags in full-scope mode", () => {
    const args = dockerRunArgs({ ...base, scopeMode: "full", diffBase: undefined });
    expect(args).not.toContain("--scope-mode");
    expect(args).not.toContain("--diff-base");
  });

  it("omits --env-file when none is given", () => {
    const args = dockerRunArgs({ ...base, envFile: undefined });
    expect(args).not.toContain("--env-file");
  });
});

describe("dockerKillArgs / dockerInspectArgs", () => {
  it("build kill and inspect argv", () => {
    expect(dockerKillArgs("essaim-security-run-1")).toEqual(["kill", "essaim-security-run-1"]);
    expect(dockerInspectArgs(PINNED_STRIX_IMAGE)).toEqual(["image", "inspect", PINNED_STRIX_IMAGE]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/security-docker.test.ts`
Expected: FAIL — cannot resolve `../../src/security/docker.js`.

- [ ] **Step 3: Write the implementation (`src/security/docker.ts`)**

```ts
// src/security/docker.ts — build docker argv + translate Windows paths to bind mounts.
// Pure string/argv builders (no spawning here). Windows-first.

// Pinned by DIGEST (never :latest). The real digest is pinned during rollout (spec §16);
// PLACEHOLDER_DIGEST must be replaced with a license-verified digest before a real run.
export const PINNED_STRIX_IMAGE = "usestrix/strix@sha256:PLACEHOLDER_DIGEST";

/** Normalize a host path so Docker Desktop accepts it as a bind source (backslashes → forward). */
export function toDockerHostPath(hostPath: string): string {
  return hostPath.replace(/\\/g, "/");
}

/** Build a `-v` bind-mount value. Defaults to read-only mount at /src. */
export function dockerMountArg(hostPath: string, target = "/src", ro = true): string {
  return `${toDockerHostPath(hostPath)}:${target}${ro ? ":ro" : ""}`;
}

export function containerName(runId: string): string {
  return `essaim-security-${runId}`;
}

export interface DockerRunOpts {
  image: string;
  containerName: string;
  mount: string;
  envFile?: string;
  target: string;
  scanMode: "quick" | "deep";
  scopeMode: "diff" | "full";
  diffBase?: string;
  instruction: string;
}

/** Build the full `docker run …` argv. Image precedes engine flags. Secrets never appear here. */
export function dockerRunArgs(o: DockerRunOpts): string[] {
  const args: string[] = ["run", "--rm", "--name", o.containerName, "-v", o.mount];
  if (o.envFile) args.push("--env-file", o.envFile);
  args.push(o.image);
  // Strix flags (after the image = command inside the container):
  args.push("-n", "-t", o.target, "--scan-mode", o.scanMode);
  if (o.scopeMode === "diff" && o.diffBase) args.push("--scope-mode", "diff", "--diff-base", o.diffBase);
  args.push("--instruction", o.instruction);
  return args;
}

export function dockerKillArgs(name: string): string[] {
  return ["kill", name];
}

export function dockerInspectArgs(image: string): string[] {
  return ["image", "inspect", image];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/security-docker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/security/docker.ts tests/unit/security-docker.test.ts
git commit -m "feat(security): docker argv builders + win32 path→mount translation"
```

---

### Task 2: Captured-subprocess runner

**Files:**
- Create: `src/security/adapters/base.ts`
- Test: `tests/unit/security-spawn.test.ts`

**Interfaces:**
- Consumes: `node:child_process` (default), `createLogger` from `../../logger.js`.
- Produces:
  - `SpawnResult` = `{ code: number | null; stdout: string; stderr: string; timedOut: boolean }`
  - `SpawnFn` = `(command: string, args: string[], opts: { cwd?: string; signal?: AbortSignal }) => ChildLike` where `ChildLike` is the minimal EventEmitter+stdio shape.
  - `spawnCaptured(command: string, args: string[], opts?: { cwd?: string; signal?: AbortSignal; spawnFn?: SpawnFn }): Promise<SpawnResult>`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/security-spawn.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { spawnCaptured, type SpawnFn } from "../../src/security/adapters/base.js";

// A controllable fake child, mirroring the claude-stream.test.ts pattern.
function fakeChild() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    kill: (sig?: string) => void;
    killed: boolean;
  };
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
  };
  return proc;
}

describe("spawnCaptured", () => {
  it("collects stdout/stderr and resolves with the exit code", async () => {
    const child = fakeChild();
    const spawnFn: SpawnFn = () => child as never;
    const p = spawnCaptured("docker", ["run"], { spawnFn });
    // drive output then close
    await new Promise((r) => process.nextTick(r));
    child.stdout.push("hello ");
    child.stdout.push("world");
    child.stdout.push(null);
    child.stderr.push(null);
    child.emit("close", 0);
    const res = await p;
    expect(res).toEqual({ code: 0, stdout: "hello world", stderr: "", timedOut: false });
  });

  it("marks timedOut and kills the child when the signal aborts", async () => {
    const child = fakeChild();
    const spawnFn: SpawnFn = () => child as never;
    const ac = new AbortController();
    const p = spawnCaptured("docker", ["run"], { signal: ac.signal, spawnFn });
    await new Promise((r) => process.nextTick(r));
    ac.abort();
    // adapter kills the child; simulate the resulting close
    child.emit("close", null);
    const res = await p;
    expect(res.timedOut).toBe(true);
    expect(child.killed).toBe(true);
  });

  it("rejects only when spawn itself errors", async () => {
    const child = fakeChild();
    const spawnFn: SpawnFn = () => child as never;
    const p = spawnCaptured("docker", ["run"], { spawnFn });
    await new Promise((r) => process.nextTick(r));
    child.emit("error", new Error("ENOENT: docker not found"));
    await expect(p).rejects.toThrow(/docker not found/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/security-spawn.test.ts`
Expected: FAIL — cannot resolve `../../src/security/adapters/base.js`.

- [ ] **Step 3: Write the implementation (`src/security/adapters/base.ts`)**

```ts
// src/security/adapters/base.ts — capture a subprocess's stdout/stderr/exit, with abort→kill.
import { spawn as nodeSpawn } from "node:child_process";
import { createLogger } from "../../logger.js";

const log = createLogger("security");

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// Minimal child shape we depend on (EventEmitter + readable stdio + kill).
export interface ChildLike {
  stdout: { on(ev: "data", cb: (chunk: Buffer | string) => void): void } | null;
  stderr: { on(ev: "data", cb: (chunk: Buffer | string) => void): void } | null;
  on(ev: "close", cb: (code: number | null) => void): void;
  on(ev: "error", cb: (err: Error) => void): void;
  kill(signal?: string): void;
}

export type SpawnFn = (command: string, args: string[], opts: { cwd?: string }) => ChildLike;

const defaultSpawnFn: SpawnFn = (command, args, opts) =>
  nodeSpawn(command, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] }) as unknown as ChildLike;

/** Spawn a command, capture output, honor an AbortSignal (kill + timedOut). Rejects only on spawn error. */
export function spawnCaptured(
  command: string,
  args: string[],
  opts: { cwd?: string; signal?: AbortSignal; spawnFn?: SpawnFn } = {},
): Promise<SpawnResult> {
  const spawnFn = opts.spawnFn ?? defaultSpawnFn;
  return new Promise<SpawnResult>((resolve, reject) => {
    const child = spawnFn(command, args, { cwd: opts.cwd });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const onAbort = () => {
      timedOut = true;
      log.warn(`security: aborting subprocess ${command} (timeout/kill-switch)`);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (c) => (stdout += c.toString()));
    child.stderr?.on("data", (c) => (stderr += c.toString()));
    child.on("error", (err) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/security-spawn.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/security/adapters/base.ts tests/unit/security-spawn.test.ts
git commit -m "feat(security): captured-subprocess runner with abort→kill"
```

---

### Task 3: Adapter registry + permissive-license gate

**Files:**
- Create: `src/security/registry.ts`
- Test: `tests/unit/security-registry-license.test.ts`

**Interfaces:**
- Consumes: `EngineAdapter`, `EngineId`, `EngineCapabilities` (from `types.js`); `EngineLicenseError` (from `errors.js`).
- Produces:
  - `PERMISSIVE_LICENSES: ReadonlySet<string>`
  - `createRegistry(): AdapterRegistry` (implements the `AdapterRegistry` interface from `types.ts`: `register`, `get`, `resolve`).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/security-registry-license.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/security/registry.js";
import { EngineLicenseError } from "../../src/security/errors.js";
import type { EngineAdapter, EngineCapabilities, EngineId } from "../../src/security/types.js";

function fakeAdapter(id: string, license: string): EngineAdapter {
  const capabilities: EngineCapabilities = {
    id: id as EngineId,
    displayName: id,
    modes: ["sast"],
    requiresRunningTarget: false,
    supportsDiffScope: true,
    transport: "process",
    license,
  };
  return {
    capabilities,
    async healthCheck() {
      return { ok: true, detail: "fake" };
    },
    async run() {
      return {
        engine: id as EngineId,
        status: "no_vulns",
        findings: [],
        startedAt: "t",
        finishedAt: "t",
        durationMs: 0,
      };
    },
  };
}

describe("createRegistry — license gate", () => {
  it("accepts a permissive (Apache-2.0) adapter", () => {
    const reg = createRegistry();
    expect(() => reg.register(fakeAdapter("strix", "Apache-2.0"))).not.toThrow();
    expect(reg.get("strix" as EngineId)?.capabilities.license).toBe("Apache-2.0");
  });

  it("REFUSES an AGPL-3.0 adapter", () => {
    const reg = createRegistry();
    expect(() => reg.register(fakeAdapter("shannon", "AGPL-3.0"))).toThrow(EngineLicenseError);
  });

  it("REFUSES an unknown/empty license", () => {
    const reg = createRegistry();
    expect(() => reg.register(fakeAdapter("x", ""))).toThrow(EngineLicenseError);
  });

  it("resolve() throws on an unregistered id", () => {
    const reg = createRegistry();
    reg.register(fakeAdapter("strix", "MIT"));
    expect(() => reg.resolve(["strix", "pentagi"] as EngineId[])).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/security-registry-license.test.ts`
Expected: FAIL — cannot resolve `../../src/security/registry.js`.

- [ ] **Step 3: Write the implementation (`src/security/registry.ts`)**

```ts
// src/security/registry.ts — pluggable adapter registry with a permissive-license gate.
// The gate is the one mechanism protecting essaim's MIT posture: AGPL/GPL/SSPL/non-commercial
// engines must never register (invoke them out-of-process only).
import type { AdapterRegistry, EngineAdapter, EngineId } from "./types.js";
import { EngineLicenseError } from "./errors.js";

export const PERMISSIVE_LICENSES: ReadonlySet<string> = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
]);

export function createRegistry(): AdapterRegistry {
  const adapters = new Map<EngineId, EngineAdapter>();
  return {
    register(a: EngineAdapter): void {
      const lic = a.capabilities.license;
      if (!PERMISSIVE_LICENSES.has(lic)) {
        throw new EngineLicenseError(
          `Refusing engine '${a.capabilities.id}': license '${lic || "<none>"}' is not on the permissive ` +
            `allowlist (MIT/Apache-2.0/BSD/ISC). AGPL/GPL/SSPL/non-commercial engines must not be registered; ` +
            `invoke them out-of-process only.`,
        );
      }
      adapters.set(a.capabilities.id, a);
    },
    get(id: EngineId): EngineAdapter | undefined {
      return adapters.get(id);
    },
    resolve(ids: EngineId[]): EngineAdapter[] {
      return ids.map((id) => {
        const a = adapters.get(id);
        if (!a) throw new Error(`security: engine '${id}' is not registered`);
        return a;
      });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/security-registry-license.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/security/registry.ts tests/unit/security-registry-license.test.ts
git commit -m "feat(security): adapter registry + permissive-license gate"
```

---

### Task 4: Strix report parser + normalization (the one format-dependent unit)

> **Format-capture spike (do this first, once):** Strix's exact `-n` stdout/report format has not been captured on a real run. This task isolates **all** format dependence into `parseStrixReport`. Before/while implementing: run `docker run --rm usestrix/strix@sha256:<digest> -n -t /src …` once against a throwaway repo, capture stdout to `tests/fixtures/security/strix-vulns.stdout.txt`, **scrub any secrets**, and confirm the JSON-report shape below matches reality. If Strix's field names differ, adjust the `RawStrixFinding` mapping in Step 3 accordingly — the surrounding code (exit-code mapping, normalization, tests) does not change. The fixture in Step 1 is a representative sample to build against.

**Files:**
- Create: `src/security/adapters/strix-parse.ts`
- Create: `tests/fixtures/security/strix-vulns.stdout.txt`
- Create: `tests/fixtures/security/strix-clean.stdout.txt`
- Test: `tests/unit/security-normalize.test.ts`

**Interfaces:**
- Consumes: `Finding`, `Severity`, `EngineId` (from `types.js`); `fingerprint` (from `finding.js`); `redact` (from `redact.js`).
- Produces:
  - `StrixParseError` (extends `Error`)
  - `parseStrixReport(stdout: string): RawStrixFinding[]` where `RawStrixFinding = { ruleId: string; title: string; description: string; severity: string; category: string; cwe?: string; file?: string; line?: number; evidence?: string }`
  - `toFinding(raw: RawStrixFinding, id: string): Finding`
  - `mapSeverity(s: string): Severity`

- [ ] **Step 1: Write the fixtures and the failing test**

Create `tests/fixtures/security/strix-clean.stdout.txt`:

```
Strix scan complete.
```json
{ "strix_version": "1.3.1", "findings": [] }
```
No vulnerabilities found.
```

Create `tests/fixtures/security/strix-vulns.stdout.txt` (representative; replace with a real capture per the spike):

```
Strix scan complete.
```json
{
  "strix_version": "1.3.1",
  "findings": [
    {
      "rule_id": "sqli-concat",
      "title": "SQL injection via string concatenation",
      "description": "User input flows into a concatenated SQL query.",
      "severity": "high",
      "category": "sqli",
      "cwe": "CWE-89",
      "file": "src/db/users.ts",
      "line": 42,
      "evidence": "query = 'SELECT * FROM users WHERE id=' + req.params.id  // token sk-abcDEF0123456789ghijklmnop"
    },
    {
      "rule_id": "xss-reflected",
      "title": "Reflected XSS in search",
      "description": "Search term rendered without escaping.",
      "severity": "medium",
      "category": "xss",
      "cwe": "CWE-79",
      "file": "src/routes/search.ts",
      "line": 17
    }
  ]
}
```
2 findings.
```

Create `tests/unit/security-normalize.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStrixReport, toFinding, mapSeverity, StrixParseError } from "../../src/security/adapters/strix-parse.js";

const fx = (name: string) => readFileSync(join(__dirname, "..", "fixtures", "security", name), "utf8");

describe("parseStrixReport", () => {
  it("parses the findings array out of a JSON report embedded in stdout", () => {
    const raw = parseStrixReport(fx("strix-vulns.stdout.txt"));
    expect(raw).toHaveLength(2);
    expect(raw[0].ruleId).toBe("sqli-concat");
    expect(raw[0].file).toBe("src/db/users.ts");
    expect(raw[1].category).toBe("xss");
  });

  it("returns [] for a clean report", () => {
    expect(parseStrixReport(fx("strix-clean.stdout.txt"))).toEqual([]);
  });

  it("throws StrixParseError when stdout has no recognizable JSON report", () => {
    expect(() => parseStrixReport("total garbage, no json here")).toThrow(StrixParseError);
  });
});

describe("mapSeverity", () => {
  it("maps engine severity strings to the 5-level scale", () => {
    expect(mapSeverity("critical")).toBe("critical");
    expect(mapSeverity("HIGH")).toBe("high");
    expect(mapSeverity("medium")).toBe("medium");
    expect(mapSeverity("low")).toBe("low");
    expect(mapSeverity("informational")).toBe("info");
    expect(mapSeverity("weird-unknown")).toBe("info"); // safe default
  });
});

describe("toFinding", () => {
  it("normalizes a raw finding, computes a fingerprint, and REDACTS evidence", () => {
    const raw = parseStrixReport(fx("strix-vulns.stdout.txt"))[0];
    const f = toFinding(raw, "id-1");
    expect(f.engine).toBe("strix");
    expect(f.severity).toBe("high");
    expect(f.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(f.status).toBe("new");
    // the sk- token in the fixture evidence must be gone
    expect(f.evidence ?? "").not.toContain("sk-abcDEF0123456789ghijklmnop");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/security-normalize.test.ts`
Expected: FAIL — cannot resolve `../../src/security/adapters/strix-parse.js`.

- [ ] **Step 3: Write the implementation (`src/security/adapters/strix-parse.ts`)**

```ts
// src/security/adapters/strix-parse.ts — the ONE unit that depends on Strix's output format.
// Isolate all format brittleness here. If a real capture shows a different schema, only the
// RawStrixFinding mapping below changes.
import type { EngineId, Finding, Severity } from "../types.js";
import { fingerprint } from "../finding.js";
import { redact } from "../redact.js";

const STRIX: EngineId = "strix";

export class StrixParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrixParseError";
  }
}

export interface RawStrixFinding {
  ruleId: string;
  title: string;
  description: string;
  severity: string;
  category: string;
  cwe?: string;
  file?: string;
  line?: number;
  evidence?: string;
}

/** Extract the JSON report object embedded in Strix stdout (a ```json fenced block, else a raw {…}). */
function extractReportJson(stdout: string): { findings?: unknown[]; strix_version?: string } {
  const fenced = stdout.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1);
  if (!candidate || !candidate.trim().startsWith("{")) {
    throw new StrixParseError("no JSON report found in Strix stdout");
  }
  try {
    return JSON.parse(candidate);
  } catch (err) {
    throw new StrixParseError(`Strix report is not valid JSON: ${(err as Error).message}`);
  }
}

export function parseStrixReport(stdout: string): RawStrixFinding[] {
  const report = extractReportJson(stdout);
  if (!Array.isArray(report.findings)) {
    throw new StrixParseError("Strix report has no findings array");
  }
  return report.findings.map((f) => {
    const o = f as Record<string, unknown>;
    return {
      ruleId: String(o.rule_id ?? o.ruleId ?? "unknown"),
      title: String(o.title ?? "Untitled finding"),
      description: String(o.description ?? ""),
      severity: String(o.severity ?? "info"),
      category: String(o.category ?? "unknown"),
      cwe: o.cwe ? String(o.cwe) : undefined,
      file: o.file ? String(o.file) : undefined,
      line: typeof o.line === "number" ? o.line : undefined,
      evidence: o.evidence ? String(o.evidence) : undefined,
    };
  });
}

export function mapSeverity(s: string): Severity {
  const v = s.toLowerCase();
  if (v === "critical") return "critical";
  if (v === "high") return "high";
  if (v === "medium" || v === "moderate") return "medium";
  if (v === "low") return "low";
  if (v === "info" || v === "informational" || v === "note") return "info";
  return "info"; // safe default — never throw here
}

export function toFinding(raw: RawStrixFinding, id: string): Finding {
  const fp = fingerprint({ engine: STRIX, ruleId: raw.ruleId, file: raw.file, category: raw.category });
  return {
    id,
    engine: STRIX,
    engineFindingId: raw.ruleId,
    ruleId: raw.ruleId,
    title: raw.title,
    description: raw.description,
    severity: mapSeverity(raw.severity),
    category: raw.category,
    cwe: raw.cwe,
    file: raw.file,
    line: raw.line,
    evidence: raw.evidence ? redact(raw.evidence) : undefined,
    fingerprint: fp,
    status: "new",
    discoveredAt: new Date().toISOString(),
    raw,
  };
}
```

> Note on `new Date().toISOString()`: this is production code (not a workflow script), so `Date` is available. Tests do not assert on `discoveredAt`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/security-normalize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/security/adapters/strix-parse.ts tests/fixtures/security/ tests/unit/security-normalize.test.ts
git commit -m "feat(security): Strix report parser + Finding normalization (format-isolated)"
```

---

### Task 5: Strix adapter (exit-code mapping, zero-reads guard, abort→kill)

> **On the version gate:** the spec mentions a `version_unsupported` failure. A strict Strix *version-range* gate is **deferred** until a real Strix version is captured (spec §16) — implementing a range check against guessed versions would be fake precision. The **load-bearing** guard implemented here is the *report-shape* guard: `parseStrixReport` throws `StrixParseError` on any unrecognized/zero-from-nonempty report, which the adapter maps to `status:"error"` (never a false `no_vulns`). The `EngineError.kind:"version_unsupported"` value stays in the enum for v2.

**Files:**
- Create: `src/security/adapters/strix.ts`
- Test: `tests/unit/security-strix-adapter.test.ts`

**Interfaces:**
- Consumes: `EngineAdapter`, `EngineCapabilities`, `EngineRunResult`, `ResolvedScope` (from `../types.js`); `spawnCaptured`, `SpawnFn`, `SpawnResult` (from `./base.js`); docker builders (from `../docker.js`); `parseStrixReport`, `toFinding`, `StrixParseError` (from `./strix-parse.js`); `redact` (from `../redact.js`); `createLogger` (from `../../logger.js`); `randomUUID` from `node:crypto`.
- Produces:
  - `STRIX_CAPABILITIES: EngineCapabilities`
  - `StrixAdapterDeps` = `{ image?: string; runId: string; spawnFn?: SpawnFn; envFile?: string; instruction?: string }`
  - `createStrixAdapter(deps: StrixAdapterDeps): EngineAdapter`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/security-strix-adapter.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createStrixAdapter, STRIX_CAPABILITIES } from "../../src/security/adapters/strix.js";
import type { SpawnFn } from "../../src/security/adapters/base.js";
import type { ResolvedScope } from "../../src/security/types.js";

const fx = (name: string) => readFileSync(join(__dirname, "..", "fixtures", "security", name), "utf8");

const scope: ResolvedScope = { targetPath: "C:/repo", mode: "diff", scanMode: "quick", diffBase: "abc123", excludeMatchers: [] };

// Build a SpawnFn that emits the given stdout + exit code, and records argv.
function scriptedSpawn(stdout: string, code: number, capture?: { args?: string[] }): SpawnFn {
  return ((_cmd: string, args: string[]) => {
    if (capture) capture.args = args;
    const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
    const stream = { on: (_e: "data", cb: (c: string) => void) => setTimeout(() => cb(stdout), 0) };
    return {
      stdout: stream,
      stderr: { on: () => {} },
      on: (ev: string, cb: (...a: unknown[]) => void) => {
        (listeners[ev] ??= []).push(cb);
        if (ev === "close") setTimeout(() => cb(code), 5);
      },
      kill: () => {},
    };
  }) as unknown as SpawnFn;
}

describe("STRIX_CAPABILITIES", () => {
  it("declares Apache-2.0, static, process transport", () => {
    expect(STRIX_CAPABILITIES.license).toBe("Apache-2.0");
    expect(STRIX_CAPABILITIES.requiresRunningTarget).toBe(false);
    expect(STRIX_CAPABILITIES.transport).toBe("process");
  });
});

describe("StrixAdapter.run — exit-code mapping", () => {
  it("exit 0 → no_vulns, no findings", async () => {
    const a = createStrixAdapter({ runId: "r1", spawnFn: scriptedSpawn(fx("strix-clean.stdout.txt"), 0) });
    const res = await a.run(scope, new AbortController().signal);
    expect(res.status).toBe("no_vulns");
    expect(res.findings).toHaveLength(0);
    expect(res.exitCode).toBe(0);
  });

  it("exit 2 → vulns_found, findings parsed + normalized", async () => {
    const cap: { args?: string[] } = {};
    const a = createStrixAdapter({ runId: "r1", spawnFn: scriptedSpawn(fx("strix-vulns.stdout.txt"), 2, cap) });
    const res = await a.run(scope, new AbortController().signal);
    expect(res.status).toBe("vulns_found");
    expect(res.findings).toHaveLength(2);
    expect(res.findings[0].engine).toBe("strix");
    // argv carried the diff scope
    expect(cap.args).toEqual(expect.arrayContaining(["--diff-base", "abc123"]));
  });

  it("exit 1 → error", async () => {
    const a = createStrixAdapter({ runId: "r1", spawnFn: scriptedSpawn("boom", 1) });
    const res = await a.run(scope, new AbortController().signal);
    expect(res.status).toBe("error");
    expect(res.error?.kind).toBe("crash");
  });

  it("exit 2 but ZERO parseable findings from non-empty stdout → error (never false no_vulns)", async () => {
    const a = createStrixAdapter({ runId: "r1", spawnFn: scriptedSpawn("noise but no json", 2) });
    const res = await a.run(scope, new AbortController().signal);
    expect(res.status).toBe("error");
  });

  it("stdoutExcerpt is redacted", async () => {
    const a = createStrixAdapter({ runId: "r1", spawnFn: scriptedSpawn(fx("strix-vulns.stdout.txt"), 2) });
    const res = await a.run(scope, new AbortController().signal);
    expect(res.stdoutExcerpt ?? "").not.toContain("sk-abcDEF0123456789ghijklmnop");
  });

  it("abort → status timeout AND issues a docker kill of the tracked container", async () => {
    const invocations: string[][] = [];
    // run child: closes only when killed via the signal; kill child: closes immediately.
    const spawnFn: SpawnFn = ((_cmd: string, args: string[]) => {
      invocations.push(args);
      const child: any = { stdout: { on: () => {} }, stderr: { on: () => {} }, kill: () => {}, _close: null };
      child.on = (ev: string, cb: (code: number | null) => void) => { if (ev === "close") child._close = cb; };
      if (args[0] === "kill") {
        setTimeout(() => child._close && child._close(0), 0); // teardown closes immediately
      } else {
        child.kill = () => child._close && child._close(null); // run child closes only when killed
      }
      return child;
    }) as unknown as SpawnFn;

    const ac = new AbortController();
    const a = createStrixAdapter({ runId: "r1", spawnFn });
    const p = a.run(scope, ac.signal);
    setTimeout(() => ac.abort(), 5);
    const res = await p;
    expect(res.status).toBe("timeout");
    expect(invocations.some((args) => args[0] === "kill")).toBe(true); // docker kill happened
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/security-strix-adapter.test.ts`
Expected: FAIL — cannot resolve `../../src/security/adapters/strix.js`.

- [ ] **Step 3: Write the implementation (`src/security/adapters/strix.ts`)**

```ts
// src/security/adapters/strix.ts — the one real EngineAdapter. Arm's-length via docker run.
import { randomUUID } from "node:crypto";
import type { EngineAdapter, EngineCapabilities, EngineRunResult, ResolvedScope } from "../types.js";
import { spawnCaptured, type SpawnFn } from "./base.js";
import { PINNED_STRIX_IMAGE, containerName, dockerMountArg, dockerRunArgs, dockerInspectArgs } from "../docker.js";
import { parseStrixReport, toFinding, StrixParseError } from "./strix-parse.js";
import { redact } from "../redact.js";
import { createLogger } from "../../logger.js";

const log = createLogger("security");

export const STRIX_CAPABILITIES: EngineCapabilities = {
  id: "strix",
  displayName: "Strix (usestrix/strix)",
  modes: ["sast", "diff"],
  requiresRunningTarget: false,
  supportsDiffScope: true,
  transport: "process",
  license: "Apache-2.0",
};

export interface StrixAdapterDeps {
  runId: string;
  image?: string;
  spawnFn?: SpawnFn;
  envFile?: string; // temp 0600 env-file with LLM_API_KEY/STRIX_LLM (written by the caller)
  instruction?: string;
}

function excerpt(s: string, n = 2000): string {
  return redact(s.length > n ? s.slice(0, n) + "…[truncated]" : s);
}

export function createStrixAdapter(deps: StrixAdapterDeps): EngineAdapter {
  const image = deps.image ?? PINNED_STRIX_IMAGE;
  const name = containerName(deps.runId);

  return {
    capabilities: STRIX_CAPABILITIES,

    async healthCheck() {
      // Docker backend + pinned image both present. (Real invocation happens in run().)
      const fail = (e: Error) => ({ code: 1, stdout: "", stderr: e.message, timedOut: false });
      const info = await spawnCaptured("docker", ["info"], { spawnFn: deps.spawnFn }).catch(fail);
      if (info.code !== 0) {
        return { ok: false, detail: "Docker backend unavailable (docker info failed) — Strix cannot run" };
      }
      const inspect = await spawnCaptured("docker", dockerInspectArgs(image), { spawnFn: deps.spawnFn }).catch(fail);
      if (inspect.code !== 0) {
        return { ok: false, detail: `Strix image not present locally (${image}) — pull the pinned digest first` };
      }
      return { ok: true, detail: `docker ok; image ${image}` };
    },

    async run(scope: ResolvedScope, signal: AbortSignal): Promise<EngineRunResult> {
      const startedAt = new Date().toISOString();
      const t0 = Date.now();
      const args = dockerRunArgs({
        image,
        containerName: name,
        mount: dockerMountArg(scope.targetPath),
        envFile: deps.envFile,
        target: "/src",
        scanMode: scope.scanMode,
        scopeMode: scope.mode,
        diffBase: scope.diffBase,
        instruction: deps.instruction ?? `Scan /src. ${scope.mode === "diff" ? `Only changes since ${scope.diffBase}.` : "Full tree."}`,
      });

      const finish = (partial: Partial<EngineRunResult>): EngineRunResult => ({
        engine: "strix",
        status: "error",
        findings: [],
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
        ...partial,
      });

      let res;
      try {
        res = await spawnCaptured("docker", args, { signal, spawnFn: deps.spawnFn });
      } catch (err) {
        return finish({ status: "error", error: { kind: "unavailable", message: (err as Error).message, retriable: true } });
      }

      if (res.timedOut) {
        // best-effort container teardown
        await spawnCaptured("docker", ["kill", name], { spawnFn: deps.spawnFn }).catch(() => undefined);
        return finish({ status: "timeout", exitCode: res.code ?? undefined, stdoutExcerpt: excerpt(res.stdout), error: { kind: "timeout", message: "scan timed out", retriable: true } });
      }

      const stdoutExcerpt = excerpt(res.stdout);

      if (res.code === 0) {
        return finish({ status: "no_vulns", exitCode: 0, findings: [], stdoutExcerpt });
      }
      if (res.code === 2) {
        let raws;
        try {
          raws = parseStrixReport(res.stdout);
        } catch (err) {
          // zero-reads-as-fact guard: exit 2 but unparseable → error, NEVER a false clean.
          log.error("security: Strix exit=2 but report unparseable", { err: (err as Error).message });
          return finish({ status: "error", exitCode: 2, stdoutExcerpt, error: { kind: "parse", message: (err as Error).message, retriable: false } });
        }
        if (raws.length === 0) {
          return finish({ status: "error", exitCode: 2, stdoutExcerpt, error: { kind: "parse", message: "exit=2 (vulns) but zero findings parsed", retriable: false } });
        }
        const findings = raws.map((r) => toFinding(r, randomUUID()));
        return finish({ status: "vulns_found", exitCode: 2, findings, stdoutExcerpt });
      }
      // exit 1 or anything else
      return finish({ status: "error", exitCode: res.code ?? undefined, stdoutExcerpt, error: { kind: "crash", message: `Strix exited ${res.code}`, retriable: true } });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/security-strix-adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/security/adapters/strix.ts tests/unit/security-strix-adapter.test.ts
git commit -m "feat(security): Strix adapter — exit-code mapping + zero-reads guard + abort→kill"
```

---

### Task 6: Scan orchestrator + default registry

**Files:**
- Create: `src/security/scan.ts`
- Test: `tests/unit/security-scan.test.ts`

**Interfaces:**
- Consumes: `AdapterRegistry`, `EngineId`, `EngineRunResult`, `Finding`, `ResolvedScope` (from `types.js`); `createRegistry` (from `registry.js`); `createStrixAdapter` (from `adapters/strix.js`); `createLogger`.
- Produces:
  - `ScanResult` = `{ results: EngineRunResult[]; findings: Finding[]; degraded: boolean }`
  - `runSecurityScan(registry: AdapterRegistry, engineIds: EngineId[], scope: ResolvedScope, signal: AbortSignal): Promise<ScanResult>`
  - `createDefaultRegistry(deps: { runId: string; envFile?: string }): AdapterRegistry`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/security-scan.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { runSecurityScan } from "../../src/security/scan.js";
import { createRegistry } from "../../src/security/registry.js";
import type { EngineAdapter, EngineId, ResolvedScope, Finding } from "../../src/security/types.js";

const scope: ResolvedScope = { targetPath: "/repo", mode: "full", scanMode: "quick", excludeMatchers: [] };

function finding(id: string): Finding {
  return {
    id, engine: "strix", ruleId: "r", title: "t", description: "d", severity: "high",
    category: "sqli", file: "src/a.ts", fingerprint: id, status: "new", discoveredAt: "t", raw: null,
  };
}

function adapter(id: string, res: Partial<import("../../src/security/types.js").EngineRunResult>): EngineAdapter {
  return {
    capabilities: { id: id as EngineId, displayName: id, modes: ["sast"], requiresRunningTarget: false, supportsDiffScope: true, transport: "process", license: "MIT" },
    async healthCheck() { return { ok: true, detail: "" }; },
    async run() {
      return { engine: id as EngineId, status: "no_vulns", findings: [], startedAt: "t", finishedAt: "t", durationMs: 1, ...res };
    },
  };
}

describe("runSecurityScan", () => {
  it("collects findings from a successful engine, degraded=false", async () => {
    const reg = createRegistry();
    reg.register(adapter("strix", { status: "vulns_found", findings: [finding("a"), finding("b")] }));
    const out = await runSecurityScan(reg, ["strix"] as EngineId[], scope, new AbortController().signal);
    expect(out.findings).toHaveLength(2);
    expect(out.degraded).toBe(false);
    expect(out.results[0].status).toBe("vulns_found");
  });

  it("sets degraded=true when any engine errors, keeping partial findings", async () => {
    const reg = createRegistry();
    reg.register(adapter("strix", { status: "partial", findings: [finding("a")], error: { kind: "crash", message: "x", retriable: true } }));
    const out = await runSecurityScan(reg, ["strix"] as EngineId[], scope, new AbortController().signal);
    expect(out.findings).toHaveLength(1);
    expect(out.degraded).toBe(true);
  });

  it("degraded=true and no throw when an adapter's run() itself rejects", async () => {
    const reg = createRegistry();
    const throwing = adapter("strix", {});
    throwing.run = async () => {
      throw new Error("unexpected");
    };
    reg.register(throwing);
    const out = await runSecurityScan(reg, ["strix"] as EngineId[], scope, new AbortController().signal);
    expect(out.degraded).toBe(true);
    expect(out.findings).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/security-scan.test.ts`
Expected: FAIL — cannot resolve `../../src/security/scan.js`.

- [ ] **Step 3: Write the implementation (`src/security/scan.ts`)**

```ts
// src/security/scan.ts — fan out across engine adapters; never throw for engine failure.
import type { AdapterRegistry, EngineId, EngineRunResult, Finding, ResolvedScope } from "./types.js";
import { createRegistry } from "./registry.js";
import { createStrixAdapter } from "./adapters/strix.js";
import { createLogger } from "../logger.js";

const log = createLogger("security");

export interface ScanResult {
  results: EngineRunResult[];
  findings: Finding[];
  degraded: boolean;
}

/** Register the v1 engines (Strix). Widen here as engines ship. */
export function createDefaultRegistry(deps: { runId: string; envFile?: string }): AdapterRegistry {
  const reg = createRegistry();
  reg.register(createStrixAdapter({ runId: deps.runId, envFile: deps.envFile }));
  return reg;
}

const SUCCESS = new Set<EngineRunResult["status"]>(["no_vulns", "vulns_found"]);

export async function runSecurityScan(
  registry: AdapterRegistry,
  engineIds: EngineId[],
  scope: ResolvedScope,
  signal: AbortSignal,
): Promise<ScanResult> {
  const adapters = registry.resolve(engineIds); // throws on unknown engine (fail-closed config error)
  const settled = await Promise.allSettled(adapters.map((a) => a.run(scope, signal)));

  const results: EngineRunResult[] = [];
  const findings: Finding[] = [];
  let degraded = false;

  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === "fulfilled") {
      const r = s.value;
      results.push(r);
      findings.push(...r.findings);
      if (!SUCCESS.has(r.status)) {
        degraded = true;
        log.warn(`security: engine ${r.engine} degraded (status=${r.status})`);
      }
    } else {
      // adapter.run() should never reject; if it does, treat as a degraded error result.
      degraded = true;
      const id = adapters[i].capabilities.id;
      log.error(`security: engine ${id} threw`, { err: String(s.reason) });
      results.push({
        engine: id,
        status: "error",
        findings: [],
        startedAt: "",
        finishedAt: "",
        durationMs: 0,
        error: { kind: "crash", message: String(s.reason), retriable: true },
      });
    }
  }
  return { results, findings, degraded };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/security-scan.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the FULL suite (regression gate)**

Run: `npm test`
Expected: PASS — all pre-existing tests plus the new engine-layer tests green. `src/security/*` is still imported by nothing outside its own tests.

- [ ] **Step 6: Commit**

```bash
git add src/security/scan.ts tests/unit/security-scan.test.ts
git commit -m "feat(security): multi-engine scan orchestrator + default registry"
```

---

### Task 7: Kill-switch + orphan-container sweep (safety)

**Files:**
- Create: `src/security/killswitch.ts`
- Test: `tests/unit/security-killswitch.test.ts`

**Interfaces:**
- Consumes: `spawnCaptured`, `SpawnFn` (from `./adapters/base.js`); `containerName` (from `./docker.js`); `node:fs`, `node:path`.
- Produces:
  - `isHaltRequested(projectPath: string): boolean` (true if `reports/security/STOP` exists or `ESSAIM_SECURITY_HALT=1`).
  - `sweepOrphanContainers(runId: string, opts?: { spawnFn?: SpawnFn }): Promise<number>` (`docker ps` for `essaim-security-<runId>` → `docker kill` each; returns count killed).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/security-killswitch.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHaltRequested, sweepOrphanContainers } from "../../src/security/killswitch.js";
import type { SpawnFn } from "../../src/security/adapters/base.js";

afterEach(() => {
  delete process.env.ESSAIM_SECURITY_HALT;
});

describe("isHaltRequested", () => {
  it("false when neither the STOP file nor the env flag is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "halt-"));
    expect(isHaltRequested(dir)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
  it("true when ESSAIM_SECURITY_HALT=1", () => {
    const dir = mkdtempSync(join(tmpdir(), "halt-"));
    process.env.ESSAIM_SECURITY_HALT = "1";
    expect(isHaltRequested(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
  it("true when reports/security/STOP exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "halt-"));
    mkdirSync(join(dir, "reports", "security"), { recursive: true });
    writeFileSync(join(dir, "reports", "security", "STOP"), "");
    expect(isHaltRequested(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("sweepOrphanContainers", () => {
  // ps child prints one container id; kill child closes cleanly.
  function spawnFor(psOutput: string, capture: string[][]): SpawnFn {
    return ((_cmd: string, args: string[]) => {
      capture.push(args);
      const child: any = {
        stdout: { on: (_e: "data", cb: (c: string) => void) => { if (args[0] === "ps") setTimeout(() => cb(psOutput), 0); } },
        stderr: { on: () => {} },
        kill: () => {},
        on: (ev: string, cb: (code: number | null) => void) => { if (ev === "close") setTimeout(() => cb(0), 1); },
      };
      return child;
    }) as unknown as SpawnFn;
  }

  it("kills each surviving essaim-security-<runId> container and returns the count", async () => {
    const calls: string[][] = [];
    const n = await sweepOrphanContainers("run-1", { spawnFn: spawnFor("abc123\n", calls) });
    expect(n).toBe(1);
    expect(calls[0]).toEqual(expect.arrayContaining(["ps", "-q"]));
    expect(calls.some((a) => a[0] === "kill" && a.includes("abc123"))).toBe(true);
  });

  it("returns 0 when nothing is running (no kill)", async () => {
    const calls: string[][] = [];
    const n = await sweepOrphanContainers("run-1", { spawnFn: spawnFor("\n", calls) });
    expect(n).toBe(0);
    expect(calls.some((a) => a[0] === "kill")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/security-killswitch.test.ts`
Expected: FAIL — cannot resolve `../../src/security/killswitch.js`.

- [ ] **Step 3: Write the implementation (`src/security/killswitch.ts`)**

```ts
// src/security/killswitch.ts — operator halt + orphan-container teardown (safety).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnCaptured, type SpawnFn } from "./adapters/base.js";
import { createLogger } from "../logger.js";

const log = createLogger("security");

/** Operator kill-switch: a reports/security/STOP file or ESSAIM_SECURITY_HALT=1. */
export function isHaltRequested(projectPath: string): boolean {
  if (process.env.ESSAIM_SECURITY_HALT === "1") return true;
  return existsSync(join(projectPath, "reports", "security", "STOP"));
}

/** Kill any container still named essaim-security-<runId>. Returns how many were killed. */
export async function sweepOrphanContainers(runId: string, opts: { spawnFn?: SpawnFn } = {}): Promise<number> {
  const filter = `name=essaim-security-${runId}`;
  const ps = await spawnCaptured("docker", ["ps", "-q", "--filter", filter], { spawnFn: opts.spawnFn }).catch(() => ({
    code: 1, stdout: "", stderr: "", timedOut: false,
  }));
  const ids = ps.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  let killed = 0;
  for (const id of ids) {
    const r = await spawnCaptured("docker", ["kill", id], { spawnFn: opts.spawnFn }).catch(() => ({ code: 1 } as { code: number }));
    if (r.code === 0) {
      killed++;
      log.warn(`security: swept orphan container ${id} (run ${runId})`);
    }
  }
  return killed;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/security-killswitch.test.ts`
Expected: PASS. (Wiring: Plan 3's `runSecurityPrePhase` calls `isHaltRequested` before scanning and `sweepOrphanContainers` in a `finally`.)

- [ ] **Step 5: Commit**

```bash
git add src/security/killswitch.ts tests/unit/security-killswitch.test.ts
git commit -m "feat(security): operator kill-switch + orphan-container sweep"
```

---

## Self-Review

**1. Spec coverage (spec §4 engine layer, §4.5 license gate, §4.3/§4.4 Strix, §13 pinning):**
- §4.1 file layout: `docker.ts`, `adapters/base.ts`, `registry.ts`, `adapters/strix.ts` (+ `strix-parse.ts` split out for testability), `scan.ts` → Tasks 1–6. ✅
- §4.2 `EngineAdapter`/`EngineCapabilities`/`AdapterRegistry` interfaces (from Plan 1 `types.ts`) implemented → Tasks 3, 5. ✅
- §4.3 failure handling (never reject; status rides result; timeout→**docker kill (tested)**; **zero-from-nonempty→error**; report-shape parse guard) → Task 5. ✅ (Strict version-range gate deferred to a real-version capture — spec §16.)
- §4.4 healthCheck now also runs `docker image inspect` so a missing pinned image yields a clear `ok:false` → engine `skipped` (Task 5). ✅
- §9.3 kill-switch + orphan-container sweep → Task 7. ✅ (`scanMode` from config wired end-to-end via `ResolvedScope.scanMode`, closing the "deep is dead config" gap.)
- §4.4 StrixAdapter: `docker run` only, read-only mount, native diff scope, secrets via env-file, redacted excerpt → Tasks 1, 5. ✅
- §4.5 registry **license gate** (permissive set; AGPL refused) → Task 3. ✅
- §13 image pinned by digest (`PINNED_STRIX_IMAGE`, placeholder digest flagged) → Task 1 + spike note in Task 4. ✅
- Format-dependence isolated into `parseStrixReport` with a capture spike → Task 4. Honestly scoped, not a placeholder: code is complete against a defined contract; the spike verifies/tunes it. ✅
- Deferred to Plan 3: secrets env-file WRITING (the caller/orchestrator side) + `runSecurityScan` invocation + ingest/verify. Deferred to Plan 4: `--secrets-file` CLI plumbing.

**2. Placeholder scan:** `PINNED_STRIX_IMAGE` digest is a clearly-labeled rollout pin (spec §16), not a code placeholder; the parser is complete. No "TODO"/"handle edge cases"/"similar to". Every step shows full code. ✅

**3. Type consistency:** `EngineAdapter`, `EngineCapabilities`, `EngineRunResult`, `ResolvedScope`, `AdapterRegistry`, `Finding`, `Severity`, `EngineId` all sourced from Plan 1 `types.ts`, unchanged. `SpawnFn`/`SpawnResult` declared once in `base.ts` and imported by `strix.ts`. `fingerprint`/`redact` reused from Plan 1. `createStrixAdapter` signature identical across `strix.ts`, `scan.ts` (`createDefaultRegistry`), and the adapter test. `ScanResult` returned by `runSecurityScan` is what Plan 3's ingest consumes. ✅

---

## Downstream plans

- **Plan 3 — Coordinator + verify + orchestrator wiring:** `ingest.ts` (findingToAnnounce/renderPlan chokepoint; POST `/api/announce keep_open` + `/api/register` synthetic author), `verify.ts` (re-scan → verified/reopened, **report-only** — real thread-reopen deferred to v2), the secrets env-file writer, `runSecurityPrePhase` (scope→scan→baseline→ingest), `MiniProject.security` + `RunResult.security`, orchestrator steps 3.5/6, `reporter.ts` section, and the **`claude-stream.ts` env-allowlist** edit.
- **Plan 4 — Surface:** behaviors + `sentinelle` presets, `essaim security` CLI, `init --security`, docs, hermeticity + types-integration guard tests.
