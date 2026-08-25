export type EffortLevel = "low" | "mid" | "high" | "max" | "auto";

export type ConcreteEffortLevel = Exclude<EffortLevel, "auto">;

// Thinking levels map to Claude CLI extended-thinking trigger keywords.
// "none" = no extended thinking; other levels append a keyword to the prompt.
export type ThinkingLevel = "none" | "think" | "think-hard" | "ultrathink";

export interface EffortProfile {
  model: string;
  thinking: ThinkingLevel;
  maxTurns: number;
}

export const EFFORT_ORDER: Record<ConcreteEffortLevel, number> = {
  low: 0,
  mid: 1,
  high: 2,
  max: 3,
};

export const EFFORT_PROFILES: Record<ConcreteEffortLevel, EffortProfile> = {
  // maxTurns needs headroom when thinking is enabled — thinking tokens count
  // against the turn limit, and with tools in the loop a "turn" can burn
  // multiple explorations before the model even attempts to synthesise text.
  low:  { model: "claude-haiku-4-5-20251001", thinking: "none",       maxTurns: 15 },
  // 8 → 16 : sur un raid mesuré, 21 `error_max_turns` pour 19 tâches
  // abandonnées — c'est le plafond, pas la qualité de l'agent, qui causait
  // l'abandon. On DOUBLE sans aller plus loin : à ~3,9 min pour 8 tours, un
  // mid à 25 produirait un envoi de ~12 min contre un timeout de run par
  // défaut de 15 min (orchestrator.ts), donc une mort par deadline en pleine
  // tâche — l'état le plus destructeur, puisqu'il la laisse réclamée.
  mid:  { model: "claude-sonnet-4-6",         thinking: "think",      maxTurns: 16 },
  high: { model: "claude-opus-4-6",           thinking: "think-hard", maxTurns: 20 },
  max:  { model: "claude-opus-4-6",           thinking: "ultrathink", maxTurns: 60 },
};

const KNOWN_THINKING: ReadonlySet<ThinkingLevel> = new Set([
  "none",
  "think",
  "think-hard",
  "ultrathink",
]);

export function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === "string" && KNOWN_THINKING.has(v as ThinkingLevel);
}

// Trigger keyword appended to the user prompt for Claude CLI extended thinking.
// "none" returns empty — caller should skip append.
export function thinkingKeyword(level: ThinkingLevel): string {
  switch (level) {
    case "none":       return "";
    case "think":      return "think";
    case "think-hard": return "think hard";
    case "ultrathink": return "ultrathink";
  }
}

export interface EffortContext {
  toolsMode: "read_only" | "full" | "none";
  loop: boolean;
}

const KNOWN_LEVELS: ReadonlySet<EffortLevel> = new Set(["low", "mid", "high", "max", "auto"]);

export function resolveEffort(
  level: EffortLevel,
  ctx: EffortContext,
): ConcreteEffortLevel {
  // Unknown inputs (misconfigured YAML) fall back to auto-resolution rather than NPE downstream.
  const safe: EffortLevel = KNOWN_LEVELS.has(level) ? level : "auto";
  if (safe !== "auto") return safe;
  if (ctx.toolsMode === "read_only" || ctx.toolsMode === "none") return "low";
  return ctx.loop ? "high" : "mid";
}

export type SeverityLevel = "critical" | "major" | "minor";

export function parseSeverity(description: string): SeverityLevel | undefined {
  const match = description.match(/^(critical|major|minor):/i);
  return match ? (match[1].toLowerCase() as SeverityLevel) : undefined;
}

export interface EffortSignals {
  severity?: SeverityLevel;
}

export function upgradeEffort(
  base: ConcreteEffortLevel,
  signals: EffortSignals,
): ConcreteEffortLevel {
  let level = base;
  // Critical-severity tasks used to auto-escalate all the way to "high" (Opus +
  // think-hard). In practice Opus tended to burn its turn budget on exploration
  // before producing DONE — Sonnet handles the "write a failing test" workload
  // fine. We now only nudge "low" up to "mid" on critical, so presets that
  // explicitly pick an effort level are respected.
  if (signals.severity === "critical" && EFFORT_ORDER[level] < EFFORT_ORDER.mid) {
    level = "mid";
  }
  return level;
}

