// tests/unit/claim-dedup.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { claimNextTask } from '../../src/agent-loop/work-stealing.js';

// Régression #30 — mekova-bughunt, 3 hunters, UN seul bug bien localisé : les
// trois ont écrit ET commité un test de repro quasi identique. Le claim était
// déjà atomique PAR THREAD, mais chaque hunter avait posté sa propre découverte
// → 3 threads pour un seul bug → un thread chacun, trois tests.
//
// La dédup ne peut pas reposer sur le jugement du LLM (la phase review n'a rien
// marqué DUP). Le garde-fou est structurel : deux agents ne travaillent jamais le
// MÊME FICHIER en même temps — ce qui est la raison d'être du coordinateur.

type Thread = Record<string, unknown>;

function mockCoordinator(threads: Thread[], claims: Record<string, boolean> = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/threads-active')) {
      return new Response(JSON.stringify(threads), { status: 200 });
    }
    if (url.endsWith('/api/claim-task')) {
      const body = JSON.parse((init!.body as string)) as { thread_id: string };
      const ok = claims[body.thread_id] !== false;
      return new Response(JSON.stringify({ success: ok, claimed_by: ok ? null : 'autre-agent' }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('claimNextTask — un seul agent par fichier (#30)', () => {
  it('ne claim pas une tâche dont le fichier est déjà travaillé par un autre agent', async () => {
    const fetchMock = mockCoordinator([
      { id: 't1', status: 'open', claimed_by: 'hunter-1', target_files: ['src/report.ts'] },
      { id: 't2', status: 'open', claimed_by: null, target_files: ['src/report.ts'] },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const task = await claimNextTask('https://c', 'hunter-2');

    expect(task).toBeNull();
    const claimed = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/api/claim-task'));
    expect(claimed).toHaveLength(0); // on n'a même pas tenté
  });

  it('claim normalement quand le fichier est libre', async () => {
    vi.stubGlobal('fetch', mockCoordinator([
      { id: 't1', status: 'open', claimed_by: 'hunter-1', target_files: ['src/report.ts'] },
      { id: 't2', status: 'open', claimed_by: null, target_files: ['src/csv.ts'] },
    ]));

    const task = await claimNextTask('https://c', 'hunter-2');

    expect(task?.id).toBe('t2');
    expect(task?.file).toBe('src/csv.ts'); // le fichier était jeté au claim, il remonte maintenant
  });

  it('un thread sans fichier cible reste claimable (pas d\'exclusion abusive)', async () => {
    vi.stubGlobal('fetch', mockCoordinator([
      { id: 't1', status: 'open', claimed_by: 'hunter-1', target_files: ['src/report.ts'] },
      { id: 't2', status: 'open', claimed_by: null, target_files: [] },
    ]));

    const task = await claimNextTask('https://c', 'hunter-2');
    expect(task?.id).toBe('t2');
  });

  it('mes propres claims ne me bloquent pas moi-même', async () => {
    vi.stubGlobal('fetch', mockCoordinator([
      { id: 't1', status: 'resolved', claimed_by: 'hunter-2', target_files: ['src/report.ts'] },
      { id: 't2', status: 'open', claimed_by: null, target_files: ['src/report.ts'] },
    ]));

    const task = await claimNextTask('https://c', 'hunter-2');
    expect(task?.id).toBe('t2');
  });

  it('remonte le travail DÉJÀ résolu sur le même fichier — de quoi marquer DUP au lieu de recommiter', async () => {
    vi.stubGlobal('fetch', mockCoordinator([
      {
        id: 't1',
        status: 'resolved',
        claimed_by: 'hunter-1',
        target_files: ['src/report.ts'],
        subject: 'major: CSV export perd receipt_date (src/report.ts:42)',
      },
      { id: 't2', status: 'open', claimed_by: null, target_files: ['src/report.ts'] },
    ]));

    const task = await claimNextTask('https://c', 'hunter-2');

    expect(task?.id).toBe('t2');
    expect(task?.relatedDone?.join(' ')).toContain('receipt_date');
  });
});
