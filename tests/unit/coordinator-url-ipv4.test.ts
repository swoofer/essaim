import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Le coordinator se lie à 127.0.0.1 (mcp-coordinator serve-http.ts :
 * bindHost = COORDINATOR_BIND || "127.0.0.1"). Annoncer `localhost` aux agents
 * est un pari sur la résolution DNS : sur un hôte IPv6-first — le défaut de
 * Windows — `localhost` résout en ::1, où rien n'écoute.
 *
 * Observé en conditions réelles : sur un raid à 3 agents, un seul joignait le
 * coordinator ; les deux autres échouaient en MQTT ET en HTTP avec un
 * `fetch failed`, alors que le serveur tournait toujours. curl masque le
 * problème parce qu'il bascule en IPv4 ; fetch et mqtt.js ne le font pas.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SOURCES = [
  "src/orchestrator/orchestrator.ts",
  "cli/config.ts",
  "cli/init.ts",
  "scripts/check_interrupt.sh",
  "scripts/pre_track_activity.sh",
  "scripts/session_start.sh",
  "scripts/session_stop.sh",
  "scripts/track_activity.sh",
];

describe("les URLs de coordinator par défaut visent 127.0.0.1, pas localhost", () => {
  for (const rel of SOURCES) {
    it(`${rel} n'emploie pas localhost pour le coordinator`, () => {
      const text = readFileSync(resolve(ROOT, rel), "utf8");
      // On ne regarde que les URLs effectives, pas les commentaires : une ligne
      // de documentation qui écrit localhost est inoffensive.
      const offending = text
        .split("\n")
        .filter((l) => /(https?|mqtt|ws):\/\/localhost:/.test(l))
        .filter((l) => !/^(\*|\/\/|#)/.test(l.trim()));
      expect(offending).toEqual([]);
    });
  }
});
