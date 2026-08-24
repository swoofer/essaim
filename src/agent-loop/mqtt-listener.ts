import mqtt from "mqtt";
import { Duplex } from "stream";
import { createLogger } from "../logger.js";
import { coordinatorToken, authHeaders } from "../coordinator-auth.js";
import { currentRunId } from "../run-id.js";
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
  // Coordinator REST base URL. When set, enables a catch-up fetch of
  // currently open consultations on every (re)connect (see #113 below).
  // Optional so callers that only need push notifications (or tests) can
  // omit it — catch-up simply stays disabled in that case.
  coordinatorUrl?: string;
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

/**
 * Le segment org de chaque topic du coordinator (#330). Le coordinator le tire du
 * claim `org` du token et refuse — SILENCIEUSEMENT, via `cb(null, null)` dans
 * `authorizeSubscribe` — tout abonnement hors de `coordinator/<org>/`. Un joker
 * `coordinator/+/...` est refusé aussi : le test est un `startsWith` sur le préfixe.
 *
 * On décode, on ne vérifie jamais : le serveur reste l'autorité, on n'a besoin que
 * du préfixe de routage. Le repli sur "default" reproduit exactement celui du
 * coordinator (src/auth.ts), sans quoi un token sans claim `org` s'abonnerait à un
 * préfixe que le serveur n'emploie pas.
 */
export function orgFromToken(token: string | undefined): string {
  if (!token) return "default";
  const parts = token.split(".");
  if (parts.length < 2) return "default";
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.org === "string" && payload.org ? payload.org : "default";
  } catch {
    return "default";
  }
}

/** Les sept topics auxquels l'agent s'abonne, préfixés par son org. */
export function topicsForOrg(org: string): string[] {
  const p = `coordinator/${org}`;
  return [
    `${p}/consultations/new`,
    `${p}/consultations/+/messages`,
    `${p}/consultations/+/status`,
    `${p}/consultations/+/claimed`,
    `${p}/consultations/+/completed`,
    `${p}/broadcast`,
    `${p}/agents/+/status`,
  ];
}

export function classifyTopic(
  topic: string,
  payload: Record<string, unknown>,
): InterruptType | null {
  const parts = topic.split("/");
  // coordinator/<org>/... : le genre est en [2], l'identifiant en [3], la feuille en [4].
  if (parts[0] !== "coordinator" || parts.length < 3) return null;

  if (parts[2] === "consultations") {
    if (parts[3] === "new") return "consultation_new";
    if (parts[4] === "messages") return "consultation_message";
    if (parts[4] === "claimed") return "consultation_claimed";
    if (parts[4] === "completed") return "consultation_completed";
    if (parts[4] === "status") {
      const status = payload.status as string | undefined;
      if (status === "resolved") return "consultation_resolved";
      return "consultation_resolving";
    }
  }

  if (parts[2] === "agents" && parts[4] === "status") {
    const status = payload.status as string | undefined;
    if (status === "offline") return "agent_offline";
    return "agent_online";
  }

  if (parts[2] === "broadcast") return "broadcast";

  return null;
}

