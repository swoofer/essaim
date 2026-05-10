# Contributing to essaim

Thanks for considering a contribution.

## Contributor License Grant

By submitting a pull request, comment with code suggestion, or any other contribution to this repository, you certify that:

1. The contribution is your original work, **or** you have explicit permission from the rights holder to submit it.
2. Your contribution is licensed under the [MIT License](./LICENSE), same as the rest of the project.
3. You grant the project maintainer (Maxime Gagnon) and successors a **perpetual, irrevocable, worldwide, royalty-free right** to relicense your contribution under different terms in future versions of the project, including more restrictive or commercial licenses (e.g. BSL, AGPL, source-available, dual-license).

### Why the relicense grant?

The project is MIT today and is expected to stay MIT for the foreseeable future. The grant preserves the **option** to dual-license or pivot to a source-available license later if adoption sustains a commercial track. It does **not** change the terms under which you can use, fork, or redistribute the project as it exists today — all released versions remain MIT, forever.

If your employer's IP policy or your own preference makes this grant unacceptable, please open an issue **before** opening a PR so we can discuss.

This grant is on the same model used by Sentry, HashiCorp, and similar projects before they pivoted to source-available licenses. It is functionally a lightweight inbound-license-grant — no separate CLA signature required; acceptance is by act of contribution.

## Reporting bugs

Open an issue with the "bug" template. Include the version (`essaim --version`) and a minimal reproduction (preset used, agent count, log output).

## Suggesting features

Open an issue with the "feature" template. Explain the use case before proposing implementation.

## Pull requests

1. Fork the repo and create a branch off `main`.
2. Run `npm install` then `npm test` to confirm baseline passes.
3. Add tests for any new behavior. We use Vitest.
4. Keep commits scoped and follow [Conventional Commits](https://www.conventionalcommits.org/).
5. Open a PR against `main`. CI must pass before review.

## Development

- `npm install`
- `npm test` — vitest suite (orchestrator + agent-loop + bridge tests).
- `npm run build` — TypeScript compile to `dist/`.
- `npm run cli -- list` — list bundled presets.
- `npm run cli -- run swarm -p ./tmp-test-repo --agents 2 --dry-run` — preview a coordinated run.

## Architecture

essaim is the orchestrator. It composes behaviors via [@swoofer/promptweave](https://github.com/swoofer/promptweave) and runs them against an embedded [mcp-coordinator](https://github.com/swoofer/mcp-coordinator) instance. The 32-behavior catalog ships bundled. See `README.md` for the high-level model.
