// client/agent-loop/work-stealing.ts

import { createLogger } from "../logger.js";
import { authHeaders } from "../coordinator-auth.js";
import { currentRunId } from "../run-id.js";
const log = createLogger("work-stealing");

export interface Task {
  id: string;           // thread_id from coordinator
  description: string;
  file?: string;
  line?: number;
  severity?: string;
  // Summaries of work ALREADY resolved on the same file this run. The executing
  // agent is blind to its peers otherwise — this is what lets it recognise its
  // finding as a duplicate instead of committing a near-identical repro (#30).
  relatedDone?: string[];
}

// target_files est stocké côté coordinator via JSON.stringify dans une colonne
// TEXT (database.js), et consultation.js#listThreads renvoie les lignes SQLite
// brutes sans désérialisation : /api/threads-active le livre donc en CHAÎNE
// JSON, jamais en tableau. Un Array.isArray dessus était toujours faux, ce qui
// rendait threadFiles() constamment vide et computeBusyFiles() — le garde-fou
// « un seul agent par fichier » (#30) — inopérant depuis son introduction.
// Même remède que parseTargetModules dans mqtt-listener.ts (#98) : le tableau
// reste accepté au cas où un appelant le fournirait déjà décodé, une chaîne
// illisible dégrade vers "aucun fichier connu" plutôt que de jeter.
function threadFiles(thread: Record<string, unknown>): string[] {
  const files = thread.target_files;
  const arr = Array.isArray(files) ? files : typeof files === "string" ? safeParseArray(files) : [];
  return arr.filter((f): f is string => typeof f === "string" && f.length > 0);
}

function safeParseArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Une ANNONCE de coordination n'est pas un item de travail (#142).
//
// Mesuré sur un banc de 6 runs à charge identique : 22 des 23 threads
// abandonnés étaient des annonces d'intention. claimNextTask réclamait
// n'importe quel thread ouvert non réclamé ; comme une annonce porte
// target_files vide, computeBusyFiles() ne la voyait jamais en conflit et
// rien ne l'écartait. L'agent la réclamait, cherchait 20 tours ce qu'il
// devait faire, plafonnait en error_max_turns, la déréclamait — et elle
// repartait au pool pour le suivant. 15 tours sur 59 (25 %) finissaient
// ainsi, brûlant 16,4 M des 32,9 M de jetons cache-read : LA MOITIÉ de la
// dépense du banc.
//
// Le discriminant est keep_open, que le coordinator persiste dans
// timeout_seconds : `keepOpen ? 0 : 600` à l'INSERT (consultation.ts, avec
// `keepOpen = params.keep_open || assignedTo !== null`), et listThreads fait
// `SELECT * FROM threads` — la colonne arrive donc telle quelle dans
// /api/threads-active. Le balayeur confirme le sens : il ne périme que
// `timeout_seconds > 0`. Un 0 veut dire « ne se périme jamais », c'est-à-dire
// un item qui ATTEND UN PRENEUR. Les trois chemins qui postent du vrai
// travail (postDiscoveries et le NOUVEAU groupé ci-dessous, findingToAnnounce
// dans security/ingest.ts) envoient tous keep_open: true ; announceViaRest
// est le seul à ne pas l'envoyer. Le dispatch dirigé est couvert gratuitement
// (assigned_to implique keepOpen côté coordinator).
//
// Discriminant ÉCARTÉ — « target_files vide ⇒ pas une tâche » : il sépare
// bien les familles observées, mais il casse trois producteurs de vrai
// travail sans fichier, dont security/ingest.ts qui poste target_files: []
// pour tout finding sans code_location (documenté tel quel dans
// security/types.ts). La vuln serait sortie du pool en silence, exit 0,
// rapport vert — du gaspillage transformé en PERTE, ce qui est pire.
// Également écarté : expected_respondents (vaut "[]" pour l'annonce COMME
// pour l'item semé — hypothèse testée sur coordinator réel et réfutée).
//
// Même prudence de lecture que threadFiles ci-dessus (#139) : la valeur
// arrive d'une ligne SQLite brute, elle peut être un nombre, une chaîne, ou
// manquer. Absente ou illisible, on dégrade vers RÉCLAMABLE — jamais vers
// l'exclusion, sinon un pool de vrais items tous écartés fait sortir l'agent
// par « pool empty », proprement, sans avoir rien fait.
function isWorkItem(thread: Record<string, unknown>): boolean {
  const raw = thread.timeout_seconds;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return !Number.isFinite(n) || n === 0;
}

