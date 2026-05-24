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

essaim ships the orchestrator (agent-loop, preset runner, phase scheduler) and the behavior catalog (32 behaviors, 21 presets, 3 composition rules). The coordination server lives in [`mcp-coordinator`](https://github.com/swoofer/mcp-coordinator#readme); the prompt assembly engine in [`@swoofer/promptweave`](https://github.com/swoofer/promptweave#readme). essaim wires them together and ships the CLI.

---

## Quickstart

### Prerequisites

- Node.js >= 20
- `claude` CLI on PATH (install from [claude.ai/code](https://claude.ai/code))
- `ANTHROPIC_API_KEY` environment variable set

### Install

```bash
npm install -g essaim
```

### Start the coordinator

essaim delegates all coordination state to `mcp-coordinator`. Start it once:

```bash
mcp-coordinator server start --daemon
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

essaim owns the **catalog** (32 behaviors, 21 presets, 3 composition rules, 6 hook scripts), the **orchestrator** (phase scheduler, effort router, work-stealing loop), and the **CLI**. `@swoofer/promptweave` owns the BCE engine (resolver, validator, assembler). `mcp-coordinator` owns everything coordination-side: 26 MCP tools, impact scoring, MQTT broker + topic protocol, SQLite, and the dashboard at `http://localhost:3100/dashboard`.

**For the tool reference, scoring layers, MQTT topics, dashboard panels, and server-side config, read [mcp-coordinator's README](https://github.com/swoofer/mcp-coordinator#readme).** This file documents only essaim's own surface.

---

## BCE — Behavior Composition Engine

Every agent prompt, hook, and MCP config is **assembled, not written**. essaim ships a catalog of reusable YAML modules; `@swoofer/promptweave` resolves the preset, validates, composes, and emits `prompt.md` + `hooks/*.sh` + `.mcp.json` for each agent.

```
32 behaviors    21 presets    3 composition rules    6 hook scripts    3 workflow phases
```

### Three behavioral layers

Behaviors contribute numbered sections that sort deterministically into a final prompt.

| Layer | Sections | Responsibility | Sample behaviors |
|-------|----------|----------------|------------------|
| Foundation | 000-009 | Who I am, which project | `project-context`, `coordinator-rules` |
| Patterns | 010-029 | How I coordinate | `announce-before-write`, `conflict-resolution`, `worktree-isolation`, `sequential-wait` |
| Mission | 030-050 | What I actually do | bug-hunting, test-writing, refactoring, code-review, debate, quiz, translation, sequential pipelines — 21 in total |
| Transversal | 050-099 | Constraints and style | `activity-tracking`, `read-only-mode` |

### Composition rules

Three rules adapt behaviors automatically based on what's assembled.

| Rule | Trigger | Action |
|------|---------|--------|
| `announce-readonly-adaptation` | `announce-before-write` + `read-only-mode` | Section 020 becomes "before your analysis" instead of "before modifying" |
| `sequential-then-announce` | `sequential-wait` + `announce-before-write` | Injects section 012: "wait -> announce -> code" |
| `solo-mode-strip` | `coordinator-rules.solo_mode = true` | Strips announce / conflict-resolution entirely; agent works alone |

Inspect the catalog with `essaim list behaviors` / `essaim list presets`; preview an assembled prompt with `essaim bce build <preset> --dry-run`.

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
| `essaim run <template> [-p path] [--agents N] [--timeout min] [--set k=v] [--dry-run] [--base-ref ref] [--max-quota-pct pct]` | Launch coordinated agents using a template |
| `essaim solo <template> [-p path] [--timeout min] [--set k=v]` | Launch a single agent without orchestration |
| `essaim scan <path>` | Auto-detect project language, structure, test framework |
| `essaim init [path] [--url url] [--name name] [--modules list]` | Install hooks + MCP config on a project |
| `essaim list [behaviors\|presets\|compositions]` | List catalog entries |
| `essaim self-update` | Update to the latest release |
| `essaim bce build <preset> [--dry-run] [--set k=v]` | Assemble a prompt from a preset |
| `essaim bce list <type>` | List behaviors, presets, or compositions |
| `essaim bce validate [file] [--all]` | Validate BCE YAML files |

### Examples

```bash
essaim scan ~/my-project              # detect language, tests, modules
essaim run raid -p ~/my-project --agents 3      # bug hunt
essaim run swarm -p ~/my-project --agents 4     # refactoring
essaim solo gardien -p ~/my-project              # read-only audit
essaim bce build raid --dry-run --set coordinator-rules.solo_mode=true  # preview
```

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

For per-template descriptions and the preset roles each one wires together, run `essaim list presets` or read [`compositions/`](./compositions/) in this repo.

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

Resolution priority: CLI flag → env var → `config.json` → default. If the coordinator has JWT auth on, `essaim init` provisions a token into `.coordinator-env` and essaim attaches it to every MCP HTTP and MQTT request automatically.

---

## Structured Logging

JSON to stdout via [Pino](https://getpino.io/). Component loggers: `orchestrator`, `agent-loop`, `phase-scheduler`, `work-stealing`, `effort`, `quota`, `tokens`. Control verbosity with `LOG_LEVEL=debug|info|warn|error`; pretty-print with `NODE_ENV=development`.

---

## Development

```bash
# Tests
npm test              # 302/303 unit tests pass on macOS/Linux; one Windows-only chmod test is skipped there
npm run test:watch

# CLI in dev
npm run dev -- list
npm run dev -- run raid -p ~/my-project --dry-run

# Build
npm run build
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
