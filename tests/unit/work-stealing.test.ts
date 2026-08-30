import { describe, it, expect, vi, afterEach } from "vitest";
import { parseDiscoveries, postDiscoveries, claimNextTask, completeTask, parseReviewActions, COORDINATOR_UNREACHABLE } from "../../src/agent-loop/work-stealing.js";

describe("parseDiscoveries", () => {
  it("parses pipe-separated discovery format", () => {
    const output = `I found some bugs.\n\nDISCOVERY:\nsrc/auth/middleware.ts | 42 | Missing null check on token | critical\nsrc/users/service.ts | 15 | Empty array not handled | major`;
    const tasks = parseDiscoveries(output);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ file: "src/auth/middleware.ts", line: 42, description: "Missing null check on token", severity: "critical" });
    expect(tasks[1]).toMatchObject({ file: "src/users/service.ts", line: 15, severity: "major" });
  });

  it("returns empty when no DISCOVERY marker", () => {
    expect(parseDiscoveries("No bugs found.")).toEqual([]);
  });

  it("handles markdown list format", () => {
    const output = "DISCOVERY:\n- src/a.ts | 10 | Bug A | major\n- src/b.ts | 20 | Bug B | minor";
    expect(parseDiscoveries(output)).toHaveLength(2);
  });

  it("skips malformed lines (less than 3 parts)", () => {
    const output = "DISCOVERY:\nNot a valid line\nsrc/a.ts | 10 | Valid | critical\nAnother bad";
    expect(parseDiscoveries(output)).toHaveLength(1);
  });

  it("handles empty lines gracefully", () => {
    const output = "DISCOVERY:\n\nsrc/a.ts | 10 | Bug | major\n\n";
    expect(parseDiscoveries(output)).toHaveLength(1);
  });

  it("defaults severity to minor when not provided", () => {
    const output = "DISCOVERY:\nsrc/a.ts | 10 | Some bug";
    const tasks = parseDiscoveries(output);
    expect(tasks[0].severity).toBe("minor");
  });
});

describe("postDiscoveries", () => {
  it("sends keep_open: true to prevent auto-resolve", async () => {
    const capturedBodies: Record<string, unknown>[] = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      capturedBodies.push(JSON.parse(init.body as string));
      return {
        ok: true,
        json: async () => ({ thread_id: "t-123", status: "open" }),
      };
    });
    vi.stubGlobal("fetch", mockFetch);

    const tasks = [{ id: "", description: "Missing null check", file: "src/auth.ts", line: 42, severity: "critical" }];
    const result = await postDiscoveries("http://localhost:3100", "agent-1", tasks);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t-123");
    expect(capturedBodies[0]).toMatchObject({ keep_open: true });

    vi.unstubAllGlobals();
  });
});

// claimNextTask rend désormais Task | null | COORDINATOR_UNREACHABLE (#151) :
// ce garde narrow vers un vrai Task pour l'accès aux propriétés dans les tests.
function asTask(t: Awaited<ReturnType<typeof claimNextTask>>): { id: string; description: string; file?: string; severity?: string } {
  if (t === null || t === COORDINATOR_UNREACHABLE) throw new Error(`attendu un Task, reçu ${String(t)}`);
  return t;
}

// ── claimNextTask ─────────────────────────────────────────────────────

