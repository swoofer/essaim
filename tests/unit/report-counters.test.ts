// tests/unit/report-counters.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { countDiffLines, formatCost } from '../../src/orchestrator/reporter.js';
import { fetchCoordinatorMetrics, fetchLatestEventId } from '../../src/orchestrator/metrics.js';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.COORDINATOR_TOKEN;
});

// Régression #29 — un run avec de vrais threads rapportait « Threads ouverts: 0 »,
// « Diff (lignes): 1 » pour CHAQUE agent, et « $0.0000 ».

describe('countDiffLines (#29)', () => {
  it('un diff vide vaut 0 ligne, pas 1', () => {
    // "".split("\n") === [""] → .length === 1 : le « 1 ligne » de tous les
    // agents n'était pas une mesure, c'était une chaîne vide mal comptée.
    expect(countDiffLines('')).toBe(0);
    expect(countDiffLines('\n')).toBe(0);
  });

  it('compte les lignes ajoutées et retirées, pas les en-têtes ni le contexte', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,4 @@',
      ' contexte inchangé',
      '+ligne ajoutée',
      '+autre ligne ajoutée',
      '-ligne retirée',
    ].join('\n');
    expect(countDiffLines(diff)).toBe(3);
  });
});

describe('formatCost (#29)', () => {
  it('affiche N/A quand des tokens ont été consommés mais que le coût est 0 (OAuth)', () => {
    // Sous abonnement (OAuth), le SDK ne renvoie aucun prix : 0 avec de vrais
    // tokens signifie « inconnu », pas « gratuit ».
    expect(formatCost(0, true)).toBe('N/A');
    expect(formatCost(undefined, true)).toBe('N/A');
  });

  it('affiche le vrai coût quand il est connu', () => {
    expect(formatCost(1.2345, true)).toBe('$1.2345');
  });

  it('affiche $0.0000 quand il n\'y a réellement eu aucun token', () => {
    expect(formatCost(0, false)).toBe('$0.0000');
  });
});

describe('fetchCoordinatorMetrics — authentification (#29)', () => {
  it('envoie le Bearer token : sans lui, le coordinateur sécurisé répond 401 et tout compteur tombe à 0', () => {
    process.env.COORDINATOR_TOKEN = 'jeton-test';
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    return fetchCoordinatorMetrics('https://coordinator.test').then(() => {
      expect(fetchMock).toHaveBeenCalled();
      const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer jeton-test');
    });
  });

  it('compte les threads réellement présents dans le flux SSE', async () => {
    const sse = [
      'id: 1\nevent: thread_opened\ndata: {"thread_id":"t1"}',
      'id: 2\nevent: thread_opened\ndata: {"thread_id":"t2"}',
      'id: 3\nevent: message_posted\ndata: {"thread_id":"t1"}',
    ].join('\n\n');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse, { status: 200 })));

    const metrics = await fetchCoordinatorMetrics('https://coordinator.test');
    expect(metrics.threads_opened).toBe(2);
    expect(metrics.messages_exchanged).toBe(1);
  });

  it('dégrade proprement si le coordinateur est injoignable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const metrics = await fetchCoordinatorMetrics('https://coordinator.test');
    expect(metrics.threads_opened).toBe(0);
  });
});

// #108 — fetchCoordinatorMetrics hardcoded `Last-Event-ID: 1`, so a run on a
// shared, persistent coordinator (where /api/reset is 403-forbidden) always
// replayed the coordinator's ENTIRE event history, not just this run's.
describe('fetchCoordinatorMetrics — scoping the SSE cursor to this run (#108)', () => {
  it('threads the given cursor as Last-Event-ID instead of the hardcoded "1"', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchCoordinatorMetrics('https://coordinator.test', 42);

    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers['Last-Event-ID']).toBe('42');
  });

  it('defaults to "1" (previous behaviour) when no cursor is given', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchCoordinatorMetrics('https://coordinator.test');

    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers['Last-Event-ID']).toBe('1');
  });

  it('two sequential runs on a shared coordinator do not see each other\'s events', async () => {
    // Simulates the real coordinator: a `/api/events` GET only ever returns
    // events with id > Last-Event-ID. Events accumulate over time — the array
    // is mutated as each "run" emits its events, mirroring production instead
    // of pre-seeding the log with events that haven't happened yet. Seeded
    // with one pre-existing event (id 1) to model the realistic D108 scenario
    // — a SHARED, persistent coordinator that already has history — rather
    // than a coordinator that has never seen a single event.
    const liveEvents: { id: number; type: string; data: Record<string, unknown> }[] = [
      { id: 1, type: 'thread_opened', data: { thread_id: 'stale-from-earlier-session' } },
    ];
    const sseFor = (sinceId: number) =>
      liveEvents
        .filter((e) => e.id > sinceId)
        .map((e) => `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}`)
        .join('\n\n');

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const since = parseInt((init!.headers as Record<string, string>)['Last-Event-ID'], 10);
      return new Response(sseFor(since), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    // Run 1 captures baseline 1 (the stale event), then emits its 2 threads.
    const run1Baseline = await fetchLatestEventId('https://coordinator.test');
    expect(run1Baseline).toBe(1);
    liveEvents.push(
      { id: 2, type: 'thread_opened', data: { thread_id: 'run1-t1' } },
      { id: 3, type: 'thread_opened', data: { thread_id: 'run1-t2' } },
    );
    const run1Metrics = await fetchCoordinatorMetrics('https://coordinator.test', run1Baseline);
    expect(run1Metrics.threads_opened).toBe(2);

    // Run 2's baseline is captured AFTER run 1's events exist (max id 3) — it
    // must only see its own thread, not the stale event or run 1's leftovers.
    const run2Baseline = await fetchLatestEventId('https://coordinator.test');
    expect(run2Baseline).toBe(3);
    liveEvents.push({ id: 4, type: 'thread_opened', data: { thread_id: 'run2-t1' } });
    const run2Metrics = await fetchCoordinatorMetrics('https://coordinator.test', run2Baseline);
    expect(run2Metrics.threads_opened).toBe(1);
  });
});

describe('fetchLatestEventId (#108)', () => {
  it('captures the max event id currently buffered by the coordinator', async () => {
    const sse = [
      'id: 5\nevent: thread_opened\ndata: {"thread_id":"t1"}',
      'id: 9\nevent: message_posted\ndata: {"thread_id":"t1"}',
      'id: 7\nevent: message_posted\ndata: {"thread_id":"t1"}',
    ].join('\n\n');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse, { status: 200 })));

    expect(await fetchLatestEventId('https://coordinator.test')).toBe(9);
  });

  it('returns 0 for a fresh coordinator with no events yet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
    expect(await fetchLatestEventId('https://coordinator.test')).toBe(0);
  });

  it('sends Last-Event-ID: 0 to request the buffered-history replay', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchLatestEventId('https://coordinator.test');

    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers['Last-Event-ID']).toBe('0');
  });

  it('degrades to 0 when the coordinator is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await fetchLatestEventId('https://coordinator.test')).toBe(0);
  });
});
