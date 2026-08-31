import { describe, it, expect, vi, afterEach } from "vitest";
import { preflightQuotaCheck } from "../../src/orchestrator/preflight.js";

// #173 — « quota indisponible sur cette plateforme » doit être une LIGNE TEXTE
// lisible au démarrage (fréquent sous Windows, où le jeton d'abonnement n'est
// souvent pas lisible → 503), pas un log.warn JSON pino illisible.
describe("preflightQuotaCheck — quota indisponible en ligne texte (#173)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("503 ⇒ console.error d'une ligne texte (pas du JSON), et fail-open (canProceed)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchFn = (async () => ({
      status: 503,
      ok: false,
      json: async () => ({ reason: "jeton illisible" }),
    })) as unknown as typeof fetch;

    const res = await preflightQuotaCheck({ coordinatorUrl: "http://c", maxUtilizationPct: 90, fetchFn });

    expect(res.canProceed).toBe(true); // fail-open : le run continue
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0][0] as string;
    expect(typeof line).toBe("string");
    expect(line).toContain("quota indisponible");
    expect(line.trim().startsWith("{")).toBe(false); // une vraie ligne, pas du JSON
  });
});
