// tests/unit/claim-dedup.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { claimNextTask, COORDINATOR_UNREACHABLE, type Task } from '../../src/agent-loop/work-stealing.js';

// claimNextTask rend Task | null | COORDINATOR_UNREACHABLE (#151). Ce garde
// narrow vers un vrai Task pour l'accès aux propriétés dans les tests.
function asTask(t: Task | null | typeof COORDINATOR_UNREACHABLE): Task {
  if (t === null || t === COORDINATOR_UNREACHABLE) throw new Error(`attendu un Task, reçu ${String(t)}`);
  return t;
}

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

    expect(asTask(task).id).toBe('t2');
    expect(asTask(task).file).toBe('src/csv.ts'); // le fichier était jeté au claim, il remonte maintenant
  });

  it('un thread sans fichier cible reste claimable (pas d\'exclusion abusive)', async () => {
    vi.stubGlobal('fetch', mockCoordinator([
      { id: 't1', status: 'open', claimed_by: 'hunter-1', target_files: ['src/report.ts'] },
      { id: 't2', status: 'open', claimed_by: null, target_files: [] },
    ]));

    const task = await claimNextTask('https://c', 'hunter-2');
    expect(asTask(task).id).toBe('t2');
  });

  it('mes propres claims ne me bloquent pas moi-même', async () => {
    vi.stubGlobal('fetch', mockCoordinator([
      { id: 't1', status: 'resolved', claimed_by: 'hunter-2', target_files: ['src/report.ts'] },
      { id: 't2', status: 'open', claimed_by: null, target_files: ['src/report.ts'] },
    ]));

    const task = await claimNextTask('https://c', 'hunter-2');
    expect(asTask(task).id).toBe('t2');
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

    expect(asTask(task).id).toBe('t2'); // t1 illisible n'exclut aucun fichier, ne bloque pas t2
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

    expect(asTask(task).id).toBe('t2');
    expect(asTask(task).relatedDone?.join(' ')).toContain('receipt_date');
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

    expect(asTask(task).id).toBe('t9'); // a cédé t5 (t1 < t5), a enchaîné sur le candidat suivant
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

    expect(asTask(task).id).toBe('t5'); // id plus petit : nous gardons, pas de cession
    // Discriminant : sur 058ee3f, claimNextTask retourne dès success===true
    // sans jamais rappeler threads-active — asTask(task).id==='t5' et 0 unclaim
    // seraient déjà vrais SANS le patch (aucun refetch post-claim n'existe).
    // Le seul signal qui ne peut être vrai qu'AVEC resolveFileConflict() en
    // jeu est ce second appel : le pré-patch en fait 1, le patché en fait 2.
    expect(threadsActiveCalls).toBe(2);
    const unclaimed = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/api/unclaim-task'));
    expect(unclaimed).toHaveLength(0);
  });
});