export function buildInterrupt(
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

  // Extrait le threadId : coordinator/<org>/consultations/{id}/messages|status|claimed|completed
  if (parts[2] === "consultations" && parts.length >= 5 && parts[3] !== "new") {
    interrupt.threadId = parts[3];
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

  // Topic de statut d'agent : coordinator/<org>/agents/{agentId}/status
  if (parts[2] === "agents" && parts[4] === "status") {
    interrupt.agentId = parts[3];
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
  const { url, agentId, coordinatorUrl } = options;
  let client: mqtt.MqttClient | null = null;
  let isConnected = false;
  let hasConnected = false;
  let reconnectAttempts = 0;
  let gaveUp = false;
  const queue: MqttInterrupt[] = [];

  // Thread/consultation ids already delivered to this listener — via a live
  // MQTT message or a previous catch-up — so the catch-up fetch below never
  // re-queues the same consultation twice across reconnects.
  const seenThreadIds = new Set<string>();

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
    if (interrupt.threadId) seenThreadIds.add(interrupt.threadId);
    log.debug("message", { type, threadId: interrupt.threadId });
    queue.push(interrupt);
  }

  // mqtt.js subscribes at QoS 0 with clean:true and a randomized clientId per
  // connect (below), so no broker session survives a disconnect — anything
  // published to `coordinator/consultations/*` while this client was offline
  // is gone with no redelivery. QoS/clean-session changes alone can't fix
  // that without broker-side persistence we don't control here. Instead, on
  // every (re)connect we do a catch-up fetch of currently open consultations
  // via the coordinator's existing /api/threads-active endpoint — the same
  // one work-stealing.ts already polls for open threads — and re-queue
  // anything this listener hasn't seen yet.
  /**
   * `target_modules` est stocké côté coordinator via JSON.stringify dans une
   * colonne TEXT (consultation.ts:182), donc /api/threads-active le renvoie en
   * CHAÎNE. Un Array.isArray dessus est toujours faux, ce qui perdait
   * silencieusement le ciblage par module à chaque catch-up (#98). Le tableau
   * reste accepté au cas où un appelant le fournirait déjà décodé.
   */
  function parseTargetModules(raw: unknown): string[] | undefined {
    if (Array.isArray(raw)) return raw as string[];
    if (typeof raw !== "string") return undefined;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as string[]) : undefined;
    } catch {
      // Colonne illisible : on perd le ciblage, pas le thread. Le renvoyer sans
      // modules vaut mieux que de le laisser tomber.
      return undefined;
    }
  }

  async function catchUpOpenConsultations(): Promise<void> {
    if (!coordinatorUrl) return; // no REST base configured — nothing to catch up on

    let threads: Array<Record<string, unknown>>;
    try {
      const resp = await fetch(`${coordinatorUrl}/api/threads-active`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ run_id: currentRunId() }),
      });
      if (!resp.ok) {
        log.debug("catch-up: threads-active failed", { status: resp.status });
        return;
      }
      const data = await resp.json();
      threads = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    } catch (err) {
      log.debug("catch-up: coordinator unreachable", { error: (err as Error).message });
      return;
    }

    let recovered = 0;
    for (const thread of threads) {
      if (thread.status !== "open") continue;
      // `initiator_id` est la colonne réelle de la table threads du coordinator
      // (consultation.ts:174) ; `agent_id` n'y existe pas. Le filtre ne pouvait
      // donc jamais matcher et chaque agent se réinjectait ses propres
      // consultations à chaque reconnexion (#98). `agent_id` reste accepté en
      // repli au cas où une version du coordinator l'exposerait sous ce nom —
      // le commentaire d'origine invoquait une parité avec handleMessage, qui
      // lit bien `payload.agent_id`, mais d'une charge MQTT, pas d'une ligne SQL.
      const initiatorId = (thread.initiator_id ?? thread.agent_id) as string | undefined;
      if (initiatorId === agentId) continue;

      const threadId = thread.id as string | undefined;
      if (!threadId || seenThreadIds.has(threadId)) continue;
      seenThreadIds.add(threadId);

      queue.push({
        type: "consultation_new",
        threadId,
        subject: typeof thread.subject === "string" ? thread.subject : undefined,
        targetModules: parseTargetModules(thread.target_modules),
        timestamp: Date.now(),
        raw: thread,
      });
      recovered++;
    }
    if (recovered > 0) {
      log.info("catch-up: recovered open consultations missed while offline", { count: recovered });
    }
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
          hasConnected = true;
          isConnected = true;
          reconnectAttempts = 0; // a successful connect earns a fresh budget
          void catchUpOpenConsultations();
          const org = orgFromToken(coordinatorToken());
          const topics = topicsForOrg(org);
          client!.subscribe(topics, (err) => {
            if (err) {
              reject(err);
              return;
            }
            log.info("connected", { url, org });
            resolve();
          });
        });

        client.on("message", handleMessage);

        client.on("error", (err) => {
          if (hasConnected) {
            // A transient error after a successful connect (e.g. a network
            // blip). mqtt.js will follow up with "close" then "reconnect",
            // and the MAX_RECONNECT_ATTEMPTS budget on that handler below
            // already governs whether we keep retrying — giving up and
            // rejecting here would bypass that budget and kill the listener
            // on a single post-connect error.
            log.warn("post-connect error — reconnect budget governs retry", { error: (err as Error).message });
            return;
          }
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