const DISCOVERY_MARKER = "DISCOVERY:";

/**
 * Parse the LLM's discovery output into structured tasks.
 * Expected format after DISCOVERY: marker:
 *   FICHIER | LIGNE | DESCRIPTION | SEVERITE
 */
export function parseDiscoveries(output: string): Task[] {
  const idx = output.indexOf(DISCOVERY_MARKER);
  if (idx === -1) return [];

  const text = output.slice(idx + DISCOVERY_MARKER.length).trim();
  const tasks: Task[] = [];

  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.trim().replace(/^[-*]\s*/, "");
    if (!line) continue;
    const parts = line.split("|").map((s) => s.trim());
    if (parts.length < 3) continue;
    tasks.push({
      id: "",
      description: parts[2],
      file: parts[0] || undefined,
      line: parseInt(parts[1]) || undefined,
      severity: parts[3] || "minor",
    });
  }
  return tasks;
}

// HttpError carries the response status so callers can distinguish expected
// race conditions (404/410) from unexpected failures.
class HttpError extends Error {
  constructor(public readonly status: number, public readonly url: string, public readonly body: string) {
    super(`Coordinator ${url} returned ${status}: ${body.slice(0, 200)}`);
  }
}

async function coordinatorPost(url: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let resp: Response;
  try {
    resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(body) });
  } catch (err) {
    throw new Error(`Cannot reach coordinator at ${url}: ${(err as Error).message}`);
  }
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    throw new HttpError(resp.status, url, bodyText);
  }
  return (await resp.json()) as Record<string, unknown>;
}

/**
 * Post discoveries to coordinator as open threads (keep_open: true).
 * Returns tasks with thread IDs populated.
 */
export async function postDiscoveries(
  coordinatorUrl: string,
  agentId: string,
  tasks: Task[],
): Promise<Task[]> {
  log.debug(`postDiscoveries: ${tasks.length} tasks to post (keep_open=true)`);
  for (const task of tasks) {
    const subject = task.file
      ? `${task.severity ?? "finding"}: ${task.description} (${task.file}${task.line ? ":" + task.line : ""})`
      : `${task.severity ?? "finding"}: ${task.description}`;
    try {
      const data = await coordinatorPost(`${coordinatorUrl}/api/announce`, {
        agent_id: agentId,
        subject: subject.slice(0, 200),
        target_modules: [],
        target_files: task.file ? [task.file] : [],
        keep_open: true,
        // Stamps the thread with this run so the NEXT run doesn't inherit it (#32).
        run_id: currentRunId(),
      });
      task.id = (data.thread_id as string) || "";
      log.info(`posted thread=${task.id}: ${subject.slice(0, 80)}`);
    } catch (err) {
      log.warn(`failed to post: ${subject.slice(0, 80)}`, { error: (err as Error).message });
    }
  }
  const posted = tasks.filter((t) => t.id);
  log.debug(`postDiscoveries: ${posted.length}/${tasks.length} posted successfully`);
  return posted;
}

/**
 * Fetch active threads from the coordinator, scoped to the current run.
 * Returns null on any failure (unreachable coordinator or non-ok response) —
 * callers treat that as "nothing to claim right now".
 */
async function fetchActiveThreads(coordinatorUrl: string): Promise<Array<Record<string, unknown>> | null> {
  try {
    const resp = await fetch(`${coordinatorUrl}/api/threads-active`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      // Scope the pool to this run: the threads of an aborted earlier run must
      // not be claimable here (#32). Un-scoped threads (a human session) stay
      // visible — the coordinator's filter keeps them on purpose.
      body: JSON.stringify({ run_id: currentRunId() }),
    });
    if (!resp.ok) { log.warn("fetchActiveThreads: threads-active failed", { status: resp.status }); return null; }
    const data = await resp.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    log.warn("fetchActiveThreads: coordinator unreachable", { error: (err as Error).message });
    return null;
  }
}

