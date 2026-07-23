import { describe, it, expect } from "vitest";
import { strixProcessEnv, strixEnv, PINNED_STRIX_SANDBOX_IMAGE } from "../../src/security/strix-cli.js";

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

describe("strixEnv", () => {
  it("always sets the pinned image + docker backend", () => {
    const env = strixEnv({}, PINNED_STRIX_SANDBOX_IMAGE);
    expect(env.STRIX_IMAGE).toBe(PINNED_STRIX_SANDBOX_IMAGE);
    expect(env.STRIX_RUNTIME_BACKEND).toBe("docker");
  });

  it("forwards a custom LLM base URL + tuning keys when the operator set them (proxy path)", () => {
    const env = strixEnv({
      STRIX_LLM: "openai/local-model",
      LLM_API_BASE: "http://localhost:1234/v1",
      STRIX_REASONING_EFFORT: "medium",
      LLM_TIMEOUT: "300",
      PERPLEXITY_API_KEY: "pk-x",
    });
    expect(env.STRIX_LLM).toBe("openai/local-model");
    expect(env.LLM_API_BASE).toBe("http://localhost:1234/v1");
    expect(env.STRIX_REASONING_EFFORT).toBe("medium");
    expect(env.LLM_TIMEOUT).toBe("300");
    expect(env.PERPLEXITY_API_KEY).toBe("pk-x");
  });

  it("forwards ONLY recognized keys the operator actually set — never invents values", () => {
    const env = strixEnv({ LLM_API_KEY: "sk-secret", NOT_A_STRIX_VAR: "leak" });
    expect(env.LLM_API_KEY).toBe("sk-secret");
    expect(env).not.toHaveProperty("NOT_A_STRIX_VAR");
    expect(env).not.toHaveProperty("STRIX_LLM"); // absent from secrets → not fabricated
    expect(env).not.toHaveProperty("LLM_API_BASE");
  });
});
