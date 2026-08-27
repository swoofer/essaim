// tests/unit/metrics-sse-budget.test.ts
//
// #58 — la lecture des métriques doit tenir son budget de temps ET rapporter ce
// qu'elle a lu, contre un endpoint SSE que le coordinator NE FERME JAMAIS.
//
// `handleSse` (mcp-coordinator serve-http.ts) écrit ses en-têtes, pousse le
// replay, puis garde la connexion ouverte avec un heartbeat. Le corps de la
// réponse n'atteint donc jamais son terme.
//
// Ces tests utilisent un vrai serveur HTTP qui reproduit ce comportement. Les
// tests de métriques préexistants ne couvraient que des fonctions pures, et un
// stub `new Response("")` a un corps déjà bufferisé — aveugle par construction à
// tout ce qui concerne le streaming.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fetchLatestEventId, fetchCoordinatorMetrics } from "../../src/orchestrator/metrics.js";

/** Le budget documenté des appels /api/events, dans metrics.ts. */
const BUDGET_MS = 3000;
/** Marge au-delà de laquelle on considère que l'appel ne rend jamais la main. */
const VERDICT_MS = 8000;

const REPLAY = [
  'id: 41\nevent: thread_opened\ndata: {"thread_id":"t1","agent_id":"a1"}\n\n',
  'id: 42\nevent: message_posted\ndata: {"thread_id":"t1","agent_id":"a2"}\n\n',
  'id: 43\nevent: thread_opened\ndata: {"thread_id":"t2","agent_id":"a3"}\n\n',
].join("");

let server: Server;
let baseUrl: string;
const openSockets: import("node:net").Socket[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith("/api/events")) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.flushHeaders();
      res.write(REPLAY);
      // Et on ne ferme JAMAIS — c'est tout l'enjeu. Pas de res.end().
      return;
    }
    if (req.url?.startsWith("/api/hot-files")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([{ file_path: "src/a.ts" }]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on("connection", (s) => openSockets.push(s));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const s of openSockets) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

/** Résout en "PENDING" si la promesse n'a pas rendu la main dans les temps. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | "PENDING"> {
  let timer: NodeJS.Timeout;
  const guard = new Promise<"PENDING">((r) => {
    timer = setTimeout(() => r("PENDING"), ms);
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}

describe("#58 — /api/events ne se ferme jamais", () => {
  it("fetchLatestEventId rend la main au lieu d'attendre indéfiniment", async () => {
    const started = Date.now();
    const result = await within(fetchLatestEventId(baseUrl), VERDICT_MS);

    expect(result, "l'appel n'a jamais rendu la main — le budget ne couvre pas la lecture du corps").not.toBe("PENDING");
    expect(Date.now() - started).toBeLessThan(VERDICT_MS);
  }, 20000);

  it("fetchLatestEventId rapporte le replay reçu, il ne le jette pas", async () => {
    // Le piège du correctif naïf : lire le corps sous le même AbortController
    // fait rejeter resp.text() au timeout, donc renvoie 0 — l'appel rend bien la
    // main, mais on a perdu exactement ce qu'on venait chercher.
    const result = await within(fetchLatestEventId(baseUrl), VERDICT_MS);

    expect(result).toBe(43);
  }, 20000);

  it("fetchCoordinatorMetrics compte les événements du replay", async () => {
    const result = await within(fetchCoordinatorMetrics(baseUrl, 1), VERDICT_MS);

    expect(result, "l'appel n'a jamais rendu la main").not.toBe("PENDING");
    const metrics = result as Awaited<ReturnType<typeof fetchCoordinatorMetrics>>;
    expect(metrics.threads_opened).toBe(2);
    expect(metrics.messages_exchanged).toBe(1);
  }, 20000);

  it("tient nettement sous le budget documenté quand le replay arrive vite", async () => {
    // Sans ça, une implémentation qui attend bêtement l'expiration du budget
    // passerait les tests ci-dessus tout en ajoutant 3 s au démarrage ET à la
    // fin de chaque run.
    const started = Date.now();
    const result = await within(fetchLatestEventId(baseUrl), VERDICT_MS);

    // Le résultat est réassert ici EN PLUS du chrono : sans lui, un appel qui
    // échoue vite (socket réutilisé et cassé, par exemple) renvoie 0 en quelques
    // millisecondes et ferait passer ce test sans rien garantir.
    expect(result).toBe(43);
    expect(Date.now() - started).toBeLessThan(BUDGET_MS);
  }, 20000);
});

// La fenetre d'inactivite (SSE_REPLAY_IDLE_MS = 250 ms) dit « un court silence
// APRES la rafale ». La boucle de lecture l'honorait des la PREMIERE iteration,
// avant d'avoir lu le moindre octet : sur une machine chargee — un runner CI a
// 2 coeurs, par exemple — un premier chunk qui tarde rendait un corps VIDE, et
// le fichier ci-dessus tombait par intermittence (3 echecs sur un `pnpm test`
// complet, vert au suivant). Le budget global reste le filet dur.
describe("le silence d'inactivite ne compte qu'APRES le premier octet", () => {
  /** Nettement au-dela des 250 ms d'inactivite, nettement en deca des 3 s de budget. */
  const REPLAY_DELAY_MS = 700;

  let slowServer: Server;
  let slowUrl: string;
  const slowSockets: import("node:net").Socket[] = [];
  const pendingWrites: NodeJS.Timeout[] = [];

  beforeAll(async () => {
    slowServer = createServer((req, res) => {
      if (!req.url?.startsWith("/api/events")) {
        res.writeHead(404);
        res.end();
        return;
      }
      // Les en-tetes partent tout de suite — c'est ce que fait handleSse — mais
      // le replay, lui, se fait attendre. Et on ne ferme JAMAIS.
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.flushHeaders();
      pendingWrites.push(setTimeout(() => res.write(REPLAY), REPLAY_DELAY_MS));
    });
    slowServer.on("connection", (s) => slowSockets.push(s));
    await new Promise<void>((r) => slowServer.listen(0, "127.0.0.1", r));
    slowUrl = `http://127.0.0.1:${(slowServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const t of pendingWrites) clearTimeout(t);
    for (const s of slowSockets) s.destroy();
    await new Promise<void>((r) => slowServer.close(() => r()));
  });

  it("attend le replay au lieu de rendre un corps vide", async () => {
    // Avant le correctif : la course idle gagne des la premiere iteration, le
    // corps est "", parseSseEvents ne trouve rien et l'appel renvoie 0.
    const result = await within(fetchLatestEventId(slowUrl), VERDICT_MS);

    expect(result, "un replay tardif ne doit pas etre lu comme un flux vide").toBe(43);
  }, 20000);

  it("rend quand meme la main sous le budget documente", async () => {
    // Le correctif ne doit pas transformer l'attente en « on sort le budget » :
    // une fois la rafale arrivee, le silence qui suit conclut toujours.
    const started = Date.now();
    const result = await within(fetchCoordinatorMetrics(slowUrl, 1), VERDICT_MS);

    const metrics = result as Awaited<ReturnType<typeof fetchCoordinatorMetrics>>;
    expect(metrics.threads_opened).toBe(2);
    expect(Date.now() - started).toBeLessThan(BUDGET_MS);
  }, 20000);
});
