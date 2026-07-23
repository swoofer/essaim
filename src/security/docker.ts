// src/security/docker.ts — small docker argv helpers still used by the healthCheck path.
// The Strix invocation itself spawns a HOST CLI process (see strix-cli.ts / adapters/strix.ts),
// not a `docker run` of a Strix image — see docs/superpowers/specs/2026-07-23-strix-adapter-real-invocation-design.md.

export function dockerInspectArgs(image: string): string[] {
  return ["image", "inspect", image];
}
