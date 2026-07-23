// src/security/docker.ts — build docker argv + translate Windows paths to bind mounts.
// Pure string/argv builders (no spawning here). Windows-first.

// Pinned by DIGEST (never :latest). The real digest is pinned during rollout (spec §16);
// PLACEHOLDER_DIGEST must be replaced with a license-verified digest before a real run.
export const PINNED_STRIX_IMAGE = "usestrix/strix@sha256:PLACEHOLDER_DIGEST";

/** Normalize a host path so Docker Desktop accepts it as a bind source (backslashes → forward). */
export function toDockerHostPath(hostPath: string): string {
  return hostPath.replace(/\\/g, "/");
}

/** Build a `-v` bind-mount value. Defaults to read-only mount at /src. */
export function dockerMountArg(hostPath: string, target = "/src", ro = true): string {
  return `${toDockerHostPath(hostPath)}:${target}${ro ? ":ro" : ""}`;
}

export function containerName(runId: string): string {
  return `essaim-security-${runId}`;
}

export interface DockerRunOpts {
  image: string;
  containerName: string;
  mount: string;
  envFile?: string;
  target: string;
  scanMode: "quick" | "deep";
  scopeMode: "diff" | "full";
  diffBase?: string;
  instruction: string;
}

/** Build the full `docker run …` argv. Image precedes engine flags. Secrets never appear here. */
export function dockerRunArgs(o: DockerRunOpts): string[] {
  const args: string[] = ["run", "--rm", "--name", o.containerName, "-v", o.mount];
  if (o.envFile) args.push("--env-file", o.envFile);
  args.push(o.image);
  // Strix flags (after the image = command inside the container):
  args.push("-n", "-t", o.target, "--scan-mode", o.scanMode);
  if (o.scopeMode === "diff" && o.diffBase) args.push("--scope-mode", "diff", "--diff-base", o.diffBase);
  args.push("--instruction", o.instruction);
  return args;
}

export function dockerKillArgs(name: string): string[] {
  return ["kill", name];
}

export function dockerInspectArgs(image: string): string[] {
  return ["image", "inspect", image];
}
