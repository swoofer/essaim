import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Walk src/security/*.ts and assert no module-scope (top-level) spawn/fetch and no hard-coded engine hosts.
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("security modules are hermetic by construction", () => {
  const files = walk(join(__dirname, "..", "..", "src", "security"));

  it("finds the security source tree", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("never hard-codes a non-loopback engine host", () => {
    // Hostname-anchored allow-set — a substring match (e.g. `.toMatch(/opencontainers/)`)
    // would let `https://attacker.io/opencontainers-webhook` slip through. Parse the URL
    // and compare the actual hostname instead.
    const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "example.com"]);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // no absolute http(s) URLs except localhost/127.0.0.1 in source
      const urls = src.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
      for (const u of urls) {
        let host = "";
        try {
          host = new URL(u).hostname;
        } catch {
          host = "<unparseable>";
        }
        expect(ALLOWED_HOSTS.has(host), `${f} hard-codes host ${host} (${u})`).toBe(true);
      }
    }
  });

  it("does not call spawn/fetch/execSync at module top-level (only inside functions)", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // A module-top-level (column-0, no leading whitespace) line invoking spawn/fetch/execSync
      // must be flagged even when prefixed (const/let/var/await/void/return ... =) or qualified
      // (cp.spawn(...), childProcess.execSync(...)). Indented lines (inside a function) are fine —
      // only unindented lines are inspected here.
      const lines = src.split(/\r?\n/);
      for (const line of lines) {
        if (!/^\S/.test(line)) continue; // indented => inside a function, not module top-level
        const bareCall = /(?:^|[^.\w])(spawn|fetch|execSync)\s*\(/.test(line);
        const qualifiedCall = /\.(spawn|execSync)\s*\(/.test(line);
        if (bareCall || qualifiedCall) {
          throw new Error(`${f}: top-level ${line.trim()} — must be inside a function`);
        }
      }
    }
  });
});
