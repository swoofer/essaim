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
  // resolution_proposed events for the same thread_id. A flat count of those
  // events both over-counts threads_resolved_consensus and can push
  // threads_auto_resolved negative.
  it("dedups resolution_proposed by thread_id — a re-proposed thread counts once", () => {
    const events = [
      { id: 1, type: "thread_opened", data: { thread_id: "t1" } },
      { id: 2, type: "resolution_proposed", data: { thread_id: "t1" } },
      { id: 3, type: "resolution_proposed", data: { thread_id: "t1" } }, // contest → re-propose
      { id: 4, type: "resolution_proposed", data: { thread_id: "t1" } }, // contest → re-propose again
    ];

    const metrics = computeMetrics(events);
    expect(metrics.threads_resolved_consensus).toBe(1);
    expect(metrics.threads_auto_resolved).toBe(0);
  });

  it("threads_auto_resolved never goes negative even when resolutions outnumber opens", () => {
    // e.g. the observed event window's cursor started after a thread's own
    // thread_opened event but still includes its resolution.
    const events = [
      { id: 1, type: "resolution_proposed", data: { thread_id: "t1" } },
      { id: 2, type: "resolution_proposed", data: { thread_id: "t2" } },
    ];

    const metrics = computeMetrics(events);
    expect(metrics.threads_opened).toBe(0);
    expect(metrics.threads_resolved_consensus).toBe(2);
    expect(metrics.threads_auto_resolved).toBe(0);
  });
});