// One agent per file (#30). Three hunters that each posted their own discovery
// for a single bug produce three threads on the same file; claiming is atomic
// per THREAD, so each hunter took one and all three wrote a near-identical
// repro test. Excluding files another agent is actively working makes the
// de-duplication structural instead of asking the LLM to notice — which is
// also, exactly, what the coordinator exists to do.
function computeBusyFiles(openThreads: Array<Record<string, unknown>>, agentId: string): Set<string> {
  const busyFiles = new Set<string>();
  for (const t of openThreads) {
    const owner = t.claimed_by as string | null | undefined;
    if (owner && owner !== agentId) {
      for (const f of threadFiles(t)) busyFiles.add(f);
    }
  }
  return busyFiles;
}

// Résiduel de la fenêtre TOCTOU (#140) : au démarrage parallèle, les N
// instantanés précèdent structurellement les N claims, donc computeBusyFiles()
// ci-dessus ne peut rien voir au premier tour — deux agents peuvent chacun
// réussir un claim atomique (claim-task est atomique PAR THREAD, jamais par
// fichier) sur deux threads distincts qui ciblent le même fichier. Après un
// claim RÉUSSI, on re-vérifie une fois : si un pair détient déjà un claim
// ouvert sur un de nos fichiers, l'un des deux doit céder.
//
// Les deux agents évaluent ça indépendamment, sans se parler — le critère
// doit donc être une fonction pure des données que les deux côtés voient
// déjà identiques. L'horodatage a été écarté : les horloges dérivent et les
// requêtes courent, donc les deux agents peuvent chacun se croire "arrivé
// premier". Le thread_id n'a ni défaut : claim-task le distribue déjà unique
// (clé primaire côté coordinator) et strictement identique quel que soit qui
// le lit — l'ordonner (comparaison lexicographique de chaîne) donne donc aux
// deux agents la même réponse sans le moindre message échangé.
//
// Ce que la comparaison garantit vraiment — et ce qu'elle ne garantit PAS :
// SI un agent voit au moins un rival au refetch, la règle est stricte
// (thread_id le plus petit gagne) donc JAMAIS DOUBLE-CESSION : deux agents
// en conflit direct calculent le même couple d'id, obtiennent des booléens
// strictement complémentaires, il ne peut pas y avoir égalité (id unique).
// Mais `rivals.length === 0` gagne EN DESSOUS, sans comparer aucun id — et
// c'est exactement le trou : si le refetch de l'agent A court en avance de
// la propagation du claim de l'agent B (A ne voit encore aucun rival), A
// gagne trivialement sans savoir qu'il y a conflit. Si le refetch de B,
// juste après, voit bien le claim de A, B compare pour de vrai — et PEUT
// gagner aussi si son id est le plus petit des deux. Résultat possible :
// DOUBLE-RÉTENTION (les deux gardent), jamais fermée par cette fonction
// seule. La garantie est donc best-effort, pas structurelle : elle réduit
// la fenêtre du correctif précédent, elle ne l'annule pas. Fermer ça pour
// de vrai demande l'atomicité sur le FICHIER côté coordinator, pas le
// thread — hors périmètre client (documenté aussi en bas de fichier, sur le
// refetch après course perdue).
async function resolveFileConflict(
  coordinatorUrl: string,
  agentId: string,
  threadId: string,
  files: string[],
): Promise<{ won: boolean; openThreads: Array<Record<string, unknown>> | null }> {
  if (files.length === 0) return { won: true, openThreads: null };

  const refreshed = await fetchActiveThreads(coordinatorUrl);
  if (refreshed === null) {
    // Coordinator injoignable juste après notre propre claim : dégrade vers
    // le comportement actuel (on garde) plutôt que de perdre un travail déjà
    // confirmé sur la seule base d'un aller-retour qui a échoué.
    return { won: true, openThreads: null };
  }

  const open = refreshed.filter((t) => t.status === "open");
  const rivals = open.filter((t) => {
    const owner = t.claimed_by as string | null | undefined;
    return owner && owner !== agentId && t.id !== threadId && threadFiles(t).some((f) => files.includes(f));
  });
  if (rivals.length === 0) return { won: true, openThreads: open };

  const smallestRivalId = rivals.map((t) => t.id as string).sort()[0];
  return { won: threadId < smallestRivalId, openThreads: open };
}

