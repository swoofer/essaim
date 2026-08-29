// tests/unit/run-id.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { currentRunId, ensureRunId } from '../../src/run-id.js';
import { claimNextTask, postDiscoveries } from '../../src/agent-loop/work-stealing.js';
import { announceViaRest } from '../../src/agent-loop/agent-loop.js';

beforeEach(() => { delete process.env.ESSAIM_RUN_ID; });
afterEach(() => { vi.unstubAllGlobals(); delete process.env.ESSAIM_RUN_ID; });

// #32 — sur un coordinateur partagé et persistant, les threads d'un run AVORTÉ
// restaient visibles aux agents du run suivant. Chaque thread porte désormais
// l'id de son run, et le pool est filtré dessus.
describe('run-id', () => {
  it('absent de l\'environnement = non scopé (comportement historique)', () => {
    expect(currentRunId()).toBeUndefined();
  });

  it('ensureRunId frappe un id et le publie dans l\'environnement', () => {
    const id = ensureRunId('raid');
    expect(id).toMatch(/^raid-[0-9a-f]{8}$/);
    expect(process.env.ESSAIM_RUN_ID).toBe(id);
    expect(currentRunId()).toBe(id);
  });

  it('est idempotent — un runner ou une CI qui a déjà fixé le run gagne', () => {
    process.env.ESSAIM_RUN_ID = 'run-du-runner';
    expect(ensureRunId('raid')).toBe('run-du-runner');
  });
});

describe('work-stealing — estampillage du run (#32)', () => {
  it('postDiscoveries estampille le run_id sur l\'announce', async () => {
    process.env.ESSAIM_RUN_ID = 'run-42';
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ thread_id: 't1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await postDiscoveries('https://c', 'a1', [{ id: '', description: 'bug', file: 'src/a.ts' }]);

    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.run_id).toBe('run-42');
  });

  it('claimNextTask ne demande que le pool de SON run', async () => {
    process.env.ESSAIM_RUN_ID = 'run-42';
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await claimNextTask('https://c', 'a1');

    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.run_id).toBe('run-42');
  });

  it('sans run_id, la requête reste valide — le coordinateur renvoie tout, comme avant', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await claimNextTask('https://c', 'a1');

    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.run_id).toBeUndefined();
  });
});

// #142 — l'annonce de coordination reste DÉLIBÉRÉMENT non estampillée.
//
// Ces deux cas verrouillent le corps que `announceViaRest` envoie, parce que le
// garde-fou `isWorkItem()` de work-stealing.ts repose entièrement dessus :
//
//  - PAS de `keep_open` : c'est ce qui fait écrire `timeout_seconds = 600` au
//    coordinator, donc ce qui distingue une annonce d'un item de travail. Sans
//    ce verrou la régression était INVISIBLE — vérifié par mutation exécutée :
//    ajouter `keep_open: true` laissait la suite entière verte tout en rendant
//    le garde-fou totalement inerte.
//  - PAS de `run_id` : les deux autres chemins d'annonce le passent (#32), et
//    l'ajouter ici est le réflexe évident. Ce serait une régression du rapport :
//    /api/threads-summary filtre en égalité stricte, donc les annonces en sont
//    aujourd'hui exclues et la note « faisant autorité » ne compte que du vrai
//    travail. Estampillées, un raid à 4 agents qui corrige 4 bugs afficherait
//    8 threads. Mesuré sur un rapport réel : threads_opened=9, threads_final
//    {total:4, poisoned:4}.
describe("agent-loop — le corps de l’annonce de coordination (#142)", () => {
  it("n’envoie ni keep_open ni run_id — les deux verrous dont isWorkItem() dépend", async () => {
    process.env.ESSAIM_RUN_ID = 'run-42';
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ thread_id: 't1', status: 'open' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await announceViaRest('https://c', 'a1', { subject: 'a1 starting work', targetModules: ['agent-loop'], targetFiles: [] });

    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.keep_open).toBeUndefined();
    // Même avec ESSAIM_RUN_ID posé dans l'environnement.
    expect(body.run_id).toBeUndefined();
  });
});
