import { Command } from "commander";
import { execSync } from "child_process";
import { dirname } from "path";
import { getVersion } from "./version.js";

const REPO = "swoofer/essaim";

/**
 * Windows n'a pas de chemin de mise à jour en place, pour deux raisons cumulées :
 *
 *  - ce fichier pilote `command -v`, `mktemp -d`, `mv` et `rm -rf` via execSync,
 *    qui sous Windows lance cmd.exe : `mktemp` y est absent d'une installation
 *    standard, donc la commande meurt en cours de route ; et si des coreutils
 *    sont sur le PATH, le résolveur de plateforme plus bas ne connaît que darwin
 *    et linux, si bien que win32 retombe sur l'artefact `linux-x64` et le détare
 *    par-dessus le essaim.exe en cours d'exécution ;
 *  - même avec le bon artefact (win32-x64 EST publié par release-binaries.yml),
 *    le chargeur d'image Windows garde essaim.exe verrouillé tant que le
 *    processus vit : tar échouerait en « Access is denied », potentiellement à
 *    mi-extraction.
 *
 * Plutôt qu'une réussite mensongère, on s'arrête en disant quoi faire.
 *
 * Retourne `null` quand la plateforme sait se mettre à jour, sinon le message à
 * afficher. La plateforme est un PARAMÈTRE (et non `process.platform` lu à
 * l'intérieur) pour rester testable sans falsifier le global.
 */
export function unsupportedPlatformNotice(platform: NodeJS.Platform): string | null {
  if (platform !== "win32") return null;
  return [
    "Error: `essaim self-update` ne fonctionne pas sur Windows.",
    "Windows verrouille l'exécutable en cours : essaim.exe ne peut pas se remplacer",
    "lui-même, et cette commande n'a jamais eu de chemin de mise à jour en place ici.",
    "",
    "Mettre à jour à la main :",
    "  - installé via npm : npm install -g essaim@latest",
    "  - binaire natif    : télécharger essaim-<version>-win32-x64.tar.gz sur",
    `                       https://github.com/${REPO}/releases/latest,`,
    "                       fermer toute instance d'essaim, puis remplacer essaim.exe",
    "                       et les dossiers behaviors/, presets/, compositions/, scripts/.",
  ].join("\n");
}

type Source = "curl" | "gh";

function hasGh(): boolean {
  try {
    execSync("command -v gh", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Try the anonymous public API first, fall back to gh for private repos.
 * Returns the resolved tag and which source succeeded.
 */
function fetchLatestTag(): { tag: string; source: Source } {
  // 1. Try curl (public API, no auth)
  try {
    const raw = execSync(
      `curl -sL "https://api.github.com/repos/${REPO}/releases/latest"`,
      { encoding: "utf-8", timeout: 10000 },
    );
    const data = JSON.parse(raw);
    if (data.tag_name) {
      return { tag: (data.tag_name as string).replace(/^v/, ""), source: "curl" };
    }
    // API returned a payload but no tag_name — usually 404 (private repo) or rate limit
    if (data.message !== "Not Found" && !String(data.message ?? "").includes("rate limit")) {
      throw new Error(`Unexpected response: ${data.message ?? "no tag_name"}`);
    }
  } catch (err) {
    // Only continue to gh fallback on parse/network errors
    if (err instanceof Error && !err.message.startsWith("Unexpected")) {
      throw err;
    }
  }

  // 2. Fall back to gh (auth'd access for private repos)
  if (!hasGh()) {
    throw new Error(
      "Release not found via public API. If the repo is private, install the 'gh' CLI and run 'gh auth login'.",
    );
  }
  const raw = execSync(`gh api repos/${REPO}/releases/latest`, {
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const data = JSON.parse(raw);
  return { tag: (data.tag_name as string).replace(/^v/, ""), source: "gh" };
}

function downloadAsset(
  source: Source,
  assetName: string,
  version: string,
  destPath: string,
): void {
  if (source === "gh") {
    execSync(
      `gh release download v${version} --repo ${REPO} --pattern "${assetName}.tar.gz" --dir "${dirname(destPath)}" --clobber`,
      { stdio: "pipe", timeout: 60000 },
    );
    execSync(`mv "${dirname(destPath)}/${assetName}.tar.gz" "${destPath}"`);
    return;
  }
  const url = `https://github.com/${REPO}/releases/download/v${version}/${assetName}.tar.gz`;
  execSync(`curl -fsSL "${url}" -o "${destPath}"`, {
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60000,
  });
}

export function createSelfUpdateCommand(): Command {
  return new Command("self-update")
    .description("Update essaim to the latest version")
    .action(() => {
      // Avant tout : ne pas payer un aller-retour réseau pour finir par écrire
      // un binaire de la mauvaise plateforme par-dessus celui qui tourne.
      const notice = unsupportedPlatformNotice(process.platform);
      if (notice) {
        console.error(notice);
        process.exit(1);
        return;
      }

      const currentVersion = getVersion();

      console.log("Checking for updates...");
      let latest: string;
      let source: Source;
      try {
        ({ tag: latest, source } = fetchLatestTag());
      } catch (err) {
        console.error("Error: Could not fetch latest release from GitHub.");
        if (err instanceof Error) console.error(`  ${err.message}`);
        process.exit(1);
        return;
      }

      if (source === "gh") {
        console.log("  (using gh for authenticated access)");
      }

      if (latest === currentVersion) {
        console.log(`Already up to date (v${currentVersion}).`);
        return;
      }

      console.log(`Update available: v${currentVersion} → v${latest}`);

      // win32 est déjà sorti en tête d'action : il ne reste que darwin et linux.
      const platform = process.platform === "darwin" ? "darwin" : "linux";
      const arch = process.arch === "arm64" ? "arm64" : "x64";
      const assetName = `essaim-${latest}-${platform}-${arch}`;

      console.log(`Downloading ${assetName}.tar.gz...`);
      const tmpDir = execSync("mktemp -d", { encoding: "utf-8" }).trim();
      const tarPath = `${tmpDir}/release.tar.gz`;
      try {
        downloadAsset(source, assetName, latest, tarPath);
      } catch (err) {
        console.error(`Error: Failed to download ${assetName}.tar.gz`);
        if (err instanceof Error) console.error(`  ${err.message}`);
        execSync(`rm -rf "${tmpDir}"`);
        process.exit(1);
      }

      const installDir = dirname(process.execPath);
      console.log(`Installing to ${installDir}...`);
      execSync(
        `tar xzf "${tarPath}" -C "${installDir}" --strip-components=1`,
        { stdio: "pipe" },
      );

      execSync(`rm -rf "${tmpDir}"`);

      console.log(`Updated to v${latest}.`);
    });
}


