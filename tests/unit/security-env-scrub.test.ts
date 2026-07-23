import { describe, it, expect } from "vitest";
import { buildChildEnv } from "../../src/agent-loop/child-env.js";

describe("buildChildEnv — allowlist (drops engine secrets)", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    ANTHROPIC_API_KEY: "sk-ant-keep-me",
    CLAUDE_BIN: "/usr/local/bin/claude",
    COORDINATOR_TOKEN: "coord-tok",
    COORDINATOR_URL: "http://localhost:3100",
    ESSAIM_RUN_ID: "run-1",
    DEBUG: "1",
    HTTPS_PROXY: "http://proxy:8080",
    ProgramFiles: "C:\\Program Files",
    NODE_EXTRA_CA_CERTS: "/etc/ssl/corp-ca.pem",
    NVM_DIR: "/home/u/.nvm",
    // must be DROPPED:
    LLM_API_KEY: "sk-engine-secret",
    STRIX_LLM: "anthropic/claude",
    HEXSTRIKE_TOKEN: "hx-secret",
    RANDOM_API_KEY: "leak",
    SOME_TOKEN: "leak2",
  } as NodeJS.ProcessEnv;

  it("keeps vars the claude child legitimately needs", () => {
    const env = buildChildEnv(parent);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-keep-me");
    expect(env.CLAUDE_BIN).toBe("/usr/local/bin/claude");
    expect(env.COORDINATOR_TOKEN).toBe("coord-tok");
    expect(env.COORDINATOR_URL).toBe("http://localhost:3100");
    expect(env.ESSAIM_RUN_ID).toBe("run-1");
    expect(env.DEBUG).toBe("1");
    expect(env.HTTPS_PROXY).toBe("http://proxy:8080"); // proxy passes (corp networks)
    expect(env.ProgramFiles).toBe("C:\\Program Files"); // Windows essential passes
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/corp-ca.pem"); // corp proxy CA trust passes
    expect(env.NVM_DIR).toBe("/home/u/.nvm"); // version-manager var passes
  });

  it("DROPS engine secrets and arbitrary *_API_KEY / *_TOKEN", () => {
    const env = buildChildEnv(parent);
    expect(env.LLM_API_KEY).toBeUndefined();
    expect(env.STRIX_LLM).toBeUndefined();
    expect(env.HEXSTRIKE_TOKEN).toBeUndefined();
    expect(env.RANDOM_API_KEY).toBeUndefined();
    expect(env.SOME_TOKEN).toBeUndefined();
  });

  it("lets options.env override / add (always wins)", () => {
    const env = buildChildEnv(parent, { COORDINATOR_AGENT_ID: "alice-1", COORDINATOR_URL: "http://other" });
    expect(env.COORDINATOR_AGENT_ID).toBe("alice-1");
    expect(env.COORDINATOR_URL).toBe("http://other");
  });
});