/**
 * Atomically claim the next available task from the coordinator.
 * Uses POST /api/claim-task which does UPDATE WHERE claimed_by IS NULL.
 * Returns null if no tasks available.
 */
/**
 * Sentinelle distincte de `null` : le coordinator est INJOIGNABLE (fetch rejeté,
 * ou réponse non-ok), à ne PAS confondre avec « piscine vide » (`null`). La
 * boucle de work-stealing s'en sert pour finir en exitReason d'erreur (rapport
 * rouge) au lieu de « done » — un coordinator mort n'est pas un travail fini
 * (#151). C'est une string plutôt qu'un objet pour rester ≠ de tout `Task`.
 */
export const COORDINATOR_UNREACHABLE = "coordinator_unreachable" as const;

export async function claimNextTask(
  coordinatorUrl: string,
  agentId: string,
): Promise<Task | null | typeof COORDINATOR_UNREACHABLE> {
  // fetchActiveThreads rend `null` UNIQUEMENT quand il n'a pas pu lire la piscine
  // (non-ok / fetch rejeté) — jamais pour une piscine vide (qui rend `[]`). On
  // remonte donc l'injoignabilité distinctement, au lieu de l'aplatir en `null`.
  const threads = await fetchActiveThreads(coordinatorUrl);
  if (threads === null) return COORDINATOR_UNREACHABLE;

  const open = threads.filter((t) => t.status === "open");
  const unclaimed = open.filter((t) => !t.claimed_by);
  log.debug(`claimNextTask: ${threads.length} active, ${open.length} open, ${unclaimed.length} unclaimed`);

  let busyFiles = computeBusyFiles(open, agentId);

  // COMPTEUR D'ÉCARTÉS — en info, pas en debug, et c'est le point.
  // La dégradation d'isWorkItem() est « réclamable » : un thread dont
  // timeout_seconds est illisible passe. Un garde-fou qui dégrade en silence ne
  // peut pas être distingué d'un garde-fou INERTE — c'est exactement ce qui
  // s'est passé avec le départage post-claim de #141, dont le compteur de
  // cessions valait 0 sur trois runs sans que personne le voie. Une valeur nulle
  // ici, alors que des tours finissent en error_max_turns, veut dire que le
  // mécanisme ne sert à rien : il faut pouvoir le lire dans le log du run.
  let skippedAnnounces = 0;

  // What has already LANDED on each file this run, so the executing agent can
  // recognise a duplicate rather than re-committing it.
  const doneByFile = new Map<string, string[]>();
  for (const t of threads) {
    if (t.status === "open") continue;
    const subject = (t.subject as string) || "";
    if (!subject) continue;
    for (const f of threadFiles(t)) {
      doneByFile.set(f, [...(doneByFile.get(f) ?? []), subject]);
    }
  }

  // Try to claim each open, unclaimed thread
  for (const thread of threads) {
    if (thread.status !== "open") continue;
    if (thread.claimed_by) continue;
    // Le garde-fou de #142.
    if (!isWorkItem(thread)) {
      skippedAnnounces++;
      log.debug(`skipping thread=${thread.id} — annonce de coordination (timeout_seconds=${String(thread.timeout_seconds)}), pas un item de travail`);
      continue;
    }

    const files = threadFiles(thread);
    const conflict = files.find((f) => busyFiles.has(f));
    if (conflict) {
      log.info(`skipping thread=${thread.id} — ${conflict} is already being worked by another agent`);
      continue;
    }
    // Directed-dispatch: a thread with assigned_to set is only claimable by
    // that named agent. Skipping here avoids hitting claim-task just to get
    // a polite 'success: false, assigned_to: otherAgent'. For workers in a
    // lead/worker preset this is the normal case — most threads target other
    // workers.
    const assignedTo = (thread as Record<string, unknown>).assigned_to as string | null | undefined;
    if (assignedTo && assignedTo !== agentId) continue;

    const threadId = thread.id as string;
    const subject = (thread.subject as string) || "?";
    try {
      const result = await coordinatorPost(`${coordinatorUrl}/api/claim-task`, {
        thread_id: threadId,
        agent_id: agentId,
      });
      if ((result as Record<string, unknown>).success === true) {
        const { won, openThreads } = await resolveFileConflict(coordinatorUrl, agentId, threadId, files);
        if (!won) {
          log.info(`ceding thread=${threadId} — pair holds a lexicographically prior claim on ${files.join(", ")}`);
          await unclaimTask(coordinatorUrl, threadId, agentId);
          if (openThreads !== null) busyFiles = computeBusyFiles(openThreads, agentId);
          continue;
        }
        log.info(`claimed thread=${threadId}: ${subject.slice(0, 80)}`);
        const relatedDone = files.flatMap((f) => doneByFile.get(f) ?? []);
        if (relatedDone.length > 0) {
          log.info(`thread=${threadId}: ${relatedDone.length} résolution(s) déjà livrée(s) sur ${files.join(", ")} — contexte injecté`);
        }
        if (skippedAnnounces > 0) {
          log.info(`claimNextTask: ${skippedAnnounces} annonce(s) de coordination écartée(s) — pas des items de travail`);
        }
        return {
          id: threadId,
          description: subject,
          file: files[0],
          severity: undefined,
          relatedDone: relatedDone.length > 0 ? relatedDone : undefined,
        };
      }
      log.info(`claim race lost thread=${threadId} to ${(result as Record<string, unknown>).claimed_by as string}: ${subject.slice(0, 60)}`);
      // Lost the race: another agent's claim landed between our snapshot and
      // this attempt, so busyFiles may already be stale for the NEXT
      // candidate. Re-fetch and recompute before evaluating it. This narrows
      // the TOCTOU window (#30 doesn't get worse) — it does NOT close it:
      // claim-task is atomic only on thread_id, not on file, so a race can
      // still land in the gap between this refetch and the next claim
      // attempt. Closing it fully needs server-side atomicity over the file,
      // i.e. a coordinator change — out of scope here.
      const refreshed = await fetchActiveThreads(coordinatorUrl);
      if (refreshed !== null) {
        busyFiles = computeBusyFiles(refreshed.filter((t) => t.status === "open"), agentId);
      }
    } catch (err) {
      log.warn(`claim error: ${threadId}`, { error: (err as Error).message });
    }
  }

  if (skippedAnnounces > 0) {
    log.info(`claimNextTask: ${skippedAnnounces} annonce(s) de coordination écartée(s) — pas des items de travail`);
  }
  log.debug("claimNextTask: nothing to claim");
  return null;
}

