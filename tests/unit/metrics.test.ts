import { describe, it, expect } from "vitest";
import { parseSseEvents, computeMetrics } from "../../src/orchestrator/metrics.js";

describe("parseSseEvents", () => {
  it("parses SSE stream into typed events", () => {
    const raw = [
      'id: 1\nevent: thread_opened\ndata: {"thread_id":"t1","agent_id":"a1"}\n',
      'id: 2\nevent: message_posted\ndata: {"thread_id":"t1","agent_id":"a2"}\n',
      'id: 3\nevent: impact_scored\ndata: {"score":100,"category":"concerned","reasons":["Layer 0a"]}\n',
    ].join("\n");

    const events = parseSseEvents(raw);
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("thread_opened");
    expect(events[2].data.score).toBe(100);
  });
});

describe("computeMetrics", () => {
  it("counts threads by resolution type", () => {
    const events = [
      { id: 1, type: "thread_opened", data: { thread_id: "t1" } },
      { id: 2, type: "thread_opened", data: { thread_id: "t2" } },
      { id: 3, type: "impact_scored", data: { thread_id: "t1", score: 100, category: "concerned", reasons: ["Layer 0a"] } },
      { id: 4, type: "message_posted", data: { thread_id: "t1" } },
      { id: 5, type: "message_posted", data: { thread_id: "t1" } },
    ];

    const metrics = computeMetrics(events);
    expect(metrics.threads_opened).toBe(2);
    expect(metrics.messages_exchanged).toBe(2);
    expect(metrics.conflicts_by_layer["Layer 0a"]).toBe(1);
  });

  // #117 — a thread that gets contested and re-proposed emits MULTIPLE
  // resolution_proposed events for the same thread_id, which is why the
  // original dedup existed. But dedup wasn't enough: `resolution_proposed`
  // only ever says "someone PROPOSED" — on the coordinator side a proposal
  // moves a thread to `resolving`, never to `resolved`
  // (consultation.proposeResolution). Consensus is now read off
  // `thread_resolved` / resolution_type === "consensus".
  it("a proposal is not a consensus, even repeated", () => {
    const events = [
      { id: 1, type: "thread_opened", data: { thread_id: "t1" } },
      { id: 2, type: "resolution_proposed", data: { thread_id: "t1" } },
      { id: 3, type: "resolution_proposed", data: { thread_id: "t1" } }, // contest → re-propose
      { id: 4, type: "resolution_proposed", data: { thread_id: "t1" } }, // contest → re-propose again
    ];

    const metrics = computeMetrics(events);
    expect(metrics.threads_resolved_consensus).toBe(0);
    expect(metrics.threads_auto_resolved).toBe(0);
    expect(metrics.threads_without_consensus).toBe(1);
  });

  it("counts consensus, auto-resolution and the rest off thread_resolved", () => {
    const events = [
      { id: 1, type: "thread_opened", data: { thread_id: "t1" } },
      { id: 2, type: "thread_opened", data: { thread_id: "t2" } },
      { id: 3, type: "thread_opened", data: { thread_id: "t3" } },
      // t1: proposed three times, never approved — poisoned or abandoned.
      { id: 4, type: "resolution_proposed", data: { thread_id: "t1" } },
      { id: 5, type: "resolution_proposed", data: { thread_id: "t1" } },
      { id: 6, type: "resolution_proposed", data: { thread_id: "t1" } },
      // t2: proposed THEN approved by all expected respondents.
      { id: 7, type: "resolution_proposed", data: { thread_id: "t2" } },
      { id: 8, type: "thread_resolved", data: { thread_id: "t2", resolution_type: "consensus" } },
      // t3: no agent concerned — the coordinator closes it on its own.
      { id: 9, type: "thread_resolved", data: { thread_id: "t3", resolution_type: "auto_resolved" } },
    ];

    const metrics = computeMetrics(events);
    expect(metrics.threads_opened).toBe(3);
    expect(metrics.threads_resolved_consensus).toBe(1); // t2 only
    expect(metrics.threads_auto_resolved).toBe(1); // t3 only
    expect(metrics.threads_without_consensus).toBe(1); // t1
  });

  it("doesn't go negative when the event window misses a thread_opened", () => {
    // The SSE cursor can start after a thread's own thread_opened while still
    // including its resolution.
    const events = [
      { id: 1, type: "thread_resolved", data: { thread_id: "t1", resolution_type: "consensus" } },
      { id: 2, type: "thread_resolved", data: { thread_id: "t2", resolution_type: "consensus" } },
    ];

    const metrics = computeMetrics(events);
    expect(metrics.threads_opened).toBe(0);
    expect(metrics.threads_resolved_consensus).toBe(2);
    expect(metrics.threads_without_consensus).toBe(0);
  });

  it("a real run: 4 threads opened, 9 distinct thread_ids proposed, zero real agreement", () => {
    // A real run printed "Threads ouverts 4 | Consensus 9 | Auto-resolved 0".
    // The thread_id dedup (#117) was already in place at that point — the
    // inflation doesn't come from repeated proposals on the same thread, but
    // from nine DISTINCT thread_ids proposed, five of which were opened
    // outside the SSE window (the Last-Event-ID cursor is set at run start;
    // these threads were inherited from a previous run, proposed then
    // abandoned). None approved: no thread_resolved in the stream.
    const events = [
      { id: 1, type: "thread_opened", data: { thread_id: "t1" } },
      { id: 2, type: "thread_opened", data: { thread_id: "t2" } },
      { id: 3, type: "thread_opened", data: { thread_id: "t3" } },
      { id: 4, type: "thread_opened", data: { thread_id: "t4" } },
      { id: 5, type: "resolution_proposed", data: { thread_id: "t1" } },
      { id: 6, type: "resolution_proposed", data: { thread_id: "t2" } },
      { id: 7, type: "resolution_proposed", data: { thread_id: "t3" } },
      { id: 8, type: "resolution_proposed", data: { thread_id: "t4" } },
      { id: 9, type: "resolution_proposed", data: { thread_id: "t5" } },
      { id: 10, type: "resolution_proposed", data: { thread_id: "t6" } },
      { id: 11, type: "resolution_proposed", data: { thread_id: "t7" } },
      { id: 12, type: "resolution_proposed", data: { thread_id: "t8" } },
      { id: 13, type: "resolution_proposed", data: { thread_id: "t9" } },
    ];

    const metrics = computeMetrics(events);
    expect(metrics.threads_opened).toBe(4);
    expect(metrics.threads_resolved_consensus).toBe(0); // the old calc printed 9
    expect(metrics.threads_auto_resolved).toBe(0);
    expect(metrics.threads_without_consensus).toBe(4);
  });
});

