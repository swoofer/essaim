import { describe, it, expect } from "vitest";
import {
  toDockerHostPath,
  dockerMountArg,
  containerName,
  dockerRunArgs,
  dockerKillArgs,
  dockerInspectArgs,
  PINNED_STRIX_IMAGE,
} from "../../src/security/docker.js";

describe("toDockerHostPath", () => {
  it("normalizes Windows backslashes to forward slashes, keeping the drive", () => {
    expect(toDockerHostPath("C:\\Users\\gagno\\repo")).toBe("C:/Users/gagno/repo");
  });
  it("leaves POSIX paths unchanged", () => {
    expect(toDockerHostPath("/home/user/repo")).toBe("/home/user/repo");
  });
});

describe("dockerMountArg", () => {
  it("builds a read-only bind mount to /src by default", () => {
    expect(dockerMountArg("C:\\Users\\gagno\\repo")).toBe("C:/Users/gagno/repo:/src:ro");
  });
  it("supports a custom target and rw", () => {
    expect(dockerMountArg("/repo", "/work", false)).toBe("/repo:/work");
  });
});

describe("containerName", () => {
  it("is deterministic from the runId", () => {
    expect(containerName("run-123")).toBe("essaim-security-run-123");
  });
});

describe("dockerRunArgs", () => {
  const base = {
    image: PINNED_STRIX_IMAGE,
    containerName: "essaim-security-run-1",
    mount: "C:/Users/gagno/repo:/src:ro",
    envFile: "/tmp/sec.env",
    target: "/src",
    scanMode: "quick" as const,
    scopeMode: "diff" as const,
    diffBase: "abc123",
    instruction: "Scope: only files changed since abc123",
  };

  it("builds a --rm, named, mounted, env-filed docker run with Strix flags", () => {
    const args = dockerRunArgs(base);
    expect(args[0]).toBe("run");
    expect(args).toContain("--rm");
    expect(args).toEqual(expect.arrayContaining(["--name", "essaim-security-run-1"]));
    expect(args).toEqual(expect.arrayContaining(["-v", "C:/Users/gagno/repo:/src:ro"]));
    expect(args).toEqual(expect.arrayContaining(["--env-file", "/tmp/sec.env"]));
    expect(args).toContain(PINNED_STRIX_IMAGE);
    // Strix flags after the image
    expect(args).toEqual(expect.arrayContaining(["-n", "-t", "/src", "--scan-mode", "quick"]));
    expect(args).toEqual(expect.arrayContaining(["--scope-mode", "diff", "--diff-base", "abc123"]));
    expect(args).toEqual(expect.arrayContaining(["--instruction", "Scope: only files changed since abc123"]));
    // the image must come BEFORE the engine flags
    expect(args.indexOf(PINNED_STRIX_IMAGE)).toBeLessThan(args.indexOf("-n"));
    // secrets never appear in argv
    expect(args.join(" ")).not.toContain("LLM_API_KEY");
  });

  it("omits diff flags in full-scope mode", () => {
    const args = dockerRunArgs({ ...base, scopeMode: "full", diffBase: undefined });
    expect(args).not.toContain("--scope-mode");
    expect(args).not.toContain("--diff-base");
  });

  it("omits --env-file when none is given", () => {
    const args = dockerRunArgs({ ...base, envFile: undefined });
    expect(args).not.toContain("--env-file");
  });
});

describe("dockerKillArgs / dockerInspectArgs", () => {
  it("build kill and inspect argv", () => {
    expect(dockerKillArgs("essaim-security-run-1")).toEqual(["kill", "essaim-security-run-1"]);
    expect(dockerInspectArgs(PINNED_STRIX_IMAGE)).toEqual(["image", "inspect", PINNED_STRIX_IMAGE]);
  });
});