/**
 * Termine une tache : propose la resolution PUIS auto-approuve (#2).
 *
 * `propose-resolution` fait passer le thread en `resolving` — le coordinator
 * attend alors une approbation. Cette approbation n'etait JAMAIS emise :
 * `approveResolution` cote coordinator existait, l'appel cote essaim aussi
 * (approveResolutionViaRest), mais rien ne l'appelait. Mesure : sur 6 runs,
 * TOUS les threads « resolus » finissaient `resolving`, jamais `resolved` — la
 * couche de consensus ne concluait jamais.
 *
 * L'agent qui a fait le travail auto-approuve sa propre proposition. Cote
 * coordinator, `allRespondentsApproved` rend true des que `expected_respondents`
 * est vide (verifie sur les bases du banc : les threads bloques avaient tous
 * exp=[]), donc une seule approbation resout le thread. Un thread AVEC des
 * repondants attendus (chevauchement de module) n'est PAS resolu par cette
 * auto-approbation seule — il attend le vrai consensus, comportement correct.
 *
 * L'approbation est resiliente (catch) : si propose a echoue, le thread n'est
 * pas `resolving` et approveResolution jetterait — on avale, comme propose.
 */
export async function completeTask(
  coordinatorUrl: string,
  threadId: string,
  agentId: string,
  summary: string,
): Promise<void> {
  log.debug(`completeTask: thread=${threadId}`, { summary: summary.slice(0, 80) });
  const proposed = await coordinatorPost(`${coordinatorUrl}/api/propose-resolution`, {
    thread_id: threadId,
    agent_id: agentId,
    summary,
  }).then(() => true).catch((err) => {
    log.warn("completeTask: propose-resolution failed", { error: (err as Error).message });
    return false;
  });
  if (!proposed) return;
  await coordinatorPost(`${coordinatorUrl}/api/approve-resolution`, {
    thread_id: threadId,
    agent_id: agentId,
  }).catch((err) => {
    // Un thread avec expected_respondents non vide n'est pas resolu ici : ce
    // n'est pas une erreur. On journalise en debug, pas en warn.
    log.debug("completeTask: approve-resolution non concluante (repondants attendus ?)", { error: (err as Error).message });
  });
}

