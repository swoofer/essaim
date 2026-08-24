import { describe, it, expect } from "vitest";
import { grantedTopics } from "../../src/agent-loop/mqtt-listener.js";

describe("grantedTopics", () => {
  it("separe les abonnements accordes des refuses", () => {
    const r = grantedTopics([
      { topic: "coordinator/acme/broadcast", qos: 0 },
      { topic: "coordinator/acme/consultations/new", qos: 1 },
      { topic: "coordinator/autre/broadcast", qos: 128 },
    ]);
    expect(r.ok).toEqual(["coordinator/acme/broadcast", "coordinator/acme/consultations/new"]);
    expect(r.refused).toEqual(["coordinator/autre/broadcast"]);
  });

  it("traite tout QoS >= 128 comme un refus", () => {
    const r = grantedTopics([{ topic: "t", qos: 135 }]);
    expect(r.refused).toEqual(["t"]);
    expect(r.ok).toEqual([]);
  });

  it("rend deux listes vides sur une entree vide", () => {
    expect(grantedTopics([])).toEqual({ ok: [], refused: [] });
  });
});
