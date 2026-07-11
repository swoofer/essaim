import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { authHeaders, coordinatorToken, mcpAuthHeaders, patchMcpJsonAuth } from "../../src/coordinator-auth.js";
import { writeAgentWorkspace } from "../../src/orchestrator/orchestrator.js";
import type { AgentConfig } from "../../src/orchestrator/types.js";

describe("coordinator-auth", () => {
  const saved = process.env.COORDINATOR_TOKEN;
  afterEach(() => {
    if (saved === undefined) delete process.env.COORDINATOR_TOKEN;
    else process.env.COORDINATOR_TOKEN = saved;
  });

  it("coordinatorToken returns undefined when unset or blank", () => {
    delete process.env.COORDINATOR_TOKEN;
    expect(coordinatorToken()).toBeUndefined();
    process.env.COORDINATOR_TOKEN = "   ";
    expect(coordinatorToken()).toBeUndefined();
  });

  it("authHeaders is empty without token", () => {
    delete process.env.COORDINATOR_TOKEN;
    expect(authHeaders()).toEqual({});
  });

  it("authHeaders carries Bearer token when set", () => {
    process.env.COORDINATOR_TOKEN = "abc.def.ghi";
    expect(authHeaders()).toEqual({ Authorization: "Bearer abc.def.ghi" });
  });

  it("mcpAuthHeaders is empty without token", () => {
    delete process.env.COORDINATOR_TOKEN;
    expect(mcpAuthHeaders()).toEqual({});
  });

  it("mcpAuthHeaders carries the ${COORDINATOR_TOKEN} placeholder when set, never the literal token", () => {
    process.env.COORDINATOR_TOKEN = "abc.def.ghi";
    expect(mcpAuthHeaders()).toEqual({ Authorization: "Bearer ${COORDINATOR_TOKEN}" });
  });

  it("patchMcpJsonAuth adds placeholder headers (never the literal token) to http servers ending in /mcp", () => {
    process.env.COORDINATOR_TOKEN = "tok";
    const dir = mkdtempSync(join(tmpdir(), "essaim-auth-"));
    const p = join(dir, ".mcp.json");
    writeFileSync(p, JSON.stringify({
      mcpServers: {
        coordinator: { type: "http", url: "http://localhost:3100/mcp" },
        other: { type: "stdio", command: "foo" },
      },
    }));
    patchMcpJsonAuth(p);
    const out = JSON.parse(readFileSync(p, "utf-8"));
    expect(out.mcpServers.coordinator.headers).toEqual({ Authorization: "Bearer ${COORDINATOR_TOKEN}" });
    expect(out.mcpServers.other.headers).toBeUndefined();
    const raw = readFileSync(p, "utf-8");
    expect(raw).not.toContain("tok\"");
    rmSync(dir, { recursive: true, force: true });
  });

  it("patchMcpJsonAuth is a no-op without token", () => {
    delete process.env.COORDINATOR_TOKEN;
    expect(() => patchMcpJsonAuth(join(tmpdir(), "does-not-exist.json"))).not.toThrow();
  });

  it("patchMcpJsonAuth is a no-op when token set but file missing", () => {
    process.env.COORDINATOR_TOKEN = "tok";
    expect(() => patchMcpJsonAuth(join(tmpdir(), "does-not-exist.json"))).not.toThrow();
  });

  it("writeAgentWorkspace embeds auth headers when token set", () => {
    process.env.COORDINATOR_TOKEN = "tok2";
    const dir = mkdtempSync(join(tmpdir(), "essaim-ws-"));
    const agent: AgentConfig = {
      id: "a1",
      name: "A1",
      prompt: "x",
      profile: "codeur",
      hooks: {},
      envVars: {},
      mcpTools: [],
    };
    const mcpPath = writeAgentWorkspace(dir, agent, "https://coord.example");
    const out = JSON.parse(readFileSync(mcpPath, "utf-8"));
    expect(out.mcpServers.coordinator.headers).toEqual({ Authorization: "Bearer ${COORDINATOR_TOKEN}" });
    const raw = readFileSync(mcpPath, "utf-8");
    expect(raw).not.toContain("tok2");
    rmSync(dir, { recursive: true, force: true });
  });
});
