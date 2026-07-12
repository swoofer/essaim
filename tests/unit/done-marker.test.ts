// tests/unit/done-marker.test.ts
import { describe, it, expect } from 'vitest';
import { hasDoneMarker, extractDoneSummary } from '../../src/agent-loop/agent-loop.js';

// Régression #31 — un worker avait livré son commit mais sa boucle a continué
// jusqu'au plafond de 50 tours puis est sortie en exit 1. La détection de fin
// était un `includes("DONE:")` littéral : or TOUS les prompts d'essaim sont en
// français, et la typographie française met une espace avant le deux-points
// (« DONE : résumé »). Ce marqueur-là n'était jamais reconnu — l'agent avait
// fini, personne ne l'entendait le dire.
describe('hasDoneMarker (#31)', () => {
  it('reconnaît la forme canonique', () => {
    expect(hasDoneMarker('DONE: 3 items')).toBe(true);
  });

  it('reconnaît la typographie française — espace avant le deux-points', () => {
    expect(hasDoneMarker('DONE : 3 items')).toBe(true);
  });

  it('reconnaît les espaces insécables français (U+00A0, U+202F)', () => {
    expect(hasDoneMarker('DONE : fini')).toBe(true);
    expect(hasDoneMarker('DONE : fini')).toBe(true);
  });

  it('reconnaît le marqueur emphasé en markdown', () => {
    expect(hasDoneMarker('**DONE:** commit livré')).toBe(true);
    expect(hasDoneMarker('**DONE**: commit livré')).toBe(true);
    expect(hasDoneMarker('`DONE`: commit livré')).toBe(true);
  });

  it('est insensible à la casse', () => {
    expect(hasDoneMarker('Done: fini')).toBe(true);
  });

  it('ne se déclenche pas sans marqueur', () => {
    expect(hasDoneMarker('Je continue le travail.')).toBe(false);
    expect(hasDoneMarker('Cette tâche est done, je passe à la suite.')).toBe(false);
    expect(hasDoneMarker('ABANDONNE: rien à faire')).toBe(false);
  });
});

describe('extractDoneSummary (#31)', () => {
  it('extrait le résumé après le marqueur', () => {
    expect(extractDoneSummary('DONE: 3 items (risques)', 'fallback')).toBe('3 items (risques)');
  });

  it('extrait le résumé malgré la typographie française', () => {
    expect(extractDoneSummary('DONE : 3 items', 'fallback')).toBe('3 items');
  });

  it('nettoie le markdown résiduel', () => {
    expect(extractDoneSummary('**DONE:** commit livré', 'fallback')).toBe('commit livré');
  });

  it('prend le DERNIER marqueur — l\'agent cite souvent sa consigne avant de finir', () => {
    const content = 'Je terminerai par DONE: <résumé> quand j\'aurai fini.\n\nDONE: commit abc123 livré';
    expect(extractDoneSummary(content, 'fallback')).toBe('commit abc123 livré');
  });

  it('retombe sur le fallback si le résumé est vide ou absent', () => {
    expect(extractDoneSummary('DONE:', 'fallback')).toBe('fallback');
    expect(extractDoneSummary('rien ici', 'fallback')).toBe('fallback');
  });
});
