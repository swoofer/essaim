# Strix Adapter — Real Invocation & Output Design (follow-up to PR #70)

**Status:** design, grounded in Strix source (`usestrix/strix@main`, strix-agent v1.3.1). Replaces the placeholder/assumed Strix adapter model from PR #70 (which was built before a real capture and got the invocation + output format wrong).

**Why:** the v1 subsystem shipped with a Strix adapter that (wrongly) `docker run`s a `usestrix/strix@sha256:PLACEHOLDER` image and parses a fenced ```json block from stdout. Verified against Strix source, that model is wrong on three counts (below). This rewrite makes the adapter match real Strix. Operator LLM key is needed only for the final **live validation**, not for the code (schema is verified from source).

---

## Verified reality (from Strix source)

1. **Strix is a host CLI, not a `docker run` image.** `pip install strix-agent` → command `strix` runs on the host and internally pulls + drives a **sandbox** image via the Docker SDK. There is no runnable `usestrix/strix` image.
   - Sandbox image (pinnable): `ghcr.io/usestrix/strix-sandbox` (default tag `1.1.0`), overridable via env `STRIX_IMAGE`. Backend env `STRIX_RUNTIME_BACKEND=docker` (default).
   - **Pinned digest (captured 2026-07-23 via `docker buildx imagetools inspect`):**
     `ghcr.io/usestrix/strix-sandbox@sha256:812c42ca0332a25e7a8d87c091a33b5fee722e5b13b370dda29a33e4e26968b6` (multi-arch OCI index; resolves per-platform to amd64 `474775b2…` / arm64 `fa55ca09…`).
   - Prereq for the operator: `pip install strix-agent` (Python ≥3.12) + a running Docker daemon.

2. **Output is FILES, not stdout JSON.** `-n/--non-interactive` prints human Rich console text + a final report, then exits with the code. Machine-readable artifacts are written to `./strix_runs/<run-name>/` (relative to cwd):
   - `vulnerabilities.json` — a top-level **JSON array** of report dicts (primary, rich).
   - `findings.sarif` — **SARIF 2.1.0** (normalized, GitHub code-scanning compatible).
   - also `penetration_test_report.md`, `vulnerabilities.csv`, `vulnerabilities/<id>.md`, `run.json`.
   - No `--output`/`--format` flag; the run-name is auto-generated → the adapter runs Strix in a controlled temp cwd and reads the single/newest `strix_runs/<run>/` subdir.

3. **Finding schema (`vulnerabilities.json` array element):** `id` (`"vuln-0001"`, not `rule_id`), `title`, `severity` (CVSS-derived: `critical|high|medium|low`, tolerate `info`/`none`), `timestamp`, and when non-empty: `description`, `impact`, `target`, `technical_analysis`, `poc_description`, `poc_script_code`, `remediation_steps`, `evidence`, `assumptions`, `fix_effort`, `cvss` (float), `cvss_breakdown`, `endpoint`, `method`, `cve` (`CVE-…`), `cwe` (`CWE-…`), `code_locations` (array of `{file, start_line, end_line, snippet, label, fix_before, fix_after}` — **file/line live HERE**, not top-level), `finding_class` (`dynamic|static`), etc. No `category`.

4. **Exit codes (confirmed):** `0` = no vulns, `1` = error (incl. config/missing-env), `2` = vulns found (**only in `-n` mode**).

5. **Invocation:** `strix -n -t <target> -m <quick|standard|deep> [--scope-mode diff --diff-base <ref>] [--instruction <text>]`. Required env: `STRIX_LLM` (e.g. `openai/gpt-5.4` or `anthropic/claude-sonnet-4-6`) + `LLM_API_KEY`. `--target` accepts a path/URL/repo/domain/IP. `-m/--scan-mode` default is `deep` (values `quick|standard|deep`).

---

## Rewrite design

**Decision (operator-chosen): parse BOTH** — `vulnerabilities.json` primary (rich → `Finding`), `findings.sarif` as the normalized cross-engine layer (v2 dedup / multi-engine north star).

### Tasks
1. **Config/types:** `scan_mode` enum → `quick | standard | deep` (add `standard`; default stays `quick` for the security preset's diff scans). Update `SecurityConfig`, `ResolvedScope.scanMode`, `validateSecurityConfig`, config tests.
2. **`strix-parse.ts` rewrite:**
   - `parseStrixVulnerabilitiesJson(text): Finding[]` — parse the array; map `id`→`engineFindingId`+`ruleId`, `title`, `description` (compose from description/impact/technical_analysis, redacted), `severity` via `mapSeverity`, `cwe`, `file`/`line` from `code_locations[0].{file,start_line}`, `category` derived (from `finding_class`/cwe slug), `evidence` (redacted, from `evidence`/`poc_description`), `remediation` from `remediation_steps`, `fingerprint`.
   - `parseStrixSarif(text): Finding[]` — parse `runs[].results[]`: `ruleId`, `level`→severity (error→high, warning→medium, note→low) + `properties["security-severity"]` for finer CVSS, `locations[0].physicalLocation` → file/line, `message.text`.
   - `reconcile(jsonFindings, sarifFindings): Finding[]` — primary = json; use SARIF to backfill file/line when `code_locations` empty and to attach a normalized SARIF view. Keep the zero-reads guard (exit 2 but empty/absent files → error).
   - Fixtures: realistic `strix_runs/<run>/vulnerabilities.json` + `findings.sarif` at the real schema.
3. **CLI invocation (`strix-cli.ts`, replacing the docker-run model in `docker.ts`):** `strixCliArgs(scope, opts): string[]`; `strixEnv(secrets, image): Record<string,string>` (STRIX_LLM, LLM_API_KEY, STRIX_IMAGE=pinned digest, STRIX_RUNTIME_BACKEND). Keep `docker info`/image-inspect helpers for healthCheck of the sandbox daemon.
4. **`strix.ts` adapter:** `run(scope, signal)` spawns `strix` (via `spawnCaptured`, cwd = a fresh temp workdir; secrets in process env not an --env-file), maps exit 0/1/2, then locates the newest `strix_runs/<run>/` and reads+parses `vulnerabilities.json` (+ `findings.sarif`). `healthCheck`: `strix --version` (CLI installed → else ok:false "pip install strix-agent") + `docker info` (daemon).
5. **Wiring:** secrets now flow to the strix process env (not a docker `--env-file`); update `createDefaultRegistry`/pre-phase secret passing accordingly (the temp env-file mechanism can be dropped for Strix, or kept as the source `resolveEngineSecrets` reads to build the process env).
6. **Docs:** update `docs/security/*` — Strix is invoked as a host CLI (prereq `pip install strix-agent`), sandbox pinned via `STRIX_IMAGE` digest; the `PINNED_STRIX_IMAGE` placeholder is replaced by the real sandbox digest.
7. **Live validation (needs operator LLM key):** run one real `strix -n -t <throwaway target> -m quick` with the operator's `STRIX_LLM`+`LLM_API_KEY`, capture the real `vulnerabilities.json`/`findings.sarif`, diff against the fixtures, and adjust field mapping if reality differs from the source-derived schema.
   - Capture the real Strix sandbox container name/label from a live run and wire an effective orphan/timeout cleanup (current `sweepOrphanContainers` targets the removed essaim-managed naming and is a no-op for Strix-managed sandboxes).

### Non-goals (unchanged from v1)
HexStrike/PentAGI, dynamic/DAST beyond what Strix does, cross-engine dedup (SARIF normalization lays the groundwork but dedup is v2).