describe("claimNextTask", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("claims first open unclaimed thread", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/threads-active")) {
        return {
          ok: true,
          json: async () => [
            { id: "t-1", status: "open", claimed_by: null, subject: "Bug in auth" },
            { id: "t-2", status: "open", claimed_by: null, subject: "CSS broken" },
          ],
        };
      }
      if (url.includes("/api/claim-task")) {
        return { ok: true, json: async () => ({ success: true }) };
      }
      return { ok: false };
    });
    vi.stubGlobal("fetch", mockFetch);

    const task = await claimNextTask("http://localhost:3100", "agent-1");

    expect(task).not.toBeNull();
    expect(asTask(task).id).toBe("t-1");
    expect(asTask(task).description).toBe("Bug in auth");
    // Should have called threads-active then claim-task (2 fetches total)
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("skips already-claimed threads", async () => {
    const claimedUrls: string[] = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/threads-active")) {
        return {
          ok: true,
          json: async () => [
            { id: "t-1", status: "open", claimed_by: "other-agent", subject: "Taken" },
            { id: "t-2", status: "open", claimed_by: null, subject: "Available" },
          ],
        };
      }
      if (url.includes("/api/claim-task")) {
        claimedUrls.push(url);
        const body = JSON.parse(init?.body as string);
        return { ok: true, json: async () => ({ success: true, thread_id: body.thread_id }) };
      }
      return { ok: false };
    });
    vi.stubGlobal("fetch", mockFetch);

    const task = await claimNextTask("http://localhost:3100", "agent-1");

    expect(task).not.toBeNull();
    expect(asTask(task).id).toBe("t-2");
    expect(asTask(task).description).toBe("Available");
    // claim-task should only be called once (skipped t-1)
    expect(claimedUrls).toHaveLength(1);
  });

  it("skips non-open threads", async () => {
    const claimedBodies: Record<string, unknown>[] = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/threads-active")) {
        return {
          ok: true,
          json: async () => [
            { id: "t-1", status: "resolving", claimed_by: null, subject: "Resolving" },
            { id: "t-2", status: "open", claimed_by: null, subject: "Open task" },
          ],
        };
      }
      if (url.includes("/api/claim-task")) {
        claimedBodies.push(JSON.parse(init?.body as string));
        return { ok: true, json: async () => ({ success: true }) };
      }
      return { ok: false };
    });
    vi.stubGlobal("fetch", mockFetch);

    const task = await claimNextTask("http://localhost:3100", "agent-1");

    expect(task).not.toBeNull();
    expect(asTask(task).id).toBe("t-2");
    // claim-task called once, for t-2 only
    expect(claimedBodies).toHaveLength(1);
    expect(claimedBodies[0].thread_id).toBe("t-2");
  });

  it("handles race condition — claim fails, tries next", async () => {
    let claimCallCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/threads-active")) {
        return {
          ok: true,
          json: async () => [
            { id: "t-1", status: "open", claimed_by: null, subject: "Race lost" },
            { id: "t-2", status: "open", claimed_by: null, subject: "Race won" },
          ],
        };
      }
      if (url.includes("/api/claim-task")) {
        claimCallCount++;
        // First claim fails (another agent got it), second succeeds
        if (claimCallCount === 1) {
          return { ok: true, json: async () => ({ success: false }) };
        }
        return { ok: true, json: async () => ({ success: true }) };
      }
      return { ok: false };
    });
    vi.stubGlobal("fetch", mockFetch);

    const task = await claimNextTask("http://localhost:3100", "agent-1");

    expect(task).not.toBeNull();
    expect(asTask(task).id).toBe("t-2");
    expect(asTask(task).description).toBe("Race won");
    expect(claimCallCount).toBe(2);
  });

  it("returns null when no threads available", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/threads-active")) {
        return { ok: true, json: async () => [] };
      }
      return { ok: false };
    });
    vi.stubGlobal("fetch", mockFetch);

    const task = await claimNextTask("http://localhost:3100", "agent-1");

    expect(task).toBeNull();
  });

  it("signale COORDINATOR_UNREACHABLE (≠ null) quand le fetch est rejeté (#151)", async () => {
    // Coordinator injoignable NE DOIT PAS se confondre avec « piscine vide » :
    // sinon la boucle sort en "done" et le rapport est un faux vert.
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", mockFetch);

    const task = await claimNextTask("http://localhost:3100", "agent-1");

    expect(task).toBe(COORDINATOR_UNREACHABLE);
    expect(task).not.toBeNull(); // ≠ du null « rien à réclamer »
  });

  it("signale COORDINATOR_UNREACHABLE quand threads-active répond non-ok (500) (#151)", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/threads-active")) return { ok: false, status: 500 };
      return { ok: false };
    });
    vi.stubGlobal("fetch", mockFetch);

    const task = await claimNextTask("http://localhost:3100", "agent-1");

    expect(task).toBe(COORDINATOR_UNREACHABLE);
  });

  it("returns null when all claims fail", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/threads-active")) {
        return {
          ok: true,
          json: async () => [
            { id: "t-1", status: "open", claimed_by: null, subject: "Task A" },
            { id: "t-2", status: "open", claimed_by: null, subject: "Task B" },
          ],
        };
      }
      if (url.includes("/api/claim-task")) {
        return { ok: true, json: async () => ({ success: false }) };
      }
      return { ok: false };
    });
    vi.stubGlobal("fetch", mockFetch);

    const task = await claimNextTask("http://localhost:3100", "agent-1");

    expect(task).toBeNull();
  });

  it("returns null (pas injoignable) quand la piscine est vraiment vide via un claim ratant tout", async () => {
    // Un coordinator JOIGNABLE dont tous les claims échouent = « rien à réclamer »
    // (null), à ne pas confondre avec injoignable — cf. les tests dédiés #151.
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/threads-active")) {
        return { ok: true, json: async () => [{ id: "t-9", status: "open", claimed_by: null, subject: "X" }] };
      }
      if (url.includes("/api/claim-task")) return { ok: true, json: async () => ({ success: false }) };
      return { ok: false };
    });
    vi.stubGlobal("fetch", mockFetch);

    const task = await claimNextTask("http://localhost:3100", "agent-1");

    expect(task).toBeNull();
  });

  it("uses 'Unknown task' when thread has no subject", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/threads-active")) {
        return {
          ok: true,
          json: async () => [
            { id: "t-1", status: "open", claimed_by: null },
          ],
        };
      }
      if (url.includes("/api/claim-task")) {
        return { ok: true, json: async () => ({ success: true }) };
      }
      return { ok: false };
    });
    vi.stubGlobal("fetch", mockFetch);

    const task = await claimNextTask("http://localhost:3100", "agent-1");

    expect(task).not.toBeNull();
    expect(asTask(task).description).toBe("?");
  });

  it("skips thread when claim-task throws and tries next", async () => {
    let claimCallCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/threads-active")) {
        return {
          ok: true,
          json: async () => [
            { id: "t-1", status: "open", claimed_by: null, subject: "Throws" },
            { id: "t-2", status: "open", claimed_by: null, subject: "Works" },
          ],
        };
      }
      if (url.includes("/api/claim-task")) {
        claimCallCount++;
        if (claimCallCount === 1) {
          // claim-task endpoint returns non-ok (coordinatorPost throws)
          return { ok: false, status: 500 };
        }
        return { ok: true, json: async () => ({ success: true }) };
      }
      return { ok: false };
    });
    vi.stubGlobal("fetch", mockFetch);

    const task = await claimNextTask("http://localhost:3100", "agent-1");

    expect(task).not.toBeNull();
    expect(asTask(task).id).toBe("t-2");
    expect(asTask(task).description).toBe("Works");
  });
});

