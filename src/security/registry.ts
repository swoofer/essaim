// src/security/registry.ts — pluggable adapter registry with a permissive-license gate.
// The gate is the one mechanism protecting essaim's MIT posture: AGPL/GPL/SSPL/non-commercial
// engines must never register (invoke them out-of-process only).
import type { AdapterRegistry, EngineAdapter, EngineId } from "./types.js";
import { EngineLicenseError } from "./errors.js";

export const PERMISSIVE_LICENSES: ReadonlySet<string> = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
]);

export function createRegistry(): AdapterRegistry {
  const adapters = new Map<EngineId, EngineAdapter>();
  return {
    register(a: EngineAdapter): void {
      const lic = a.capabilities.license;
      if (!PERMISSIVE_LICENSES.has(lic)) {
        throw new EngineLicenseError(
          `Refusing engine '${a.capabilities.id}': license '${lic || "<none>"}' is not on the permissive ` +
            `allowlist (MIT/Apache-2.0/BSD/ISC). AGPL/GPL/SSPL/non-commercial engines must not be registered; ` +
            `invoke them out-of-process only.`,
        );
      }
      adapters.set(a.capabilities.id, a);
    },
    get(id: EngineId): EngineAdapter | undefined {
      return adapters.get(id);
    },
    resolve(ids: EngineId[]): EngineAdapter[] {
      return ids.map((id) => {
        const a = adapters.get(id);
        if (!a) throw new Error(`security: engine '${id}' is not registered`);
        return a;
      });
    },
  };
}
