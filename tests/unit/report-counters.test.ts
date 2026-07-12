// tests/unit/report-counters.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { countDiffLines, formatCost } from '../../src/orchestrator/reporter.js';
import { fetchCoordinatorMetrics } from '../../src/orchestrator/metrics.js';

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
