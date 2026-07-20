import { describe, it, expect } from "vitest";
import { mqttWsUrl } from "../../src/orchestrator/agent-launcher.js";

describe("mqttWsUrl", () => {
  it("maps http coordinator to ws /mqtt", () => {
    expect(mqttWsUrl("http://localhost:3100")).toBe("ws://localhost:3100/mqtt");
  });

  it("maps https coordinator to wss /mqtt", () => {
    expect(mqttWsUrl("https://coordinator.example.com")).toBe(
      "wss://coordinator.example.com/mqtt",
    );
  });

  it("keeps an explicit port", () => {
    expect(mqttWsUrl("https://host.example.com:8443")).toBe("wss://host.example.com:8443/mqtt");
  });

  it("preserves a path prefix (coordinator served under a sub-path)", () => {
    // Regression: mqttWsUrl used to drop the path, producing wss://host/mqtt
    // and breaking the WS upgrade behind a path-prefixed ingress.
    expect(mqttWsUrl("https://gw.example.com/coordinator")).toBe(
      "wss://gw.example.com/coordinator/mqtt",
    );
  });

  it("does not double the slash when the base URL has a trailing slash", () => {
    expect(mqttWsUrl("https://gw.example.com/coordinator/")).toBe(
      "wss://gw.example.com/coordinator/mqtt",
    );
  });

  it("a root path stays a single /mqtt (no empty segment)", () => {
    expect(mqttWsUrl("http://localhost:3100/")).toBe("ws://localhost:3100/mqtt");
  });
});