/**
 * Release a claim on a task so another agent can pick it up.
 * Used when the agent gave up on the task without producing a DONE: marker.
 */
export async function unclaimTask(
  coordinatorUrl: string,
  threadId: string,
  agentId: string,
): Promise<void> {
  log.debug(`unclaimTask: thread=${threadId}`);
  await coordinatorPost(`${coordinatorUrl}/api/unclaim-task`, {
    thread_id: threadId,
    agent_id: agentId,
  }).catch((err) => {
    // Swallowed on purpose (every caller fires this fire-and-forget), but the
    // thread id has to be IN the warning: without it, a failed unclaim is a
    // thread stuck claimed_by us forever — nobody, including us, ever picks
    // it up again — and a bare "unclaimTask failed" gives no way to find
    // which one. Cheapest fix that covers every call site, including the
    // new cede-on-conflict path in claimNextTask (#140).
    log.warn(`unclaimTask failed: thread=${threadId}`, { error: (err as Error).message });
  });
}

// ── Review phase ─────────────────────────────────────────────────────

export type ReviewAction =
  | { type: "nouveau"; description: string }
  | { type: "doublon"; threadId: string }
  | { type: "enrichit"; threadId: string; context: string };

const REVIEW_MARKER = "REVIEW:";

/**
 * Parse the LLM's review output into structured actions.
 * Expected format after REVIEW: marker:
 *   NOUVEAU | description
 *   DOUBLON | thread_id
 *   ENRICHIT | thread_id | additional context
 */
export function parseReviewActions(output: string): ReviewAction[] {
  const idx = output.indexOf(REVIEW_MARKER);
  if (idx === -1) return [];

  const text = output.slice(idx + REVIEW_MARKER.length).trim();
  const actions: ReviewAction[] = [];

  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.trim().replace(/^[-*]\s*/, "");
    if (!line) continue;
    const parts = line.split("|").map((s) => s.trim());
    if (parts.length < 2) continue;

    const action = parts[0].toUpperCase();
    if (action === "NOUVEAU") {
      actions.push({ type: "nouveau", description: parts[1] });
    } else if (action === "DOUBLON") {
      actions.push({ type: "doublon", threadId: parts[1] });
    } else if (action === "ENRICHIT" && parts.length >= 3) {
      actions.push({ type: "enrichit", threadId: parts[1], context: parts[2] });
    }
  }
  return actions;
}

/**
 * Fetch existing open threads from the coordinator for comparison.
 * Returns a formatted string for injection into the review prompt.
 */
