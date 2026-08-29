// essaim doctor — préflight de dépendances. #148.
//
// Raison d'être : aujourd'hui, une dépendance manquante (Claude Code absent du
// PATH, catalogue introuvable, port occupé) se manifeste par un stack trace Node
// en pleine exécution, ou par un run qui « réussit » avec 0 finding. `doctor`
// transforme ça en un diagnostic lisible AVANT que le coordinator ne démarre :
// chaque échec porte un message et une commande d'installation, jamais une trace.
//
// La fonction est PURE et à dépendances injectables : les tests l'exécutent sans
// toucher au systeme (pas de vrai spawn, pas de vrai bind de port). Le seul
// verdict qui compte est `ok` (aucune verification critique en echec).

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  /** Ce qui a été constaté (une ligne). */
  detail: string;
  /** Comment réparer — commande d'installation. Présent des que status !== "ok". */
  hint?: string;
  /** Un échec critique empêche un run de démarrer. */
  critical: boolean;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** false si une verification CRITIQUE est en echec. Un `warn` ne bloque pas. */
  ok: boolean;
}

export interface DoctorDeps {
  /** Sonde un binaire : lance `<bin> <versionArg>` et rend true si code 0. */
  probe(bin: string, versionArg: string): boolean;
  /** Résout le binaire Claude Code (respecte CLAUDE_BIN / PATH / .cmd Windows). */
  resolveClaudeBin(): string;
  /** true si le port est LIBRE (bindable), false s'il est occupé. */
  portFree(port: number): boolean;
  /** true si behaviors/ presets/ templates/ sont localisables. */
  catalogOk(): boolean;
  /** Plateforme, pour des hints d'installation adaptés. */
  platform: NodeJS.Platform;
  /** COORDINATOR_URL de l'environnement : si defini, essaim ne demarre PAS le
   *  coordinator local, donc les ports 3100/1883 n'ont pas a etre libres. */
  coordinatorUrl?: string;
}

/** Commande d'installation d'un outil selon la plateforme. */
function installHint(tool: string, platform: NodeJS.Platform): string {
  const table: Record<string, { win32: string; darwin: string; linux: string }> = {
    jq: { win32: "winget install jqlang.jq", darwin: "brew install jq", linux: "sudo apt install jq" },
    curl: { win32: "winget install curl.curl", darwin: "brew install curl", linux: "sudo apt install curl" },
  };
  const t = table[tool];
  if (!t) return `installez ${tool}`;
  return platform === "win32" ? t.win32 : platform === "darwin" ? t.darwin : t.linux;
}

const CLAUDE_INSTALL = "npm install -g @anthropic-ai/claude-code (ou voir claude.com/claude-code)";

export function runDoctor(deps: DoctorDeps): DoctorReport {
  const checks: DoctorCheck[] = [];

  // 1. Claude Code — CRITIQUE. Sans lui, aucun agent ne peut se lancer. On SONDE
  //    (lance --version), on ne se contente pas de trouver le chemin : un binaire
  //    present mais non executable est un faux OK.
  const claudeBin = deps.resolveClaudeBin();
  const claudeOk = deps.probe(claudeBin, "--version");
  checks.push(claudeOk
    ? { name: "claude", status: "ok", detail: `Claude Code répond (${claudeBin})`, critical: true }
    : { name: "claude", status: "fail", detail: `Claude Code introuvable ou muet (${claudeBin})`, hint: CLAUDE_INSTALL, critical: true });

  // 2. Catalogue — CRITIQUE. Sans behaviors/presets/templates, aucun prompt
  //    ne s'assemble. Message deja clair cote getCatalogRoots ; ici on le
  //    transforme en verdict avant l'execution.
  const catOk = deps.catalogOk();
  checks.push(catOk
    ? { name: "catalog", status: "ok", detail: "behaviors/ presets/ templates/ localisés", critical: true }
    : { name: "catalog", status: "fail", detail: "catalogue introuvable (behaviors/ presets/ templates/)", hint: "réinstallez essaim (npm i -g essaim) ou lancez depuis le dépôt", critical: true });

  // 3 & 4. Ports 3100 (coordinator) et 1883 (MQTT). Non critiques : si
  //    COORDINATOR_URL est defini, essaim ne demarre PAS le coordinator local,
  //    donc les ports n'ont pas a etre libres. Sinon, un port occupe est un warn
  //    (un autre coordinator tourne peut-etre deja) — pas un blocage, mais a dire.
  if (deps.coordinatorUrl) {
    checks.push({ name: "port-3100", status: "ok", detail: `COORDINATOR_URL défini (${deps.coordinatorUrl}) — coordinator local non requis`, critical: false });
  } else {
    for (const port of [3100, 1883]) {
      const free = deps.portFree(port);
      checks.push(free
        ? { name: `port-${port}`, status: "ok", detail: `port ${port} libre`, critical: false }
        : { name: `port-${port}`, status: "warn", detail: `port ${port} occupé`, hint: `un processus écoute déjà sur ${port} — arrêtez-le, ou pointez COORDINATOR_URL vers lui`, critical: false });
    }
  }

  // 5 & 6. jq et curl — utilises par les hooks/scripts. Warn : un run peut
  //    demarrer sans, mais certains hooks echoueront en silence.
  for (const tool of ["jq", "curl"]) {
    const ok = deps.probe(tool, "--version");
    checks.push(ok
      ? { name: tool, status: "ok", detail: `${tool} présent`, critical: false }
      : { name: tool, status: "warn", detail: `${tool} absent — certains hooks en dépendent`, hint: installHint(tool, deps.platform), critical: false });
  }

  const ok = !checks.some((c) => c.critical && c.status === "fail");
  return { checks, ok };
}

/** Rendu texte pour la CLI. stdout, pas du JSON — un humain le lit. */
export function formatDoctorReport(report: DoctorReport): string {
  const icon = (s: CheckStatus) => (s === "ok" ? "✓" : s === "warn" ? "!" : "✗");
  const lines = report.checks.map((c) => {
    const head = `  ${icon(c.status)} ${c.name.padEnd(11)} ${c.detail}`;
    return c.hint ? `${head}\n      → ${c.hint}` : head;
  });
  const verdict = report.ok
    ? "\nDiagnostic OK — un run peut démarrer."
    : "\nDiagnostic ÉCHOUÉ — corrigez les points critiques (✗) avant de lancer un run.";
  return lines.join("\n") + "\n" + verdict;
}
