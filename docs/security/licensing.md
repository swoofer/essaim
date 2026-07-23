# Security Engines — Licensing Invariant (ADR)

**Invariant:** Every security engine is invoked as a **separate program** (subprocess via `docker run`,
or a network service). essaim **never** links, imports, statically bundles, modifies, or redistributes
engine source. This is a licensing requirement, not a style choice.

**Enforcement:**
- `src/security/registry.ts` refuses to register any adapter whose `capabilities.license` is not on the
  permissive allowlist (MIT / Apache-2.0 / BSD / ISC). AGPL / GPL / SSPL / non-commercial / unknown are
  rejected at registration (`EngineLicenseError`).
- Adapters call engines only out-of-process (`docker run`, REST, MCP). No `import`/`require` of engine code.
- Engine images are pinned by **digest** (`usestrix/strix@sha256:…`), never `:latest` — a mutable tag can
  silently roll under changed license terms. Re-verify the license on any digest bump.

**v1 engine:** Strix (usestrix/strix) — **Apache-2.0**, run arm's-length via `docker run`. essaim ships no
engine bytes, so Apache §4 NOTICE obligations are not triggered.

**Landmines (never embed):** Shannon (AGPL-3.0), Vulnhuntr (AGPL-3.0), CAI (MIT-but-non-commercial). These
may only ever be invoked out-of-process by an operator who accepts their terms; essaim must never
distribute, bundle, or modify their code. AGPL §13's network-copyleft is the operator's concern for a
*modified* engine — essaim's arm's-length invocation of an *unmodified* engine is a separate program.
