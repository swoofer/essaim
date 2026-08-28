// tests/unit/self-update-cli.test.ts
//
// self-update-platform.test.ts covers unsupportedPlatformNotice() as a pure
// decision, well isolated from I/O. But nothing verifies that
// createSelfUpdateCommand()'s action actually CALLS it and exits 1 — deleting
// that guard, or hardcoding a `process.exit(0)` in its place, leaves that
// suite green (it never touches the command). This exercises the real action
// closure instead of the decision function alone.
//
// Scoped to win32 on purpose: the guard fires before any network call, so
// invoking the real action here is side-effect-free on Windows — no curl, no
// gh, no filesystem writes. Off win32 the guard is a no-op (returns null) and
// the action goes on to hit the network (fetchLatestTag) and spawn `mktemp`;
// that's not something a unit test should do, and it's also not the behavior
// under test here — so it's skipped rather than faked. The repo's CI matrix
// (.github/workflows/test.yml) runs a windows-latest leg, so this still
// executes for real in CI, not just in local dev on Windows.
import { describe, it, expect, vi } from "vitest";
import { createSelfUpdateCommand } from "../../cli/self-update.js";

describe.skipIf(process.platform !== "win32")(
  "essaim self-update — wiring de la garde Windows",
  () => {
    it("l'action appelle bien la garde et sort en 1, sans toucher au réseau", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await createSelfUpdateCommand().parseAsync([], { from: "user" });

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("ne fonctionne pas sur Windows"),
      );

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });
  },
);
