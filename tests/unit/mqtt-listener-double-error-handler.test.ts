import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

/**
 * Non-régression : `connect()` ne doit enregistrer QU'UN SEUL handler "error".
 *
 * Celui de mqtt-listener.ts porte une garde `hasConnected` et journalise déjà la
 * cause dans ses deux branches — "post-connect error" et "connection failed".
 * #117 en a ajouté un second, sans garde, sur la fausse prémisse qu'aucun
 * handler n'existait. Chaque erreur déclenchait alors les deux, et le doublon
 * journalisait même les événements que le premier avait déjà traités.
 *
 * Trouvé par un agent lors d'un raid sur ce dépôt ; ce test vient de lui.
 */
const mockClient = Object.assign(new EventEmitter(), {
  subscribe: vi.fn((_topics: string | string[], cb?: (err?: Error | null) => void) => {
    if (cb) cb(null);
  }),
  endAsync: vi.fn(() => Promise.resolve()),
});

vi.mock("mqtt", () => ({
  default: {
    connect: vi.fn(() => mockClient),
  },
}));

import { createMqttListener } from "../../src/agent-loop/mqtt-listener.js";

const OPTIONS = {
  url: "ws://127.0.0.1:3100/mqtt",
  agentId: "agent-test",
  agentModules: ["core"],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockClient.removeAllListeners();
});

describe("mqtt-listener — un seul handler d'erreur", () => {
  it("enregistre exactement un handler error apres connect()", async () => {
    const listener = createMqttListener(OPTIONS);
    const connectPromise = listener.connect();
    mockClient.emit("connect");
    await connectPromise;

    expect(mockClient.listenerCount("error")).toBe(1);
  });

  it("ne double pas les enregistrements bruts", async () => {
    const listener = createMqttListener(OPTIONS);
    const connectPromise = listener.connect();
    mockClient.emit("connect");
    await connectPromise;

    const rawCount = (mockClient.rawListeners("error") as unknown[]).length;
    expect(rawCount).toBe(1);

    void listener;
  });
});
