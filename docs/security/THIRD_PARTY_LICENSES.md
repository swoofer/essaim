# Third-Party Security Engines

essaim invokes these engines out-of-process; it does not bundle or redistribute them. Operators provision
them themselves.

| Engine | SPDX | Upstream | Invocation | Status |
|--------|------|----------|------------|--------|
| Strix  | Apache-2.0 | https://github.com/usestrix/strix | `docker run` (arm's-length) | v1 (supported) |
| HexStrike AI | MIT | https://github.com/0x4m4/hexstrike-ai | MCP / REST (arm's-length) | v2 (planned) |
| PentAGI | MIT | https://github.com/vxcontrol/pentagi | REST/GraphQL Bearer (arm's-length) | v3 (planned) |

Not integrable (license landmines, listed for contributor guidance only): Shannon (AGPL-3.0),
Vulnhuntr (AGPL-3.0), CAI (MIT non-commercial). See `licensing.md`.
