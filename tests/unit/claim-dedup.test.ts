// tests/unit/claim-dedup.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { claimNextTask } from '../../src/agent-loop/work-stealing.js';

// Régression #30 — un template de chasse aux bugs, 3 hunters, UN seul bug bien localisé : les
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

  it('le coordinator renvoie target_files en JSON stringifié (pas un tableau) — le garde-fou doit quand même bloquer', async () => {
    // Preuve de bout en bout du défaut : database.js stocke target_files en
    // colonne TEXT via JSON.stringify, et consultation.js#listThreads renvoie
    // les lignes SQLite brutes sans désérialisation. /api/threads-active livre
    // donc une CHAÎNE JSON, jamais un tableau — exactement ce que ce fixture
    // reproduit, à la différence des autres cas de ce fichier.
    const fetchMock = mockCoordinator([
      { id: 't1', status: 'open', claimed_by: 'hunter-1', target_files: '["src/report.ts"]' },
      { id: 't2', status: 'open', claimed_by: null, target_files: '["src/report.ts"]' },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const task = await claimNextTask('https://c', 'hunter-2');

    expect(task).toBeNull();
    const claimed = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/api/claim-task'));
    expect(claimed).toHaveLength(0); // on n'a même pas tenté
  });

  it('une chaîne target_files malformée dégrade vers "aucun fichier connu" sans jeter', async () => {
    vi.stubGlobal('fetch', mockCoordinator([
      { id: 't1', status: 'open', claimed_by: 'hunter-1', target_files: '{not json' },
      { id: 't2', status: 'open', claimed_by: null, target_files: '["src/csv.ts"]' },
    ]));

    const task = await claimNextTask('https://c', 'hunter-2');

    expect(task?.id).toBe('t2'); // t1 illisible n'exclut aucun fichier, ne bloque pas t2
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

describe('claimNextTask — refetch après course perdue (fenêtre TOCTOU réduite, pas fermée)', () => {
  it('après un claim perdu, re-fetch threads-active et exclut le fichier devenu occupé avant le candidat suivant', async () => {
    let threadsActiveCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/threads-active')) {
        threadsActiveCalls++;
        if (threadsActiveCalls === 1) {
          // Snapshot initial : les deux fichiers sont libres.
          return new Response(JSON.stringify([
            { id: 't1', status: 'open', claimed_by: null, target_files: ['fileA.ts'] },
            { id: 't2', status: 'open', claimed_by: null, target_files: ['fileB.ts'] },
          ]), { status: 200 });
        }
        // Re-fetch déclenché après la course perdue sur t1 : entre-temps, un
        // autre agent a claim un thread sur fileB — invisible dans le snapshot
        // initial, mais visible ici.
        return new Response(JSON.stringify([
          { id: 't1', status: 'open', claimed_by: 'autre-agent', target_files: ['fileA.ts'] },
          { id: 't2', status: 'open', claimed_by: null, target_files: ['fileB.ts'] },
          { id: 't3', status: 'open', claimed_by: 'autre-agent', target_files: ['fileB.ts'] },
        ]), { status: 200 });
      }
      if (url.endsWith('/api/claim-task')) {
        const body = JSON.parse((init!.body as string)) as { thread_id: string };
        // t1 perd toujours la course ; t2 ne devrait jamais être tenté une fois
        // que le refetch a révélé que fileB est occupé.
        const ok = body.thread_id !== 't1';
        return new Response(JSON.stringify({ success: ok, claimed_by: ok ? null : 'autre-agent' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const task = await claimNextTask('https://c', 'hunter-2');

    expect(task).toBeNull();
    expect(threadsActiveCalls).toBeGreaterThanOrEqual(2);
    const claimed = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/api/claim-task'));
    expect(claimed).toHaveLength(1); // t2 correctement écarté après le refetch
  });
});

// #140 — la fenêtre restante : au démarrage parallèle, les N instantanés
// précèdent structurellement les N claims, donc computeBusyFiles() ne peut
// rien voir au premier tour. Deux agents peuvent chacun réussir un claim
// atomique (claim-task est atomique PAR THREAD, pas par fichier) sur deux
// threads distincts qui ciblent le même fichier. Le départage doit être
// déterministe et symétrique : les deux agents l'évaluent indépendamment,
// sans se parler, et doivent converger vers EXACTEMENT un cédant.
describe('claimNextTask — départage déterministe après double claim réussi sur un même fichier (#140)', () => {
  it('cède le thread si un pair détient déjà un claim ouvert sur le même fichier avec un id de thread plus petit, puis enchaîne sur le candidat suivant', async () => {
    let threadsActiveCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/threads-active')) {
        threadsActiveCalls++;
        if (threadsActiveCalls === 1) {
          // Snapshot initial : les deux fichiers semblent libres — c'est
          // structurellement le cas au démarrage parallèle, computeBusyFiles()
          // ne peut rien voir ici.
          return new Response(JSON.stringify([
            { id: 't5', status: 'open', claimed_by: null, target_files: ['shared.ts'] },
            { id: 't9', status: 'open', claimed_by: null, target_files: ['other.ts'] },
          ]), { status: 200 });
        }
        if (threadsActiveCalls === 2) {
          // Re-fetch juste après notre claim RÉUSSI sur t5 : un pair a claim
          // t1 sur le même fichier entre notre snapshot et notre claim. 't1'
          // < 't5' : le pair garde, nous cédons.
          return new Response(JSON.stringify([
            { id: 't1', status: 'open', claimed_by: 'autre-agent', target_files: ['shared.ts'] },
            { id: 't5', status: 'open', claimed_by: 'hunter-2', target_files: ['shared.ts'] },
            { id: 't9', status: 'open', claimed_by: null, target_files: ['other.ts'] },
          ]), { status: 200 });
        }
        // Re-fetch après le claim du candidat suivant (t9) : aucun rival sur other.ts.
        return new Response(JSON.stringify([
          { id: 't1', status: 'open', claimed_by: 'autre-agent', target_files: ['shared.ts'] },
          { id: 't9', status: 'open', claimed_by: 'hunter-2', target_files: ['other.ts'] },
        ]), { status: 200 });
      }
      if (url.endsWith('/api/claim-task')) {
        return new Response(JSON.stringify({ success: true, claimed_by: null }), { status: 200 });
      }
      if (url.endsWith('/api/unclaim-task')) {
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const task = await claimNextTask('https://c', 'hunter-2');

    expect(task?.id).toBe('t9'); // a cédé t5 (t1 < t5), a enchaîné sur le candidat suivant
    const unclaimed = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/api/unclaim-task'));
    expect(unclaimed).toHaveLength(1);
    expect(JSON.parse((unclaimed[0][1] as RequestInit).body as string).thread_id).toBe('t5');
  });

  it('cas symétrique : mêmes fichiers, identités inversées (notre id est maintenant le plus petit) — c\'est nous qui gardons, la conclusion suit l\'id et pas l\'ordre des appels', async () => {
    let threadsActiveCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/threads-active')) {
        threadsActiveCalls++;
        if (threadsActiveCalls === 1) {
          return new Response(JSON.stringify([
            { id: 't5', status: 'open', claimed_by: null, target_files: ['shared.ts'] },
          ]), { status: 200 });
        }
        // Re-fetch après notre claim réussi sur t5 : le pair détient t99 sur
        // le même fichier. 't5' < 't99' cette fois : nous gardons, le pair
        // cède (de son côté, avec le même calcul).
        return new Response(JSON.stringify([
          { id: 't5', status: 'open', claimed_by: 'hunter-2', target_files: ['shared.ts'] },
          { id: 't99', status: 'open', claimed_by: 'autre-agent', target_files: ['shared.ts'] },
        ]), { status: 200 });
      }
      if (url.endsWith('/api/claim-task')) {
        return new Response(JSON.stringify({ success: true, claimed_by: null }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const task = await claimNextTask('https://c', 'hunter-2');

    expect(task?.id).toBe('t5'); // id plus petit : nous gardons, pas de cession
    const unclaimed = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/api/unclaim-task'));
    expect(unclaimed).toHaveLength(0);
  });
});
