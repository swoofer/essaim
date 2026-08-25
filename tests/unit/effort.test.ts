import { describe, it, expect } from "vitest";
import { EFFORT_PROFILES, EFFORT_ORDER, resolveEffort, parseSeverity, upgradeEffort, isThinkingLevel, thinkingKeyword, type EffortLevel, type ThinkingLevel } from "../../src/agent-loop/effort.js";

describe("EFFORT_PROFILES", () => {
  it("maps low to haiku with 15 turns and no thinking", () => {
    expect(EFFORT_PROFILES.low).toEqual({
      model: "claude-haiku-4-5-20251001",
      thinking: "none",
      maxTurns: 15,
    });
  });

  it("maps mid to sonnet with 16 turns and think", () => {
    expect(EFFORT_PROFILES.mid).toEqual({
      model: "claude-sonnet-4-6",
      thinking: "think",
      maxTurns: 16,
    });
  });

  it("maps high to opus with 20 turns and think-hard", () => {
    expect(EFFORT_PROFILES.high).toEqual({
      model: "claude-opus-4-6",
      thinking: "think-hard",
      maxTurns: 20,
    });
  });

  it("maps max to opus with 60 turns and ultrathink", () => {
    expect(EFFORT_PROFILES.max).toEqual({
      model: "claude-opus-4-6",
      thinking: "ultrathink",
      maxTurns: 60,
    });
  });

  it("does not have an auto profile (auto resolves to a concrete level)", () => {
    expect((EFFORT_PROFILES as Record<string, unknown>).auto).toBeUndefined();
  });
});

describe("isThinkingLevel", () => {
  it("accepts valid levels", () => {
    expect(isThinkingLevel("none")).toBe(true);
    expect(isThinkingLevel("think")).toBe(true);
    expect(isThinkingLevel("think-hard")).toBe(true);
    expect(isThinkingLevel("ultrathink")).toBe(true);
  });

  it("rejects unknown values", () => {
    expect(isThinkingLevel("")).toBe(false);
    expect(isThinkingLevel("hard")).toBe(false);
    expect(isThinkingLevel("think hard")).toBe(false);  // space variant — only hyphenated is canonical
    expect(isThinkingLevel(undefined)).toBe(false);
    expect(isThinkingLevel(42)).toBe(false);
  });
});

describe("thinkingKeyword", () => {
  it("returns empty for none (no keyword appended)", () => {
    expect(thinkingKeyword("none")).toBe("");
  });

  it("maps to Claude CLI trigger phrases", () => {
    expect(thinkingKeyword("think")).toBe("think");
    expect(thinkingKeyword("think-hard")).toBe("think hard");
    expect(thinkingKeyword("ultrathink")).toBe("ultrathink");
  });
});

describe("EFFORT_ORDER", () => {
  it("ranks low < mid < high < max", () => {
    expect(EFFORT_ORDER.low).toBe(0);
    expect(EFFORT_ORDER.mid).toBe(1);
    expect(EFFORT_ORDER.high).toBe(2);
    expect(EFFORT_ORDER.max).toBe(3);
  });
});

describe("resolveEffort", () => {
  it("returns concrete level unchanged", () => {
    expect(resolveEffort("low",  { toolsMode: "full", loop: false })).toBe("low");
    expect(resolveEffort("mid",  { toolsMode: "full", loop: true  })).toBe("mid");
    expect(resolveEffort("high", { toolsMode: "read_only", loop: false })).toBe("high");
    expect(resolveEffort("max",  { toolsMode: "none", loop: false })).toBe("max");
  });

  it("resolves auto to low when tools_mode is read_only", () => {
    expect(resolveEffort("auto", { toolsMode: "read_only", loop: false })).toBe("low");
    expect(resolveEffort("auto", { toolsMode: "read_only", loop: true  })).toBe("low");
  });

  it("resolves auto to low when tools_mode is none", () => {
    expect(resolveEffort("auto", { toolsMode: "none", loop: false })).toBe("low");
    expect(resolveEffort("auto", { toolsMode: "none", loop: true  })).toBe("low");
  });

  it("resolves auto to mid when tools_mode is full and loop is false", () => {
    expect(resolveEffort("auto", { toolsMode: "full", loop: false })).toBe("mid");
  });

  it("resolves auto to high when tools_mode is full and loop is true", () => {
    expect(resolveEffort("auto", { toolsMode: "full", loop: true })).toBe("high");
  });

  it("treats an unknown level as auto (safe fallback for misconfigured YAML)", () => {
    // @ts-expect-error — intentionally passing a bad value to exercise the guard
    expect(resolveEffort("turbo", { toolsMode: "full", loop: true })).toBe("high");
    // @ts-expect-error
    expect(resolveEffort("wat", { toolsMode: "read_only", loop: false })).toBe("low");
  });
});

describe("parseSeverity", () => {
  it("extracts 'critical' from prefix", () => {
    expect(parseSeverity("critical: server/src/foo.ts:123 — null check missing"))
      .toBe("critical");
  });

  it("extracts 'major' from prefix", () => {
    expect(parseSeverity("major: unhandled exception in auth")).toBe("major");
  });

  it("extracts 'minor' from prefix", () => {
    expect(parseSeverity("minor: typo in docstring")).toBe("minor");
  });

  it("is case insensitive", () => {
    expect(parseSeverity("CRITICAL: bug")).toBe("critical");
    expect(parseSeverity("Major: bug")).toBe("major");
  });

  it("returns undefined when no severity prefix", () => {
    expect(parseSeverity("server/src/foo.ts:123 — null check")).toBeUndefined();
    expect(parseSeverity("")).toBeUndefined();
  });
});

describe("upgradeEffort", () => {
  it("upgrades low to mid when severity is critical", () => {
    expect(upgradeEffort("low", { severity: "critical" })).toBe("mid");
  });

  it("leaves mid unchanged when severity is critical (no Opus jump)", () => {
    // Previously we upgraded mid → high; Opus tended to burn its budget
    // exploring instead of producing DONE on raid-style tasks.
    expect(upgradeEffort("mid", { severity: "critical" })).toBe("mid");
  });

  it("leaves high unchanged when severity is critical", () => {
    expect(upgradeEffort("high", { severity: "critical" })).toBe("high");
  });

  it("does not downgrade max when severity is critical", () => {
    expect(upgradeEffort("max", { severity: "critical" })).toBe("max");
  });

  it("leaves level unchanged for non-critical severity", () => {
    expect(upgradeEffort("low", { severity: "major" })).toBe("low");
    expect(upgradeEffort("mid", { severity: "minor" })).toBe("mid");
    expect(upgradeEffort("low", {})).toBe("low");
  });

  it("leaves level unchanged when severity is undefined", () => {
    expect(upgradeEffort("mid", { severity: undefined })).toBe("mid");
  });
});

