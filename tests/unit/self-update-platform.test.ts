// tests/unit/self-update-platform.test.ts
//
// `essaim self-update` n'a jamais eu de chemin de mise à jour sur Windows.
// Mesuré sur Windows 11 : `mktemp` n'est pas dans le PATH, donc
// cli/self-update.ts:115 `execSync("mktemp -d")` meurt sur une erreur cmd.exe
// non rattrapée, juste après avoir annoncé « Update available ». Et si des
// coreutils traînent sur le PATH, c'est pire : le résolveur de plateforme
// `process.platform === "darwin" ? "darwin" : "linux"` (cli/self-update.ts:110)
// demande l'artefact LINUX — qui existe vraiment — et cli/self-update.ts:126-131
// le détare dans dirname(process.execPath). Le binaire win32-x64 est pourtant
// publié, mais Windows verrouille l'image en cours : aucune extraction en place
// n'est possible. La commande doit s'arrêter en disant quoi faire.
//
// Le dépôt n'a aucun patron pour falsifier `process.platform` — il ne fait que
// le LIRE (`it.skipIf(process.platform === "win32")` dans
// tests/unit/orchestrator-write.test.ts:98). On suit donc le patron réellement
// en place ici pour tester une décision : une fonction pure exportée qui prend
// son entrée en paramètre, comme `buildSoloArgs` (tests/unit/solo.test.ts) ou
// `assembleSecurity` (tests/unit/security-cli.test.ts).
import { describe, it, expect } from "vitest";
import { unsupportedPlatformNotice } from "../../cli/self-update.js";

describe("self-update — garde Windows", () => {
  it("refuse win32 et dit quoi faire à la place", () => {
    const notice = unsupportedPlatformNotice("win32");
    expect(notice).not.toBeNull();
    // Actionnable, pas un simple « non ».
    expect(notice).toContain("npm install -g essaim@latest");
    expect(notice).toContain("releases/latest");
    // Régression directe : c'est l'artefact que la commande téléchargeait avant.
    expect(notice).not.toContain("linux");
  });

  it("laisse passer darwin et linux", () => {
    expect(unsupportedPlatformNotice("darwin")).toBeNull();
    expect(unsupportedPlatformNotice("linux")).toBeNull();
  });
});
