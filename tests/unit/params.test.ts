import { describe, it, expect } from "vitest";
import { parseSetParams, buildParamTypeMap } from "../../cli/params.js";

describe("parseSetParams — coercition par type déclaré (#28)", () => {
  it("garde la string quand le catalogue déclare string mais la valeur ressemble à un nombre", () => {
    const typeMap = { "mission-tasks-md.phase_number": "string" as const };
    const p = parseSetParams(["mission-tasks-md.phase_number=7"], typeMap);
    expect(p["mission-tasks-md"]!.phase_number).toBe("7");
  });
  it("parse toujours les nombres pour les params numériques", () => {
    const typeMap = { "announce-before-write.announce_threshold": "number" as const };
    const p = parseSetParams(["announce-before-write.announce_threshold=2"], typeMap);
    expect(p["announce-before-write"]!.announce_threshold).toBe(2);
  });
  it("comportement inchangé sans typeMap (rétrocompat)", () => {
    const p = parseSetParams(["x.y=7"]);
    expect(p.x!.y).toBe(7);
  });
  it("buildParamTypeMap lit les types du catalogue réel", () => {
    const m = buildParamTypeMap();
    expect(m["mission-tasks-md.phase_number"]).toBe("string");
    expect(m["user-brief.constraints"]).toBe("string[]");
  });
});
