import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

// Mock mqtt module before importing the listener
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

import mqtt from "mqtt";
import { createMqttListener, type MqttInterrupt } from "../../src/agent-loop/mqtt-listener.js";

const OPTIONS = {
  url: "ws://localhost:3100/mqtt",
  agentId: "agent-1",
  agentModules: ["auth", "billing"],
};

function simulateMessage(topic: string, payload: Record<string, unknown>): void {
  mockClient.emit("message", topic, Buffer.from(JSON.stringify(payload)));
}

describe("MqttListener", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.removeAllListeners("connect");
    mockClient.removeAllListeners("message");
    mockClient.removeAllListeners("error");
    mockClient.removeAllListeners("close");
    mockClient.removeAllListeners("reconnect");
  });

  async function connectListener() {
    const listener = createMqttListener(OPTIONS);
    const connectPromise = listener.connect();
    // Simulate broker accepting connection
    mockClient.emit("connect");
    await connectPromise;
    return listener;
  }

  describe("topic classification", () => {
    it("classifies consultation_new", async () => {
      const listener = await connectListener();
      simulateMessage("coordinator/consultations/new", {
        thread_id: "t-1",
        subject: "Auth redesign",
        target_modules: ["auth"],
      });
      const msgs = listener.drain();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("consultation_new");
      expect(msgs[0].threadId).toBe("t-1");
      expect(msgs[0].subject).toBe("Auth redesign");
      expect(msgs[0].targetModules).toEqual(["auth"]);
    });

    it("classifies consultation_message", async () => {
      const listener = await connectListener();
      simulateMessage("coordinator/consultations/t-42/messages", {
        agent_id: "agent-2",
        type: "opinion",
        content: "I agree",
      });
      const msgs = listener.drain();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("consultation_message");
      expect(msgs[0].threadId).toBe("t-42");
      expect(msgs[0].agentId).toBe("agent-2");
      expect(msgs[0].content).toBe("I agree");
    });

    it("classifies consultation_resolving", async () => {
      const listener = await connectListener();
      simulateMessage("coordinator/consultations/t-42/status", {
        status: "resolving",
        summary: "Proposed consensus",
      });
      const msgs = listener.drain();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("consultation_resolving");
      expect(msgs[0].status).toBe("resolving");
    });

    it("classifies consultation_resolved", async () => {
      const listener = await connectListener();
      simulateMessage("coordinator/consultations/t-42/status", {
        status: "resolved",
        summary: "Final decision",
      });
      const msgs = listener.drain();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("consultation_resolved");
      expect(msgs[0].content).toBe("Final decision");
    });

    it("classifies consultation_claimed", async () => {
      const listener = await connectListener();
      simulateMessage("coordinator/consultations/t-42/claimed", {
        agent_id: "agent-2",
        status: "claimed",
      });
      const msgs = listener.drain();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("consultation_claimed");
      expect(msgs[0].threadId).toBe("t-42");
      expect(msgs[0].agentId).toBe("agent-2");
    });

    it("classifies consultation_completed", async () => {
      const listener = await connectListener();
      simulateMessage("coordinator/consultations/t-42/completed", {
        agent_id: "agent-2",
        status: "completed",
        summary: "Task finished successfully",
      });
      const msgs = listener.drain();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("consultation_completed");
      expect(msgs[0].threadId).toBe("t-42");
      expect(msgs[0].agentId).toBe("agent-2");
      expect(msgs[0].content).toBe("Task finished successfully");
    });

    it("classifies agent_online", async () => {
      const listener = await connectListener();
      simulateMessage("coordinator/agents/agent-2/status", {
        status: "online",
        name: "Backend Agent",
      });
      const msgs = listener.drain();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("agent_online");
      expect(msgs[0].agentId).toBe("agent-2");
      expect(msgs[0].agentName).toBe("Backend Agent");
    });

    it("classifies agent_offline", async () => {
      const listener = await connectListener();
      simulateMessage("coordinator/agents/agent-2/status", {
        status: "offline",
      });
      const msgs = listener.drain();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("agent_offline");
      expect(msgs[0].agentId).toBe("agent-2");
    });

    it("classifies broadcast", async () => {
      const listener = await connectListener();
      simulateMessage("coordinator/broadcast", {
        agent_id: "agent-2",
        message: "Deploying in 5 min",
      });
      const msgs = listener.drain();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("broadcast");
      expect(msgs[0].content).toBe("Deploying in 5 min");
    });
  });

  describe("self-message filtering", () => {
    it("filters messages from own agent_id", async () => {
      const listener = await connectListener();
      simulateMessage("coordinator/consultations/new", {
        agent_id: "agent-1", // same as OPTIONS.agentId
        thread_id: "t-self",
        subject: "My own consultation",
        target_modules: ["auth"],
      });
      expect(listener.peek()).toBe(0);
      expect(listener.drain()).toHaveLength(0);
    });

    it("accepts messages from other agents", async () => {
      const listener = await connectListener();
      simulateMessage("coordinator/consultations/new", {
        agent_id: "agent-2",
        thread_id: "t-other",
        subject: "Other consultation",
        target_modules: ["auth"],
      });
      expect(listener.peek()).toBe(1);
    });
  });

  describe("drain and peek", () => {
    it("drain empties the queue and returns all messages", async () => {
      const listener = await connectListener();
      simulateMessage("coordinator/broadcast", { agent_id: "a2", message: "msg1" });
      simulateMessage("coordinator/broadcast", { agent_id: "a3", message: "msg2" });
      simulateMessage("coordinator/broadcast", { agent_id: "a4", message: "msg3" });

      expect(listener.peek()).toBe(3);
      const msgs = listener.drain();
      expect(msgs).toHaveLength(3);
      expect(listener.peek()).toBe(0);
      expect(listener.drain()).toHaveLength(0);
    });

    it("peek returns correct count without consuming", async () => {
      const listener = await connectListener();
      simulateMessage("coordinator/broadcast", { agent_id: "a2", message: "msg1" });
      simulateMessage("coordinator/broadcast", { agent_id: "a3", message: "msg2" });

      expect(listener.peek()).toBe(2);
      expect(listener.peek()).toBe(2); // still 2 — not consumed
    });

    it("returns empty array when no messages queued", async () => {
      const listener = await connectListener();
      expect(listener.drain()).toEqual([]);
      expect(listener.peek()).toBe(0);
    });
  });

  describe("connection state", () => {
    it("connected is false before connect", () => {
      const listener = createMqttListener(OPTIONS);
      expect(listener.connected).toBe(false);
    });

    it("connected is true after connect", async () => {
      const listener = await connectListener();
      expect(listener.connected).toBe(true);
    });

    it("connected is false after close", async () => {
      const listener = await connectListener();
      await listener.close();
      expect(listener.connected).toBe(false);
    });
  });

  describe("malformed messages", () => {
    it("ignores non-JSON payloads", async () => {
      const listener = await connectListener();
      mockClient.emit("message", "coordinator/broadcast", Buffer.from("not json"));
      expect(listener.peek()).toBe(0);
    });

    it("ignores unrecognized topics", async () => {
      const listener = await connectListener();
      simulateMessage("coordinator/unknown/something", { agent_id: "a2" });
      expect(listener.peek()).toBe(0);
    });
  });

  describe("coordinator token credentials", () => {
    const originalToken = process.env.COORDINATOR_TOKEN;

    afterEach(() => {
      if (originalToken === undefined) delete process.env.COORDINATOR_TOKEN;
      else process.env.COORDINATOR_TOKEN = originalToken;
    });

    it("connects without username/password when no token is set", async () => {
      delete process.env.COORDINATOR_TOKEN;
      await connectListener();
      const opts = (mqtt.connect as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(opts.username).toBeUndefined();
      expect(opts.password).toBeUndefined();
    });

    it("passes the coordinator token as MQTT credentials when set", async () => {
      process.env.COORDINATOR_TOKEN = "test-jwt-token";
      await connectListener();
      const opts = (mqtt.connect as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(opts.username).toBe("agent");
      expect(opts.password).toBe("test-jwt-token");
    });
  });

  describe("raw payload", () => {
    it("preserves full payload in raw field", async () => {
      const listener = await connectListener();
      const payload = {
        agent_id: "agent-2",
        thread_id: "t-1",
        subject: "Test",
        target_modules: ["auth"],
        extra_field: 42,
      };
      simulateMessage("coordinator/consultations/new", payload);
      const msgs = listener.drain();
      expect(msgs[0].raw).toEqual(payload);
    });
  });
});