export async function fetchExistingThreads(coordinatorUrl: string): Promise<string> {
  try {
    const resp = await fetch(`${coordinatorUrl}/api/threads-active`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      // The review phase compares its findings against these threads. Feeding it
      // a dead run's threads is how a lead ends up consulting a stale id (#32).
      body: JSON.stringify({ run_id: currentRunId() }),
    });
    if (!resp.ok) return "(aucun thread actif)";
    const threads = (await resp.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(threads) || threads.length === 0) {
      log.debug("fetchExistingThreads: 0 threads");
      return "(aucun thread actif)";
    }

    const open = threads.filter((t) => t.status === "open");
    log.debug(`fetchExistingThreads: ${threads.length} total, ${open.length} open`);
    for (const t of open) {
      log.debug(`thread [${t.id}] claimed_by=${t.claimed_by || "none"} -- ${(t.subject as string || "").slice(0, 60)}`);
    }

    return open
      .map((t) => `- [${t.id}] ${t.subject}`)
      .join("\n") || "(aucun thread actif)";
  } catch {
    return "(coordinator non disponible)";
  }
}

/**
 * Extract the file path from a review description like "server/src/foo.ts:123 — ..."
 */
function extractFile(description: string): string {
  const match = description.match(/^(\S+\.\w+)(?::\d+)?/);
  return match ? match[1] : "__ungrouped__";
}

/**
 * Process review actions: post new findings grouped by file, enrich existing threads.
 * Fix 3: Groups NOUVEAU actions by source file to reduce thread count.
 */
export async function processReviewActions(
  coordinatorUrl: string,
  agentId: string,
  agentName: string,
  actions: ReviewAction[],
): Promise<{ posted: number; enriched: number; skipped: number }> {
  let posted = 0;
  let enriched = 0;
  let skipped = 0;

  log.debug(`processReviewActions: ${actions.length} actions to process`);

  // Separate action types
  const nouveaux = actions.filter((a): a is ReviewAction & { type: "nouveau" } => a.type === "nouveau");
  const others = actions.filter(a => a.type !== "nouveau");

  // Group NOUVEAU by source file
  const byFile = new Map<string, string[]>();
  for (const action of nouveaux) {
    const file = extractFile(action.description);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push(action.description);
  }

  // Post one thread per file group
  for (const [file, descriptions] of byFile) {
    const subject = file === "__ungrouped__"
      ? descriptions[0].slice(0, 200)
      : `${file}: ${descriptions.length} issue(s)`;
    const plan = descriptions.map((d, i) => `${i + 1}. ${d}`).join("\n");
    log.debug(`NOUVEAU (grouped): ${subject} — ${descriptions.length} items`);
    try {
      await coordinatorPost(`${coordinatorUrl}/api/announce`, {
        agent_id: agentId,
        subject: subject.slice(0, 200),
        plan,
        target_modules: [],
        target_files: file !== "__ungrouped__" ? [file] : [],
        keep_open: true,
        // Même estampille que le chemin de découverte plus haut (#32) : sans
        // elle, le schéma du coordinator traite le thread comme non scopé,
        // « visible to every run », et un run suivant hérite des découvertes
        // de la phase review d'un run mort.
        run_id: currentRunId(),
      });
      posted++;
    } catch (err) { log.warn("NOUVEAU group post failed", { error: (err as Error).message }); }
  }

  // Process enrichments and doublons normally
  for (const action of others) {
    if (action.type === "enrichit") {
      log.debug(`ENRICHIT: thread=${action.threadId}`, { context: action.context.slice(0, 60) });
      try {
        await coordinatorPost(`${coordinatorUrl}/api/post-to-thread`, {
          thread_id: action.threadId,
          agent_id: agentId,
          agent_name: agentName,
          type: "context",
          content: action.context,
        });
        enriched++;
      } catch (err) {
        // 404 (thread disappeared) / 410 (thread cancelled) are expected races
        // when the LLM references a thread that resolved/cancelled between the
        // review's list and the post. Log at debug, count as skipped.
        if (err instanceof HttpError && (err.status === 404 || err.status === 410)) {
          log.debug(`ENRICHIT skipped (thread ${err.status}): ${action.threadId}`);
          skipped++;
        } else {
          log.warn("ENRICHIT post failed", { error: (err as Error).message });
        }
      }
    } else {
      log.debug(`DOUBLON: skip thread=${(action as ReviewAction & { threadId?: string }).threadId}`);
      skipped++;
    }
  }

  return { posted, enriched, skipped };
}

