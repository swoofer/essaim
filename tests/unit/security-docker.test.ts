import { describe, it, expect } from "vitest";
import { dockerInspectArgs } from "../../src/security/docker.js";

describe("dockerInspectArgs", () => {
  it("builds inspect argv", () => {
    expect(dockerInspectArgs("ghcr.io/usestrix/strix-sandbox@sha256:abc")).toEqual([
      "image",
      "inspect",
      "ghcr.io/usestrix/strix-sandbox@sha256:abc",
    ]);
  });
});
