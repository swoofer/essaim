import { describe, it, expect } from "vitest";
import {
  orgFromToken,
  topicsForOrg,
  classifyTopic,
  buildInterrupt,
} from "../../src/agent-loop/mqtt-listener.js";

/** Fabrique un JWT non signé : seule la charge utile compte, on ne vérifie jamais. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.`;
}

describe("orgFromToken", () => {
  it("lit le claim org", () => {
    expect(orgFromToken(jwt({ org: "acme", sub: "agent-1" }))).toBe("acme");
  });

  it("retombe sur 'default' quand le claim manque, comme le coordinator", () => {
    expect(orgFromToken(jwt({ sub: "agent-1" }))).toBe("default");
  });

  it("retombe sur 'default' sans token", () => {
    expect(orgFromToken(undefined)).toBe("default");
  });

  it("retombe sur 'default' sur un token illisible plutot que de jeter", () => {
    expect(orgFromToken("pas-un-jwt")).toBe("default");
    expect(orgFromToken("a.!!!.c")).toBe("default");
  });
});

describe("topicsForOrg", () => {
  it("prefixe les sept topics par coordinator/<org>/", () => {
    expect(topicsForOrg("acme")).toEqual([
      "coordinator/acme/consultations/new",
      "coordinator/acme/consultations/+/messages",
      "coordinator/acme/consultations/+/status",
      "coordinator/acme/consultations/+/claimed",
      "coordinator/acme/consultations/+/completed",
      "coordinator/acme/broadcast",
      "coordinator/acme/agents/+/status",
    ]);
  });

  it("chaque topic commence par le prefixe que l'ACL du coordinator exige", () => {
    for (const t of topicsForOrg("acme")) {
      expect(t.startsWith("coordinator/acme/")).toBe(true);
    }
  });
});

describe("classifyTopic sur la forme scopee", () => {
  it("classe une nouvelle consultation", () => {
    expect(classifyTopic("coordinator/acme/consultations/new", {})).toBe("consultation_new");
  });

  it("classe un message de thread", () => {
    expect(classifyTopic("coordinator/acme/consultations/t1/messages", {})).toBe(
      "consultation_message",
    );
  });

  it("distingue resolved de resolving sur le topic status", () => {
    expect(classifyTopic("coordinator/acme/consultations/t1/status", { status: "resolved" })).toBe(
      "consultation_resolved",
    );
    expect(classifyTopic("coordinator/acme/consultations/t1/status", { status: "proposed" })).toBe(
      "consultation_resolving",
    );
  });

  it("classe claimed et completed", () => {
    expect(classifyTopic("coordinator/acme/consultations/t1/claimed", {})).toBe(
      "consultation_claimed",
    );
    expect(classifyTopic("coordinator/acme/consultations/t1/completed", {})).toBe(
      "consultation_completed",
    );
  });

  it("classe le statut d'agent", () => {
    expect(classifyTopic("coordinator/acme/agents/a1/status", { status: "offline" })).toBe(
      "agent_offline",
    );
    expect(classifyTopic("coordinator/acme/agents/a1/status", { status: "online" })).toBe(
      "agent_online",
    );
  });

  it("classe le broadcast", () => {
    expect(classifyTopic("coordinator/acme/broadcast", {})).toBe("broadcast");
  });

  it("ignore l'ancienne forme non scopee, que le coordinator ne publie plus", () => {
    expect(classifyTopic("coordinator/consultations/new", {})).toBeNull();
  });
});

describe("buildInterrupt sur la forme scopee", () => {
  it("extrait le threadId du topic", () => {
    const i = buildInterrupt(
      "consultation_message",
      "coordinator/acme/consultations/t42/messages",
      {},
    );
    expect(i.threadId).toBe("t42");
  });

  it("laisse la charge utile primer sur le topic", () => {
    const i = buildInterrupt(
      "consultation_message",
      "coordinator/acme/consultations/t42/messages",
      { thread_id: "t99" },
    );
    expect(i.threadId).toBe("t99");
  });

  it("extrait l'agentId d'un topic de statut", () => {
    const i = buildInterrupt("agent_offline", "coordinator/acme/agents/a7/status", {});
    expect(i.agentId).toBe("a7");
  });
});