// ── completeTask ──────────────────────────────────────────────────────

describe("completeTask", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("propose PUIS auto-approuve — sinon le thread reste bloque en 'resolving'", async () => {
    // #2 — propose-resolution seul laisse le thread en 'resolving' : le
    // coordinator attend une approbation, qui n'etait JAMAIS emise. Mesure :
    // sur 6 runs, TOUS les threads resolus finissaient 'resolving', jamais
    // 'resolved' — la couche de consensus ne concluait pas. L'agent qui a fait
    // le travail auto-approuve : pour un thread sans expected_respondents (le
    // cas mesure, exp=[]), une seule approbation suffit -> resolved.
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      calls.push({ url: url as string, body: JSON.parse(init.body as string) });
      return { ok: true, json: async () => ({ status: "resolving" }) };
    });
    vi.stubGlobal("fetch", mockFetch);

    await completeTask("http://localhost:3100", "t-42", "agent-1", "Fixed the null check");

    expect(calls[0].url).toBe("http://localhost:3100/api/propose-resolution");
    expect(calls[0].body).toEqual({
      thread_id: "t-42",
      agent_id: "agent-1",
      summary: "Fixed the null check",
    });
    // L'auto-approbation, meme agent, meme thread.
    expect(calls[1].url).toBe("http://localhost:3100/api/approve-resolution");
    expect(calls[1].body).toMatchObject({ thread_id: "t-42", agent_id: "agent-1" });
  });

  it("doesn't throw on network failure", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", mockFetch);

    // Should not throw — completeTask catches errors
    await expect(completeTask("http://localhost:3100", "t-42", "agent-1", "Done")).resolves.toBeUndefined();
  });

  it("doesn't throw on non-ok response", async () => {
    const mockFetch = vi.fn().mockImplementation(async () => ({
      ok: false,
      status: 500,
    }));
    vi.stubGlobal("fetch", mockFetch);

    // coordinatorPost throws on non-ok, but completeTask catches it
    await expect(completeTask("http://localhost:3100", "t-42", "agent-1", "Done")).resolves.toBeUndefined();
  });
});

// ── parseReviewActions ───────────────────────────────────────────────

describe("parseReviewActions", () => {
  it("parses NOUVEAU action", () => {
    const output = "Some intro\n\nREVIEW:\nNOUVEAU | Missing null check in auth.ts:42";
    const actions = parseReviewActions(output);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({ type: "nouveau", description: "Missing null check in auth.ts:42" });
  });

  it("parses DOUBLON action", () => {
    const output = "REVIEW:\nDOUBLON | thread-abc-123";
    const actions = parseReviewActions(output);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({ type: "doublon", threadId: "thread-abc-123" });
  });

  it("parses ENRICHIT action", () => {
    const output = "REVIEW:\nENRICHIT | thread-def-456 | Le même bug se manifeste aussi quand le header est vide";
    const actions = parseReviewActions(output);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({ type: "enrichit", threadId: "thread-def-456", context: "Le même bug se manifeste aussi quand le header est vide" });
  });

  it("parses mixed actions", () => {
    const output = "REVIEW:\nNOUVEAU | Bug A\nDOUBLON | t1\nENRICHIT | t2 | Extra context\nNOUVEAU | Bug B";
    const actions = parseReviewActions(output);
    expect(actions).toHaveLength(4);
    expect(actions[0].type).toBe("nouveau");
    expect(actions[1].type).toBe("doublon");
    expect(actions[2].type).toBe("enrichit");
    expect(actions[3].type).toBe("nouveau");
  });

  it("returns empty when no REVIEW marker", () => {
    expect(parseReviewActions("No review here")).toEqual([]);
  });

  it("skips malformed lines", () => {
    const output = "REVIEW:\nINVALID action\nNOUVEAU | Valid";
    const actions = parseReviewActions(output);
    expect(actions).toHaveLength(1);
  });

  it("is case-insensitive for action names", () => {
    const output = "REVIEW:\nnouveau | Bug\ndoublon | t1\nenrichit | t2 | ctx";
    const actions = parseReviewActions(output);
    expect(actions).toHaveLength(3);
  });

  it("skips ENRICHIT without context (needs 3 parts)", () => {
    const output = "REVIEW:\nENRICHIT | thread-only";
    const actions = parseReviewActions(output);
    expect(actions).toHaveLength(0);
  });
});