// #142 — une annonce de coordination n'est pas un item de travail.
//
// Mesure (banc de 6 runs, charge identique de 4 vrais défauts) : 22 des 23
// threads abandonnés étaient des ANNONCES d'intention, jamais du travail. Un
// agent en réclamait une, cherchait 20 tours ce qu'il devait faire, plafonnait
// en error_max_turns, la déréclamait — et elle repartait au pool pour le
// suivant. 15 tours sur 59 (25 %) finissaient ainsi, brûlant 16,4 M des 32,9 M
// de jetons cache-read : LA MOITIÉ de la dépense du banc.
//
// Discriminant RETENU : timeout_seconds === 0, c'est-à-dire keep_open.
// Le coordinator écrit `keepOpen ? 0 : 600` (consultation.ts:229, avec
// `keepOpen = params.keep_open || assignedTo !== null` ligne 210) et listThreads
// fait `SELECT * FROM threads` — la colonne arrive donc telle quelle dans
// /api/threads-active. Un `0` signifie « ne se périme jamais » : le balayeur
// l'ignore (`AND timeout_seconds > 0`), c'est un item qui ATTEND UN PRENEUR.
//
// Discriminant ÉCARTÉ : « target_files vide ⇒ pas une tâche ». Réfuté sur
// quatre chemins livrés, dont src/security/ingest.ts qui poste `target_files:
// []` avec `keep_open: true` pour tout finding sans code_location (documenté
// tel quel dans src/security/types.ts) — il serait devenu invisible au swarm de
// remédiation, en silence, exit 0. Les cas ci-dessous verrouillent ça.
describe("claimNextTask — une annonce de coordination n'est pas une tâche (#142)", () => {
  it("n'essaie même pas de claim une annonce d'intention (timeout_seconds=600)", async () => {
    // La forme exacte de la ligne SQLite du run A1 : target_files vide, des
    // modules, run_id NULL, timeout 600. Elle reste `open` dès que le scorer
    // d'impact a trouvé un pair concerné (sinon le coordinator l'auto-résout).
    const fetchMock = mockCoordinator([
      { id: 't1', status: 'open', claimed_by: null, target_files: '[]', target_modules: '["agent-loop","orchestrator"]', expected_respondents: '[]', run_id: null, timeout_seconds: 600, subject: 'agent-sentinelle-1 starting work on agent-loop, orchestrator' },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const task = await claimNextTask('https://c', 'hunter-2');

    expect(task).toBeNull();
    const claimed = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/api/claim-task'));
    expect(claimed).toHaveLength(0);
  });

  it("claim un item de travail semé SANS fichier cible (timeout_seconds=0) — le discriminant n'est PAS target_files", async () => {
    // C'est le cas que « target_files vide ⇒ pas une tâche » aurait cassé :
    // un finding de sécurité sans code_location (src/security/ingest.ts:81,
    // keep_open: true) est du travail légitime, et il doit rester réclamable.
    vi.stubGlobal('fetch', mockCoordinator([
      { id: 't2', status: 'open', claimed_by: null, target_files: '[]', target_modules: '[]', run_id: 'bench-A1', timeout_seconds: 0, subject: 'high: secret en clair dans la config' },
    ]));

    const task = await claimNextTask('https://c', 'hunter-2');

    expect(asTask(task).id).toBe('t2');
  });

  it("les trois familles réelles du run A1 côte à côte : seul l'item semé est réclamé", async () => {
    const fetchMock = mockCoordinator([
      // ANNONCE — agent-loop.ts n'envoie pas keep_open → 600 → écartée.
      { id: 'a1', status: 'open', claimed_by: null, target_files: '[]', target_modules: '["agent-loop","orchestrator","pipeline","security"]', expected_respondents: '[]', run_id: null, timeout_seconds: 600, subject: 'agent-sentinelle-3 starting work on agent-loop' },
      // TRAVAIL semé — ingest.ts envoie keep_open: true → 0 → réclamable.
      { id: 'w1', status: 'open', claimed_by: null, target_files: '["src/orchestrator/preflight.ts"]', target_modules: '[]', expected_respondents: '[]', run_id: 'bench-A1', timeout_seconds: 0, subject: 'major: pas de garde sur le chemin destructif' },
      // ANNONCE announce-before-write postée par un agent via le MCP
      // announce_work, avec ses fichiers : elle doit alimenter busyFiles mais
      // ne JAMAIS être réclamée. expected_respondents "[]" ne discrimine rien
      // ici — hypothèse testée sur coordinator réel et réfutée.
      { id: 'a2', status: 'open', claimed_by: null, target_files: '["src/orchestrator/preflight.ts","tests/unit/preflight.test.ts"]', target_modules: '["orchestrator"]', expected_respondents: '["agent-sentinelle-3","seeder"]', run_id: null, timeout_seconds: 600, subject: 'je vais toucher preflight.ts' },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const task = await claimNextTask('https://c', 'hunter-2');

    expect(asTask(task).id).toBe('w1');
    const claimed = fetchMock.mock.calls
      .filter((c) => String(c[0]).endsWith('/api/claim-task'))
      .map((c) => JSON.parse((c[1] as RequestInit).body as string).thread_id);
    expect(claimed).toEqual(['w1']); // a1 et a2 jamais tentés
  });

  it('timeout_seconds absent dégrade vers RÉCLAMABLE, jamais vers l\'exclusion', async () => {
    // Même prudence que threadFiles : une colonne manquante ou illisible ne
    // doit pas transformer du gaspillage en PERTE SILENCIEUSE (un pool de
    // vrais items tous écartés sort par « pool empty », exit 0, rapport vert).
    vi.stubGlobal('fetch', mockCoordinator([
      { id: 't3', status: 'open', claimed_by: null, target_files: '["src/a.ts"]' },
    ]));

    const task = await claimNextTask('https://c', 'hunter-2');
    expect(asTask(task).id).toBe('t3');
  });

  it('timeout_seconds illisible dégrade aussi vers réclamable', async () => {
    vi.stubGlobal('fetch', mockCoordinator([
      { id: 't4', status: 'open', claimed_by: null, target_files: '["src/a.ts"]', timeout_seconds: 'jamais' },
    ]));

    const task = await claimNextTask('https://c', 'hunter-2');
    expect(asTask(task).id).toBe('t4');
  });

  it('tolérance de forme : timeout_seconds en chaîne, target_files en TABLEAU déjà décodé', async () => {
    // Le coordinator livre des chaînes ; un appelant (ou un futur coordinator
    // qui désérialiserait) peut livrer des types natifs. Les deux formes
    // doivent conclure pareil, sinon on rejoue le bug de classe de #139.
    const fetchMock = mockCoordinator([
      { id: 'a1', status: 'open', claimed_by: null, target_files: [], timeout_seconds: '600' },
      { id: 'w1', status: 'open', claimed_by: null, target_files: ['src/a.ts'], timeout_seconds: '0' },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const task = await claimNextTask('https://c', 'hunter-2');

    expect(asTask(task).id).toBe('w1');
    const claimed = fetchMock.mock.calls
      .filter((c) => String(c[0]).endsWith('/api/claim-task'))
      .map((c) => JSON.parse((c[1] as RequestInit).body as string).thread_id);
    expect(claimed).toEqual(['w1']);
  });

  it('le dispatch dirigé reste réclamable par son destinataire (assigned_to implique keep_open côté coordinator)', async () => {
    vi.stubGlobal('fetch', mockCoordinator([
      { id: 't5', status: 'open', claimed_by: null, assigned_to: 'hunter-2', target_files: '[]', timeout_seconds: 0, subject: 'lead → worker' },
    ]));

    const task = await claimNextTask('https://c', 'hunter-2');
    expect(asTask(task).id).toBe('t5');
  });
});
