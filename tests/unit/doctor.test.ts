import { describe, it, expect } from "vitest";
import { runDoctor, formatDoctorReport, type DoctorDeps } from "../../src/orchestrator/doctor.js";

// Un jeu de deps « tout va bien », qu'on degrade cas par cas.
function healthyDeps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    probe: () => true,
    resolveClaudeBin: () => "claude",
    portFree: () => true,
    catalogOk: () => true,
    platform: "linux",
    coordinatorUrl: undefined,
    ...over,
  };
}

describe("runDoctor", () => {
  it("tout present -> ok, aucun fail", () => {
    const r = runDoctor(healthyDeps());
    expect(r.ok).toBe(true);
    expect(r.checks.some((c) => c.status === "fail")).toBe(false);
  });

  it("Claude Code absent -> fail CRITIQUE avec une commande d'installation, ok=false", () => {
    // probe rend false pour le bin claude (present mais muet, ou introuvable).
    const r = runDoctor(healthyDeps({ probe: (bin) => bin !== "claude" }));
    expect(r.ok).toBe(false);
    const claude = r.checks.find((c) => c.name === "claude")!;
    expect(claude.status).toBe("fail");
    expect(claude.critical).toBe(true);
    // Le hint DOIT contenir une commande d'installation — pas juste « erreur ».
    expect(claude.hint).toMatch(/install/i);
  });

  it("catalogue introuvable -> fail critique, ok=false", () => {
    const r = runDoctor(healthyDeps({ catalogOk: () => false }));
    expect(r.ok).toBe(false);
    const cat = r.checks.find((c) => c.name === "catalog")!;
    expect(cat.status).toBe("fail");
    expect(cat.hint).toBeTruthy();
  });

  it("jq/curl absents -> WARN, pas fail : ok reste true (un warn ne bloque pas)", () => {
    const r = runDoctor(healthyDeps({ probe: (bin) => bin === "claude" }));
    expect(r.ok).toBe(true); // jq/curl manquants ne sont pas critiques
    const jq = r.checks.find((c) => c.name === "jq")!;
    expect(jq.status).toBe("warn");
    expect(jq.hint).toBeTruthy();
  });

  it("hint jq adapte a la plateforme", () => {
    const win = runDoctor(healthyDeps({ probe: (b) => b === "claude", platform: "win32" }));
    expect(win.checks.find((c) => c.name === "jq")!.hint).toContain("winget");
    const mac = runDoctor(healthyDeps({ probe: (b) => b === "claude", platform: "darwin" }));
    expect(mac.checks.find((c) => c.name === "jq")!.hint).toContain("brew");
  });

  it("port 3100 occupe -> WARN (pas critique), ok reste true", () => {
    const r = runDoctor(healthyDeps({ portFree: (p) => p !== 3100 }));
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.name === "port-3100")!.status).toBe("warn");
  });

  it("COORDINATOR_URL defini -> les ports locaux ne sont pas testes", () => {
    const r = runDoctor(healthyDeps({ coordinatorUrl: "https://c.example", portFree: () => false }));
    // portFree rend false partout, mais comme COORDINATOR_URL est defini, aucun
    // warn de port : le coordinator local n'est pas requis.
    expect(r.checks.some((c) => c.name === "port-1883")).toBe(false);
    expect(r.ok).toBe(true);
  });

  it("claude est sondé SANS shell, jq/curl AVEC shell (fidèle au vrai lanceur)", () => {
    // Verrou anti-régression pour #148 : le vrai lanceur spawn claude sans
    // shell (claude-stream.ts) ; le sonder avec shell ferait passer un .cmd
    // shim npm (faux OK) et casserait sur un chemin à espace (faux échec).
    // jq/curl passent par des hooks shell → shell attendu.
    const calls: Array<{ bin: string; useShell: boolean }> = [];
    runDoctor(
      healthyDeps({
        probe: (bin, _v, useShell) => {
          calls.push({ bin, useShell });
          return true;
        },
      }),
    );
    expect(calls.find((c) => c.bin === "claude")!.useShell).toBe(false);
    expect(calls.find((c) => c.bin === "jq")!.useShell).toBe(true);
    expect(calls.find((c) => c.bin === "curl")!.useShell).toBe(true);
  });

  it("formatDoctorReport imprime le hint sous une ligne en echec, et le verdict", () => {
    const r = runDoctor(healthyDeps({ probe: (b) => b !== "claude" }));
    const txt = formatDoctorReport(r);
    expect(txt).toMatch(/install/i);
    expect(txt).toContain("ÉCHOUÉ");
  });
});
