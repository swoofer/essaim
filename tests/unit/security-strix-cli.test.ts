import { describe, it, expect } from "vitest";
import { strixProcessEnv, PINNED_STRIX_SANDBOX_IMAGE } from "../../src/security/strix-cli.js";

describe("strixProcessEnv", () => {
  it("default-denies essaim's own secrets while forwarding OS essentials + strix overlay", () => {
    const base = {
      ANTHROPIC_API_KEY: "sk-anthropic",
      COORDINATOR_TOKEN: "tok",
      AWS_SECRET_ACCESS_KEY: "aws",
      PATH: "/usr/bin",
      HOME: "/home/u",
      GITHUB_TOKEN: "gh",
    };
    const result = strixProcessEnv(
      { STRIX_LLM: "anthropic/x", LLM_API_KEY: "sk-secret" },
      PINNED_STRIX_SANDBOX_IMAGE,
      base,
    );

    expect(result.PATH).toBe("/usr/bin");
    expect(result.HOME).toBe("/home/u");
    expect(result.STRIX_LLM).toBe("anthropic/x");
    expect(result.LLM_API_KEY).toBe("sk-secret");
    expect(result.STRIX_IMAGE).toBe(PINNED_STRIX_SANDBOX_IMAGE);
    expect(result.STRIX_RUNTIME_BACKEND).toBe("docker");

    expect(result).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(result).not.toHaveProperty("COORDINATOR_TOKEN");
    expect(result).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(result).not.toHaveProperty("GITHUB_TOKEN");
  });

  it("allows prefix families (LC_, PYTHON, PIP_, XDG_) and is case-insensitive for the membership test", () => {
    const base = {
      lc_all: "C.UTF-8", // lowercase key on the base env — still matched case-insensitively
      PYTHONPATH: "/x",
      PIP_INDEX_URL: "https://pypi",
      XDG_CONFIG_HOME: "/xdg",
      RANDOM_SECRET: "nope",
    };
    const result = strixProcessEnv({}, PINNED_STRIX_SANDBOX_IMAGE, base);
    expect(result.lc_all).toBe("C.UTF-8");
    expect(result.PYTHONPATH).toBe("/x");
    expect(result.PIP_INDEX_URL).toBe("https://pypi");
    expect(result.XDG_CONFIG_HOME).toBe("/xdg");
    expect(result).not.toHaveProperty("RANDOM_SECRET");
  });

  it("strix overlay always wins over an allowed base key of the same name", () => {
    const base = { STRIX_RUNTIME_BACKEND: "should-be-overwritten" };
    const result = strixProcessEnv({}, PINNED_STRIX_SANDBOX_IMAGE, base);
    expect(result.STRIX_RUNTIME_BACKEND).toBe("docker");
  });
});
