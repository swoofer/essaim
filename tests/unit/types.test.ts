import { describe, it, expect } from "vitest";
import type {
  Thread,
  ThreadMessage,
  CoordinatorEvent,
  ConflictReport,
} from "mcp-coordinator/types";

// These tests guard against silent drift between essaim's expectations and
// mcp-coordinator's exported unions. We use `satisfies Record<Union, true>`
// so adding a new member upstream is a *compile error* here (the object
// literal stops covering the union) — not a passing test we trust by mistake.
// The earlier shape — `const xs: Union[] = [...]; expect(xs).toHaveLength(N)`
// — never caught additions: `Union[]` is happy with a strict subset, and the
// runtime length check just re-asserts the literal we wrote.

describe("Types", () => {
  it("Thread status values are exhaustive", () => {
    const keys = {
      open: true,
      resolving: true,
      resolved: true,
      cancelled: true,
      poisoned: true,
    } as const satisfies Record<Thread["status"], true>;
    expect(Object.keys(keys).sort()).toEqual(
      ["cancelled", "open", "poisoned", "resolved", "resolving"],
    );
  });

  it("MessageType values are exhaustive", () => {
    const keys = {
      context: true,
      suggestion: true,
      warning: true,
      resolution: true,
      approve: true,
      contest: true,
    } as const satisfies Record<ThreadMessage["type"], true>;
    expect(Object.keys(keys)).toHaveLength(6);
  });

  it("EventType values are exhaustive", () => {
    const keys = {
      agent_online: true,
      agent_offline: true,
      thread_opened: true,
      message_posted: true,
      resolution_proposed: true,
      thread_resolved: true,
      thread_cancelled: true,
      file_edited: true,
      action_summary: true,
      impact_scored: true,
      introspection_requested: true,
      introspection_completed: true,
      agent_activity: true,
      task_claimed: true,
      token_usage: true,
      quota_update: true,
    } as const satisfies Record<CoordinatorEvent["type"], true>;
    expect(Object.keys(keys)).toHaveLength(16);
  });

  it("ConflictReport types are exhaustive", () => {
    const keys = {
      module_overlap: true,
      api_contract: true,
      file_overlap: true,
      dependency_chain: true,
    } as const satisfies Record<ConflictReport["type"], true>;
    expect(Object.keys(keys)).toHaveLength(4);
  });
});
