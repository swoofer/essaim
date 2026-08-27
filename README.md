<div align="center">

# essaim

**Spawn N coordinated Claude Code agents on your repo. Pick a preset, the orchestrator does the rest.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/essaim.svg)](https://www.npmjs.com/package/essaim)
[![Tests](https://github.com/swoofer/essaim/actions/workflows/test.yml/badge.svg)](https://github.com/swoofer/essaim/actions)

</div>

[Problem](#the-problem) · [How it works](#how-it-works) · [Quickstart](#quickstart) · [Architecture](#architecture) · [BCE](#bce--behavior-composition-engine) · [Phases](#work-stealing-phases) · [Effort](#effort-profiles) · [CLI](#cli) · [Templates](#portable-templates) · [Quota](#anthropic-quota-pre-flight) · [Config](#configuration) · [Related](#related-projects)

---

## The Problem

When multiple developers each use an AI coding agent in parallel on the same repo, things break:

- **Regressions** — Agent A rewrites a module that Agent B was depending on
- **Duplicated work** — Two agents implement the same feature from different directions
- **Architectural drift** — Agents make local decisions that conflict with each other's designs
- **Wasted reconciliation time** — Developers spend hours untangling what the agents did

Each agent works in isolation. None of them know what the others are doing.

essaim fixes this by giving agents a **shared nervous system** — they announce intentions before coding, conflicts are detected before a single line is written, and agents see each other's actions in real-time to agree on an approach.

---

## How It Works

```
Developer A                    Developer B
    |                               |
    |  announce_work                |  announce_work
    v                               v
+--------------+              +--------------+
|  Agent α     |  <-- MQTT -->|  Agent β     |
|  (essaim)    |   push-based |  (essaim)    |
+--------------+              +--------------+
        |         MCP HTTP / SSE        |
        +---------------+---------------+
                        |
             +----------v----------+
             |     mcp-coordinator |
             |  MCP tools + SQLite |
             |  MQTT broker        |
             +---------------------+
```

The consultation cycle — **announce → detect → consult → resolve** — runs in the agent-loop without a sidecar. Agents call `announce_work` before coding; the coordinator scores impact and opens a thread on score ≥ 90; MQTT pushes the thread to affected peers between turns; the thread closes on consensus, timeout, or gray-zone auto-resolve.

essaim ships the orchestrator (agent-loop, preset runner, phase scheduler) and the behavior catalog (46 behaviors, 29 presets, 3 composition rules). The coordination server lives in [`mcp-coordinator`](https://github.com/swoofer/mcp-coordinator#readme); the prompt assembly engine in [`@swoofer/promptweave`](https://github.com/swoofer/promptweave#readme). essaim wires them together and ships the CLI.

---

## Quickstart

### Prerequisites

- Node.js >= 22
- `claude` CLI on PATH (install from [claude.ai/code](https://claude.ai/code))
- `ANTHROPIC_API_KEY` environment variable set

### Install

```bash
npm install -g essaim
```

### Run your first swarm

```bash
# Initialize your project (installs hooks + MCP config)
essaim init ~/my-project

# Launch 3 coordinated agents on a bug hunt
essaim run swarm -p ~/my-project --agents 3

# Or run a single agent without orchestration
essaim solo gardien -p ~/my-project
```

> **No coordinator to start by hand.** `essaim run` — and `essaim pipeline` / `essaim security`, which go through the same path — boots `mcp-coordinator` **in-process on port `3100`** (override with the `PORT` env var) and shuts it down when the run ends. If something is already listening on `3100`, point essaim at it instead; otherwise the run dies on `EADDRINUSE` before the first agent starts:
>
> ```bash
> essaim run swarm -p ~/my-project --agents 3 --coordinator-url http://127.0.0.1:3100
> ```
>
> `essaim solo` is different: it runs the agent in `solo_mode` and starts no coordinator at all.

> The `swarm` preset runs discover → execute phases. Agents discover issues in read-only mode, share findings via the coordinator, then work-steal tasks from the shared pool until the pool is drained.

---

## Architecture

```
essaim (this package)
  |
  +-- @swoofer/promptweave   (BCE engine: assembles prompts from YAML behaviors)
  |
  +-- mcp-coordinator        (coordination server: MCP tools, SQLite, MQTT broker, dashboard)
```

essaim owns the **catalog** (46 behaviors, 29 presets, 3 composition rules, 7 hook scripts), the **orchestrator** (phase scheduler, effort router, work-stealing loop), and the **CLI**. `@swoofer/promptweave` owns the BCE engine (resolver, validator, assembler). `mcp-coordinator` owns everything coordination-side: 26 MCP tools, impact scoring, MQTT broker + topic protocol, SQLite, and the dashboard at `http://localhost:3100/dashboard`.

**For the tool reference, scoring layers, MQTT topics, dashboard panels, and server-side config, read [mcp-coordinator's README](https://github.com/swoofer/mcp-coordinator#readme).** This file documents only essaim's own surface.

---

## BCE — Behavior Composition Engine

Every agent prompt, hook, and MCP config is **assembled, not written**. essaim ships a catalog of reusable YAML modules; `@swoofer/promptweave` resolves the preset, validates, composes, and emits `prompt.md` + `hooks/*.sh` + `.mcp.json` for each agent.

```
46 behaviors    29 presets    3 composition rules    7 hook scripts    3 workflow phases
```

### Three behavioral layers

Behaviors contribute numbered sections that sort deterministically into a final prompt.

| Layer | Sections | Responsibility | Sample behaviors |
|-------|----------|----------------|------------------|
| Foundation | 000-009 | Who I am, which project | `project-context`, `user-brief`, `coordinator-rules` |
| Patterns | 010-029 | How I coordinate | `announce-before-write`, `conflict-resolution`, `worktree-isolation`, `sequential-wait` |
| Mission | 030-050 | What I actually do | bug-hunting, test-writing, refactoring, code-review, debate, quiz, translation, sequential pipelines — 21 in total |
| Transversal | 050-099 | Constraints and style | `activity-tracking`, `read-only-mode`, `audit-output` |

### Composition rules

Three rules adapt behaviors automatically based on what's assembled.

| Rule | Trigger | Action |
|------|---------|--------|
| `announce-readonly-adaptation` | `announce-before-write` + `read-only-mode` | Section 020 becomes "before your analysis" instead of "before modifying" |
| `sequential-then-announce` | `sequential-wait` + `announce-before-write` | Injects section 012: "wait -> announce -> code" |
| `solo-mode-strip` | `coordinator-rules.solo_mode = true` | Strips announce / conflict-resolution entirely; agent works alone |

### Gating a sequential pipeline on artifacts

A resolved thread does not prove the predecessor's file is on disk: resolution and
writing are not ordered, and the coordinator's timeout sweeper can resolve a thread
that produced nothing at all. Gate on the artifact, not the status — give
`sequential-wait` the files you expect and it will poll for them before treating an
input as missing:

```yaml
params:
  sequential-wait:
    expect_files: ["tmp/decouverte/features.yaml", "tmp/decouverte/risques.yaml"]
    retry_attempts: 3        # default
    retry_delay_seconds: 10  # default
```

The producing side owes the other half of the contract: **write the artifact, read it
back, and only then resolve** — a mission prompt that resolves before it writes will
have its output silently dropped by the consumer.

List the templates the CLI ships with via `essaim list`. To preview what a template assembles (prompt + agent plan) without burning tokens, use `essaim run <template> --dry-run`. Behaviors, presets, and composition rules live under [`behaviors/`](./behaviors/), [`presets/`](./presets/), and [`compositions/`](./compositions/) in this repo — browse them directly to author or edit.

### Read-only audits with a fixed write surface

`read-only-mode` is strict: agents read, analyze, and communicate via MCP threads, but write nothing — no `Write`, no `Edit`, no created files. To carve out an exception for a specific audit report (without lifting the rest of the no-write fence), pair it with `audit-output`:

```bash
essaim solo gardien -p . \
  --set 'audit-output.paths=["MIGRATION_AUDIT.md","docs/risks.md"]'
```

`gardien` ships with `audit-output.paths = ["AUDIT.md"]` by default; override with `--set` for any other artifact path. The pair (`read-only-mode` + `audit-output`) renders as "no writes — except these exact paths". Presets that need pure read-only communication (`debat`, `revue-reviewer`, `chaine-review`, `arene-*`) include only `read-only-mode` and write nothing at all.

### Briefing a run with free-form context

Every preset includes the `user-brief` behavior in slot `001-user-brief` (right after project identity, before any coordination rules). It's a free-form "system-prompt prefix" the operator can fill at launch time, no preset edit required. Both fields are optional — when neither is set, nothing renders.

```bash
essaim run raid -p . --agents 3 \
  --set user-brief.brief='We are migrating the checkout from Stripe v3 to v4. Payment-touching code under src/payments/ must NOT be modified without a feature flag.' \
  --set user-brief.constraints='["No breaking changes to /api/v1/*","Keep Node 18 compat","Each agent commits in its own worktree, no cross-merge"]'
```

The brief lands once per agent prompt and is visible across every phase (discover / review / execute) because `user-brief` is not phase-tagged. Confirm with `essaim run <template> --dry-run` (the assembled prompt size will jump by the brief's length).

**Dispatch caveat (`maitre`, `revue`)**: in lead/worker presets, the lead's brief does NOT auto-propagate to dispatched workers — the dispatch travels through `announce_work(plan: ...)`, not through the worker's prompt. Set the brief on the worker preset too (`maitre-worker`, `revue-reviewer`) — every agent reads its own copy.

---

## Work-stealing Phases

BCE behaviors can declare an optional `phase`. When a preset contains phased behaviors, the orchestrator executes each phase sequentially with different tool permissions.

```
 PHASE      TOOLS       LOOP   PURPOSE
 -----------------------------------------------------------------
 discover   read_only   no     Scan code, list findings
 review     none        no     Dedup against existing threads
 execute    full        yes    Work-stealing — one task at a time
 (no phase) full        no     One-shot (backward-compat)
```

Tasks stay `open` (`keep_open: true`) until atomically claimed via the coordinator's `/api/claim-task`. MQTT pushes `claimed` / `completed` between turns; agents back off (3×10s grace) before declaring the pool drained. Crashed agents have claims auto-released on heartbeat timeout. `phase-review` dedups discoveries into `NEW | DUPLICATE | ENRICHES` before they hit the pool.

---

## Effort Profiles

Model selection is phase-aware: each phase requests an effort level, the orchestrator maps it to a model + thinking keyword + turn budget. `critical:` discoveries auto-promote `low` to `mid`. Lead-worker presets propagate the level into dispatched prompts. Per-phase overrides supported (`phase-discover.effort=mid`).

| Level | Model | Thinking | maxTurns | Cost | Use case |
|-------|-------|----------|---------:|------|----------|
| `low` | `claude-haiku-4-5` | none | 15 | $ | Coordination chatter, trivial review |
| `mid` | `claude-sonnet-4-6` | `think` | 8 | $$ | Discover, standard execute, dispatched work |
| `high` | `claude-opus-4-6` | `think-hard` | 20 | $$$ | Complex execute with thinking headroom |
| `max` | `claude-opus-4-6` | `ultrathink` | 60 | $$$$ | Architecture debates, deep reasoning |
| `auto` | resolved by context | — | — | — | `read_only`/no-tools -> low; loop -> high; else mid |

---

## CLI

essaim ships a CLI binary. All commands:

| Command | Description |
|---------|-------------|
| `essaim run <template> [-p path] [--agents N] [--timeout min] [--set k=v] [--set-file k=path] [--dry-run] [--base-ref ref] [--coordinator-url url] [--max-quota-pct pct] [--cleanup]` | Launch coordinated agents using a template. `--dry-run` previews the assembled prompts + agent plan without launching. `--set-file behavior.param=path` reads the param value verbatim from a file (no shell quoting, wins over `--set` on conflict). |
| `essaim pipeline -f <file> [--coordinator-url url] [--max-quota-pct pct] [--dry-run]` | Run a sequence of template runs across per-step repos, strictly sequential, stop on first failure. See [Pipelines](#pipelines). |
| `essaim solo <template> [-p path] [--timeout min] [--set k=v] [--set-file k=path]` | Launch a single agent without orchestration |
| `essaim scan <path>` | Auto-detect project language, structure, test framework |
| `essaim security [-p path] [--engine list] [--scan-mode mode] [--scope-mode mode] [--diff-base ref] [--authorize] [--secrets-file path] [--scan-timeout min] [--no-require-findings] [--triage-only] [--agents N] [--timeout min] [--cleanup] [--dry-run] [--coordinator-url url]` | Scan for security findings, seed the coordinator, and let the swarm fix them (auto-fix on branches). Runs the `sentinelle` template; engines are out-of-process adapters (v1: Strix). |
| `essaim init [path] [--url url] [--name name] [--modules list] [--security]` | Install hooks + MCP config on a project. `--security` also scaffolds the security config + `.gitignore`. |
| `essaim list` | List the templates the CLI ships with |
| `essaim self-update` | Update the native binary to the latest release (macOS/Linux). On Windows it refuses and prints the manual route — `npm install -g essaim@latest`, or the `win32-x64` tarball — because Windows locks the running executable. |

### Examples

```bash
essaim scan ~/my-project                            # detect language, tests, modules
essaim run raid -p ~/my-project --dry-run           # preview assembled prompts, no launch
essaim run raid -p ~/my-project --agents 3          # bug hunt
essaim run swarm -p ~/my-project --agents 4         # refactoring
essaim solo gardien -p ~/my-project                 # read-only audit
essaim run raid -p ~/my-project --set bug-hunting.modules='["src/auth"]'
```

---

## Pipelines

Chain several template runs across different repos in one command. Each step is an
`essaim run` on its own project path (same `--set` / `--set-file` / `--modules`
handling), with optional shell hooks around it. Steps run **strictly sequentially**
and the pipeline **stops on the first failure** (a non-zero step, before-hook, or
after-hook); remaining steps are recorded as `skipped`.

```yaml
# pipeline.yaml — paths are relative to this file's directory
name: audit-then-migrate
steps:
  - name: audit
    template: phare
    project: ../legacy
    set:
      audit-output.paths: '["MIGRATION_AUDIT.md"]'
    set_file:
      user-brief.brief: tmp/brief-audit.txt        # value read verbatim, wins over set
    timeout_minutes: 20
  - name: migrate
    template: migrate-phase2
    project: ../web
    modules_file: tmp/migrate/slices.txt           # one id per line — or modules: [a, b]
    set_file:
      user-brief.brief: tmp/brief-migrate.txt
    hooks:
      before: ["cp ../legacy/MIGRATION_AUDIT.md tmp/migrate/audit.md"]
      after: ["npm run build"]                      # non-zero after-hook fails the step
```

```bash
essaim pipeline -f pipeline.yaml --dry-run                    # preview every step, no launch
essaim pipeline -f pipeline.yaml --coordinator-url http://localhost:3100
```

Hooks run with `cwd` = the step's `project`. A consolidated report
(`reports/pipeline-<name>-<timestamp>.md`, next to the pipeline file) lists each
step's status, duration, and hook failures; the command exits `1` if any step failed.
Not in v1: parallel steps, conditionals, artifact templating — that judgment stays in the caller.

---

## Portable Templates

Language-agnostic templates. `essaim scan` auto-detects the stack; the template generates prompts tuned to the result.

| Template | Pattern | Agents | Phases |
|----------|---------|--------|--------|
| `raid` | Bug hunt | 2-3 | discover -> execute |
| `melee` | Parallel test writing | 2-6 | discover -> execute |
| `swarm` | Volume refactoring | 3-6 | discover -> execute |
| `chaine` | Sequential pipeline | 3 | one-shot, staggered |
| `relais` | Relay improvements | 3 | one-shot, staggered |
| `revue` | Authors + cross reviewers | 4-8 | one-shot |
| `maitre` | Lead + workers | 3-5 | one-shot (lead dispatches) |
| `gardien` | Read-only audit | 1 | one-shot |
| `debat` | Architecture debate | 3 | one-shot, keep_open |
| `arene` | Code quiz / trivia | 3 | one-shot, keep_open |
| `carrefour` | Intentional conflict test | 2-3 | one-shot |
| `babel` | Documentation translation | 2 | sequential |
| `phare` | 4 audit specialists + reconciler | 5 | one-shot, staggered |
| `sentinelle` | Fixes security findings ingested in the coordinator | dynamic | one-shot |
| `migrate-phase2` | Scaffolder, then one migrator per slice | 1 + per-module | one-shot, staggered |

For per-template descriptions, run `essaim list`. The preset roles each template wires together are declared in [`templates/`](./templates/) and defined in [`presets/`](./presets/) in this repo.

---

## External Catalogs

The bundled catalog is a starting point, not a ceiling. essaim resolves behaviors, presets, templates, compositions and scripts across several catalog roots — **the last one wins**:

```
bundled  <  ESSAIM_CATALOG  <  --catalog  <  <project>/.essaim
```

From the most general to the most local. The explicit flag beats the ambient environment — an `ESSAIM_CATALOG` exported months ago must not quietly outrank what you just typed — and a project's own `.essaim/` beats everything.

```bash
ESSAIM_CATALOG=~/catalogs/house-style essaim run raid -p ~/my-app
essaim run raid -p ~/my-app --catalog ~/catalogs/client-a --catalog ~/catalogs/client-b
```

`ESSAIM_CATALOG` accepts several paths separated by the platform's path delimiter (`:` on POSIX, `;` on Windows). `--catalog` is repeatable. A catalog root holds any subset of `behaviors/`, `presets/`, `templates/`, `compositions/`, `scripts/` — missing subdirectories are skipped, so a catalog that only overrides two behaviors is valid.

A catalog you **name** and that does not exist is a hard error, never a silent no-op: the typo would otherwise resurface two screens later as an opaque `Unknown template`.

---

## Anthropic Quota Pre-flight

`run` and `solo` check your Anthropic workspace quota before launching N agents, to avoid 429 storms mid-session.

```bash
essaim run raid -p ~/my-app --agents 4 --max-quota-pct 90
# Aborts if workspace utilization >= 90%
```

- Reads usage from the Anthropic API using the key in the environment.
- Threshold via `--max-quota-pct` flag or `MAX_QUOTA_PCT` env var (default `95`).
- Back-off when the usage endpoint itself returns 429.

essaim emits the resulting `token_usage` and `quota_update` events to the coordinator; the dashboard widget is rendered by mcp-coordinator.

---

## Token Observability

Every agent turn is logged via the `tokens` component logger (`input_tokens`, `output_tokens`, `cache_read`, `cache_creation`, `thinking`, model, turn index). A per-run `reports/YYYY-MM-DD-<run-id>.md` aggregates totals by agent / phase / effort, and surfaces `deduped: N` from `phase-review`. Live gauges live in the mcp-coordinator dashboard.

---

## Configuration

`essaim init` writes a per-project `.claude/` (`.coordinator-env`, `settings.json` for MCP registration, BCE-assembled `hooks/`). The variables essaim itself reads are below; server-side `COORDINATOR_*` env vars belong to mcp-coordinator (see its README).

| Variable | Example |
|----------|---------|
| `COORDINATOR_URL` | `http://localhost:3100` |
| `COORDINATOR_AGENT_ID` / `_NAME` / `_MODULES` | `alice-12345` · `Alice` · `src/auth,src/users` |
| `MAX_QUOTA_PCT` | `95` (overrides the pre-flight default) |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` |
| `ESSAIM_RESET_BASE` | `/tmp/essaim-sandbox` — **destructive**, see below |

### `ESSAIM_RESET_BASE` — destructive, and it names its own target

Before creating worktrees, essaim can reset the base checkout with `git checkout -- .` followed by `git clean -fd`. That discards every uncommitted change and every untracked file in that directory. It is off by default.

The variable holds **the path to reset**, and that path must match the run's base — it is not a boolean:

```bash
ESSAIM_RESET_BASE=/tmp/essaim-sandbox essaim run raid -p /tmp/essaim-sandbox
```

Any other value, including the old `=1`, is refused with an error naming both the directory you authorized and the one the run would actually reset. You cannot destroy a directory you did not name, which is the entire point: the previous boolean form authorized the wipe without saying what it applied to, so a stray `-p` was enough to lose uncommitted work.

You rarely need this. `git worktree add` snapshots from a git ref, so worktrees are unaffected by a dirty base — without the opt-in essaim just logs a warning and carries on.

Resolution priority: CLI flag → env var → `config.json` → default. If the coordinator has JWT auth on, `essaim init` provisions a token into `.coordinator-env` and essaim attaches it to every MCP HTTP and MQTT request automatically.

---

## Structured Logging

JSON to stdout via [Pino](https://getpino.io/). Component loggers: `orchestrator`, `agent-loop`, `phase-scheduler`, `work-stealing`, `effort`, `quota`, `tokens`. Control verbosity with `LOG_LEVEL=debug|info|warn|error`; pretty-print with `NODE_ENV=development`.

---

## Development

```bash
# Tests
pnpm test              # 709/710 unit tests pass on macOS/Linux; one Windows-only chmod test is skipped there
pnpm test:watch

# CLI in dev
pnpm dev -- list
pnpm dev -- run raid -p ~/my-project --dry-run

# Build
pnpm build
```

essaim is exercised by its own catalog — the `swarm` template was used to refactor essaim's own source during development, producing a working dogfood loop.

---

## Related Projects

| Package | Role |
|---------|------|
| [`mcp-coordinator`](https://github.com/swoofer/mcp-coordinator) | Coordination server: 26 MCP tools, SQLite, embedded MQTT broker, live dashboard. essaim agents talk to it over MCP HTTP; push events arrive over MQTT. |
| [`@swoofer/promptweave`](https://github.com/swoofer/promptweave) | BCE engine: resolves presets, validates behavior YAML, composes outputs. essaim feeds it the catalog; promptweave returns prompt.md, hooks, and MCP config. |

---

## Support

Solo maintainer. If this project saves you time, consider supporting development:

- [GitHub Sponsors](https://github.com/sponsors/swoofer)
- [Buy Me A Coffee](https://buymeacoffee.com/swoofer)

A star on the repo also helps surface the project to other developers.

---

## License

MIT
