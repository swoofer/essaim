import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { parse } from "yaml";
import { getBehaviorsDir } from "./bce-resolver.js";

export function collect(val: string, prev: string[]): string[] {
  return prev.concat([val]);
}

export type ParamType = "string" | "number" | "boolean" | "string[]" | "unknown";

/** Types déclarés du catalogue : clé "<behavior>.<param>" → type. */
export function buildParamTypeMap(): Record<string, ParamType> {
  const map: Record<string, ParamType> = {};
  const dir = getBehaviorsDir();
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    const doc = parse(readFileSync(join(dir, f), "utf-8")) as {
      name?: string;
      params?: Record<string, { type?: string }>;
    };
    if (!doc?.name || !doc.params) continue;
    for (const [p, def] of Object.entries(doc.params)) {
      map[`${doc.name}.${p}`] = (def?.type as ParamType) ?? "unknown";
    }
  }
  return map;
}

export function parseSetParams(
  sets: string[],
  typeMap?: Record<string, ParamType>,
): Record<string, Record<string, unknown>> {
  const params: Record<string, Record<string, unknown>> = {};
  for (const s of sets) {
    const eqIdx = s.indexOf("=");
    if (eqIdx === -1) continue;
    const path = s.substring(0, eqIdx);
    const val = s.substring(eqIdx + 1);
    const dotIdx = path.indexOf(".");
    if (dotIdx === -1) continue;
    const behavior = path.substring(0, dotIdx);
    const param = path.substring(dotIdx + 1);
    if (!params[behavior]) params[behavior] = {};
    const declared = typeMap?.[`${behavior}.${param}`];
    if (declared === "string") {
      params[behavior][param] = val; // jamais de JSON.parse : "7" reste "7"
    } else {
      try {
        params[behavior][param] = JSON.parse(val);
      } catch {
        params[behavior][param] = val;
      }
    }
  }
  return params;
}
