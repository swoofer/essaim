// client/orchestrator/template-engine.ts
// Prompt generation via Behavior Composition Engine (BCE).
import type { MiniProject, ProjectContext } from "./types.js";
import { buildProjectFromBce, listBceTemplates } from "../bridge.js";

export function buildProject(
  templateId: string,
  context: ProjectContext,
  options?: { agentCount?: number; setParams?: Record<string, Record<string, unknown>>; catalogs?: string[] },
  projectPath?: string,
): MiniProject {
  return buildProjectFromBce(templateId, context, options, projectPath) as unknown as MiniProject;
}

export function listTemplates(
  projectPath?: string,
  opts?: { catalogs?: string[] },
): { id: string; name: string; description: string }[] {
  return listBceTemplates(projectPath, opts);
}


