import mqtt from "mqtt";
import { Duplex } from "stream";
import { createLogger } from "../logger.js";
import { coordinatorToken } from "../coordinator-auth.js";
const log = createLogger("mqtt-listener");

const isBun = !!(process.versions as Record<string, string>)?.bun;

/**
 * In Bun, the `ws` package's Receiver is not supported, so mqtt.connect("ws://...")
 * fails. We use Bun's native WebSocket and bridge it to a Duplex stream that the
 * mqtt.MqttClient can consume directly.
 */
function createBunWsStream(url: string): Duplex {
  const ws = new WebSocket(url, ["mqtt"]);
  ws.binaryType = "arraybuffer";

  let wsOpen = false;
  const pending: Array<{ chunk: Buffer | Uint8Array; callback: (err?: Error | null) => void }> = [];

  function flushPending() {
    wsOpen = true;
    for (const { chunk, callback } of pending) {
      try { ws.send(chunk); callback(); } catch (err) { callback(err as Error); }
    }
    pending.length = 0;
  }

  const duplex = new Duplex({
    read() {},
    write(chunk: Buffer | Uint8Array, _encoding, callback) {
      if (wsOpen) {
        try { ws.send(chunk); callback(); } catch (err) { callback(err as Error); }
      } else {
        // Buffer until WebSocket is open
        pending.push({ chunk, callback });
      }
    },
    final(callback) {
      ws.close();
      callback();
    },
  });

  ws.addEventListener("open", () => flushPending());
  ws.addEventListener("message", (event) => {
    const data = event.data;
    if (data instanceof ArrayBuffer) {
      duplex.push(Buffer.from(data));
    } else {
      duplex.push(data);
    }
  });
  ws.addEventListener("close", () => { duplex.push(null); duplex.destroy(); });
  ws.addEventListener("error", () => {
    for (const { callback } of pending) callback(new Error("WebSocket error"));
    pending.length = 0;
    duplex.destroy(new Error("WebSocket error"));
  });

  return duplex;
}

export interface MqttListenerOptions {
  url: string;             // mqtt://localhost:1883 (TCP) or ws://localhost:3100/mqtt (WebSocket)
  agentId: string;
  agentModules: string[];
}

export type InterruptType =
  | "consultation_new"
  | "consultation_message"
  | "consultation_resolving"
  | "consultation_resolved"
  | "consultation_claimed"
  | "consultation_completed"
  | "agent_online"
  | "agent_offline"
  | "broadcast";

export interface MqttInterrupt {
  type: InterruptType;
  threadId?: string;
  subject?: string;
  targetModules?: string[];
  agentId?: string;
  agentName?: string;
  content?: string;
  status?: string;
  timestamp: number;
  raw: Record<string, unknown>;
}

export interface MqttListener {
  connect(): Promise<void>;
  drain(): MqttInterrupt[];
  peek(): number;
  close(): Promise<void>;
  readonly connected: boolean;
}

const TOPICS = [
  "coordinator/consultations/new",
  "coordinator/consultations/+/messages",
  "coordinator/consultations/+/status",
  "coordinator/consultations/+/claimed",
  "coordinator/consultations/+/completed",
  "coordinator/broadcast",
  "coordinator/agents/+/status",
];

function classifyTopic(topic: string, payload: Record<string, unknown>): InterruptType | null {
  const parts = topic.split("/");

  if (parts[1] === "consultations") {
    if (parts[2] === "new") return "consultation_new";
    if (parts[3] === "messages") return "consultation_message";
    if (parts[3] === "claimed") return "consultation_claimed";
    if (parts[3] === "completed") return "consultation_completed";
    if (parts[3] === "status") {
      const status = payload.status as string | undefined;
      if (status === "resolved") return "consultation_resolved";
      return "consultation_resolving";
    }
  }

  if (parts[1] === "agents" && parts[3] === "status") {
    const status = payload.status as string | undefined;
    if (status === "offline") return "agent_offline";
    return "agent_online";
  }

  if (parts[1] === "broadcast") return "broadcast";

  return null;
}

function buildInterrupt(
  type: InterruptType,
  topic: string,
  payload: Record<string, unknown>,
): MqttInterrupt {
  const parts = topic.split("/");
  const interrupt: MqttInterrupt = {
    type,
    timestamp: Date.now(),
    raw: payload,
  };

  // Extract threadId from topic structure: coordinator/consultations/{id}/messages|status
  if (parts[1] === "consultations" && parts.length >= 4 && parts[2] !== "new") {
    interrupt.threadId = parts[2];
  }

  // Map common payload fields
  if (payload.thread_id !== undefined) interrupt.threadId = payload.thread_id as string;
  if (payload.subject !== undefined) interrupt.subject = payload.subject as string;
  if (payload.target_modules !== undefined) interrupt.targetModules = payload.target_modules as string[];
  if (payload.agent_id !== undefined) interrupt.agentId = payload.agent_id as string;
  if (payload.name !== undefined) interrupt.agentName = payload.name as string;
  if (payload.content !== undefined) interrupt.content = payload.content as string;
  if (payload.message !== undefined) interrupt.content = payload.message as string;
  if (payload.status !== undefined) interrupt.status = payload.status as string;
  if (payload.summary !== undefined) interrupt.content = payload.summary as string;

  // For agent status topics, extract agentId from topic
  if (parts[1] === "agents" && parts[3] === "status") {
    interrupt.agentId = parts[2];
  }

  return interrupt;
}

