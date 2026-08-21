# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                                    # vitest run — 62 unit files, fileParallelism: false
npm run test:watch
npx vitest run tests/unit/effort.test.ts    # one file
npx vitest run -t "nom du cas"              # one case by name
npm run build                               # tsc → dist/src + dist/cli (rootDir is ".")
npm run dev -- run raid -p ~/proj --dry-run # CLI via tsx, no build step
```

CI (`.github/workflows/test.yml`) runs exactly `npm install && npm test && npm run build` on Node 24. There is no lint or format script — don't invent one.

**CI guard:** the `no-domain-artifacts` job fails any PR that reintroduces client-specific catalog content — it greps every tracked file for the client name and rejects `templates|presets|behaviors|compositions/<client>-*`. The term is spelled out only in `.github/workflows/test.yml`; never repeat it in another tracked file or the guard trips on its own repo. Domain-specific catalog content lives in the private repo, not here.

## Three-repo split

```
essaim (this repo)   catalog + orchestrator + CLI
  ├── @swoofer/promptweave   BCE engine: resolve preset → validate → assemble
  └── mcp-coordinator        server: 26 MCP tools, SQLite, MQTT broker, dashboard :3100
```

promptweave is ours too — if the BCE engine misbehaves, fix it upstream rather than working around it in essaim. Coordination semantics (impact scoring, MQTT topics, `/api/claim-task`) belong to mcp-coordinator; read its README before assuming essaim owns a behavior.

## Prompts are assembled, not written

There are no prompt string literals to edit. An agent's `prompt.md`, `hooks/*.sh` and `.mcp.json` are emitted by promptweave from YAML:

- `behaviors/` (46) — numbered sections: foundation 000-009, patterns 010-029, mission 030-050, transversal 050-099. Section numbers determine final prompt order.
- `presets/` — a role = a list of behaviors + params.
- `compositions/` (3) — rules that rewrite sections when two behaviors co-occur (e.g. `announce+readonly` rewrites section 020).
- `templates/` — a swarm = presets + agent count + phase wiring. `essaim list` shows them.

To change what an agent says, edit the YAML. `--dry-run` previews the assembled result without launching.

## Orchestrator flow

`cli/run-core.ts` is the single path shared by `run` and `pipeline`: scan → build → launch → report. Underneath:

- `src/orchestrator/orchestrator.ts` (38K) — phase scheduler, worktree lifecycle, run loop.
- `src/agent-loop/agent-loop.ts` (55K) — one agent's turn loop; `claude-stream.ts` parses the CLI stream, `coordination-protocol.ts` runs announce → detect → consult → resolve, `mqtt-listener.ts` receives push events between turns, `work-stealing.ts` claims tasks.
- `src/bridge.ts` — the only call site into promptweave.

**Phases** come from an optional `phase:` field on a behavior. `discover` (read-only, no loop) → `review` (no tools, dedups into NEW/DUPLICATE/ENRICHES) → `execute` (full tools, work-stealing loop). A preset with no phased behavior runs one-shot.

**Effort** (`src/agent-loop/effort.ts`) maps a level to model + thinking keyword + maxTurns: low=haiku/none/15, mid=sonnet/think/8, high=opus/think-hard/20, max=opus/ultrathink/60. `critical:` discoveries auto-promote low→mid.

## Security subsystem

`essaim security` (`cli/security.ts`) chains scan → seed coordinator → swarm fixes → verify → report. Engines are out-of-process adapters (`src/security/adapters/`, v1 = Strix).

`src/security/registry.ts` refuses to register any adapter whose license isn't MIT/Apache-2.0/BSD/ISC. This gate is what protects essaim's MIT posture — AGPL/GPL/SSPL engines are invoked out-of-process only, never registered. Don't loosen it.

## Tests

`vitest.config.ts` only picks up `tests/**/*.test.ts`. Shell tests (`tests/*.test.sh`) are bridged into vitest by `tests/unit/shell-scripts.test.ts`, which enumerates the directory — a new `.test.sh` is picked up automatically, no registration needed.

One chmod test is Windows-only and skips on macOS/Linux.

## `ESSAIM_RESET_BASE` is destructive

It holds **the path to reset**, not a boolean. Before creating worktrees it runs `git checkout -- . && git clean -fd` on that path. The value must equal the run's `-p` base; anything else (including the legacy `=1`) is refused with both paths named. Off by default — worktrees snapshot from a git ref, so a dirty base is harmless without it.

## Logging

Pino JSON to stdout. Component loggers: `orchestrator`, `agent-loop`, `phase-scheduler`, `work-stealing`, `effort`, `quota`, `tokens`. `LOG_LEVEL=debug`, pretty via `NODE_ENV=development`. Per-run token report lands in `reports/YYYY-MM-DD-<run-id>.md` (gitignored).