// mqtt.js defaults to reconnectPeriod=1000 and retries FOREVER. When the WS
// upgrade through the ingress fails, that turns into a "disconnected" log every
// second for the whole run (#33). Push notifications are a nice-to-have — the
// loop already degrades gracefully without them — so back off and then give up
// rather than spin. Giving up is announced once, loudly.
const RECONNECT_PERIOD_MS = 5_000;
const MAX_RECONNECT_ATTEMPTS = 5;

export function createMqttListener(options: MqttListenerOptions): MqttListener {
  const { url, agentId } = options;
  let client: mqtt.MqttClient | null = null;
  let isConnected = false;
  let reconnectAttempts = 0;
  let gaveUp = false;
  const queue: MqttInterrupt[] = [];

  /** Tear the client down for good — stops mqtt.js's endless auto-reconnect. */
  function giveUp(reason: string): void {
    if (gaveUp) return;
    gaveUp = true;
    isConnected = false;
    log.warn(`giving up on MQTT — running without push notifications (${reason})`, { url });
    try {
      client?.end(true);
    } catch { /* already gone */ }
  }

  function handleMessage(topic: string, message: Buffer): void {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(message.toString());
    } catch {
      return; // ignore malformed JSON
    }

    // Filter self-messages
    if (payload.agent_id === agentId) return;

    const type = classifyTopic(topic, payload);
    if (!type) return;

    const interrupt = buildInterrupt(type, topic, payload);
    log.debug("message", { type, threadId: interrupt.threadId });
    queue.push(interrupt);
  }

  return {
    get connected(): boolean {
      return isConnected;
    },

    connect(): Promise<void> {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          // Same teardown as on error: a client left alive here would retry
          // forever behind a caller that has already degraded (#33).
          giveUp("connection timeout");
          reject(new Error("MQTT connection timeout"));
        }, 5000);

        const clientId = `agent-loop-${agentId}-${Date.now()}`;

        // Coordinator token (when set) travels as MQTT credentials in the
        // CONNECT packet — in-protocol, so it works through the WS bridge
        // too. The deployed coordinator's aedes authenticate hook reads the
        // JWT from the password field (username is ignored there).
        const token = coordinatorToken();
        const mqttOpts: mqtt.IClientOptions = {
          clientId,
          clean: true,
          reconnectPeriod: RECONNECT_PERIOD_MS,
          connectTimeout: 5000,
        };
        if (token) {
          mqttOpts.username = "agent";
          mqttOpts.password = token;
        }

        if (isBun && url.startsWith("ws")) {
          // Bun: ws package Receiver is broken — use native WebSocket + Duplex bridge
          const stream = createBunWsStream(url);
          client = new mqtt.MqttClient(() => stream, mqttOpts);
        } else {
          client = mqtt.connect(url, mqttOpts);
        }

        client.on("connect", () => {
          clearTimeout(timeout);
          isConnected = true;
          reconnectAttempts = 0; // a successful connect earns a fresh budget
          client!.subscribe(TOPICS, (err) => {
            if (err) {
              reject(err);
              return;
            }
            log.info("connected", { url });
            resolve();
          });
        });

        client.on("message", handleMessage);

        client.on("error", (err) => {
          clearTimeout(timeout);
          log.warn("connection failed", { error: (err as Error).message });
          // Without this teardown the client keeps auto-reconnecting in the
          // background for the entire run, even though the caller has already
          // been told the connection failed and moved on (#33).
          giveUp((err as Error).message);
          reject(err);
        });

        client.on("close", () => {
          isConnected = false;
          log.debug("disconnected");
        });

        client.on("reconnect", () => {
          isConnected = false;
          if (++reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            giveUp(`${MAX_RECONNECT_ATTEMPTS} reconnect attempts failed`);
          }
        });
      });
    },

    drain(): MqttInterrupt[] {
      const messages = queue.splice(0);
      return messages;
    },

    peek(): number {
      return queue.length;
    },

    async close(): Promise<void> {
      if (client) {
        isConnected = false;
        await client.endAsync();
        client = null;
      }
    },
  };
}

