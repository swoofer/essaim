// tests/unit/bce-parity.test.ts
import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { runPipeline } from '@swoofer/promptweave';
import type { Agent } from '@swoofer/promptweave/types';

const BCE_DIR = resolve(import.meta.dirname, '../..');

function buildPreset(preset: string, launchParams: Record<string, Record<string, unknown>> = {}) {
  const agent: Agent = { name: `test-${preset}`, preset, add: [], remove: [], params: {} };
  return runPipeline(agent, BCE_DIR, launchParams);
}

describe('Parity: BCE presets produce complete prompts', () => {

  describe('Raid', () => {
    it('contains bug hunting instructions', () => {
      const result = buildPreset('raid');
      expect(result.output.prompt).toContain('bugs');
      expect(result.output.prompt).toContain('announce_work');
      expect(result.output.prompt).toContain('edge case');
    });

    it('has correct MCP tools', () => {
      const result = buildPreset('raid');
      expect(result.output.mcpTools).toContain('announce_work');
      expect(result.output.mcpTools).toContain('propose_resolution');
      expect(result.output.mcpTools).toContain('log_action_summary');
    });

    it('has worktree isolation hooks', () => {
      const result = buildPreset('raid');
      expect(result.output.hooks['session-start']).toBeDefined();
      expect(result.output.hooks['session-stop']).toBeDefined();
    });
  });

  describe('Melee', () => {
    it('contains test writing instructions', () => {
      const result = buildPreset('melee');
      expect(result.output.prompt).toContain('tests');
      expect(result.output.prompt).toContain('announce_work');
      expect(result.output.prompt).toContain('Phase Discovery');
    });
  });

  describe('Swarm', () => {
    it('contains refactoring instructions', () => {
      const result = buildPreset('swarm');
      expect(result.output.prompt).toContain('refactoring');
      expect(result.output.prompt).toContain('Phase Discovery');
    });
  });

  describe('Gardien', () => {
    it('contains quality audit categories', () => {
      const result = buildPreset('gardien');
      expect(result.output.prompt).toContain('Structure');
      expect(result.output.prompt).toContain('Conventions');
      expect(result.output.prompt).toContain('Complexité');
      expect(result.output.prompt).toContain('Dette technique');
      expect(result.output.prompt).toContain('Tests');
      expect(result.output.prompt).toContain('Documentation');
    });

    it('has read-only mode', () => {
      const result = buildPreset('gardien');
      expect(result.output.prompt).toContain('lecture seule');
    });

    it('uses announce-readonly-adaptation rule', () => {
      const result = buildPreset('gardien');
      expect(result.compositionRulesApplied).toContain('announce-readonly-adaptation');
      expect(result.output.prompt).toContain('analyse'); // not "modifier du code"
    });
  });

  describe('Chaine', () => {
    it('implement preset has implementation instructions', () => {
      const result = buildPreset('chaine-implement');
      expect(result.output.prompt).toContain('Implémenteur');
      expect(result.output.prompt).toContain('amélioration');
    });

    it('review preset has review instructions + read-only', () => {
      const result = buildPreset('chaine-review');
      expect(result.output.prompt).toContain('Reviewer');
      expect(result.output.prompt).toContain('lecture seule');
    });

    it('test preset has testing instructions', () => {
      const result = buildPreset('chaine-test');
      expect(result.output.prompt).toContain('Testeur');
      expect(result.output.prompt).toContain('tests');
    });

    it('test preset uses sequential-then-announce rule', () => {
      const test = buildPreset('chaine-test');
      expect(test.compositionRulesApplied).toContain('sequential-then-announce');
    });
  });

  describe('Relais', () => {
    it('runner 1 has cleanup focus', () => {
      const result = buildPreset('relais-1');
      expect(result.output.prompt).toContain('Nettoyage');
    });

    it('runner 2 has architecture focus + waits for predecessor', () => {
      const result = buildPreset('relais-2');
      expect(result.output.prompt).toContain('architecturale');
      expect(result.output.prompt).toContain('Séquencement');
    });

    it('runner 3 has finalization focus + waits for predecessor', () => {
      const result = buildPreset('relais-3');
      expect(result.output.prompt).toContain('Finition');
      expect(result.output.prompt).toContain('Séquencement');
    });
  });

  describe('Revue', () => {
    it('author preset has improvement instructions', () => {
      const result = buildPreset('revue-author');
      expect(result.output.prompt).toContain('Auteur');
      expect(result.output.prompt).toContain('améliore');
    });

    it('reviewer preset has review instructions', () => {
      const result = buildPreset('revue-reviewer');
      expect(result.output.prompt).toContain('Reviewer');
      expect(result.output.prompt).toContain('approve_resolution');
    });
  });

  describe('Maitre', () => {
    it('lead preset has distribution instructions', () => {
      const result = buildPreset('maitre-lead');
      expect(result.output.prompt).toContain('Tech Lead');
      expect(result.output.prompt).toContain('distribu');
    });

    it('worker preset has execution instructions', () => {
      const result = buildPreset('maitre-worker');
      expect(result.output.prompt).toContain('Worker');
      expect(result.output.prompt).toContain('instructions');
    });
  });

  describe('Debat', () => {
    it('contains debate instructions', () => {
      const result = buildPreset('debat');
      expect(result.output.prompt).toContain('Débat');
      expect(result.output.prompt).toContain('position');
      expect(result.output.prompt).toContain('consensus');
    });
  });

  describe('Babel', () => {
    it('translator has translation instructions', () => {
      const result = buildPreset('babel-translator');
      expect(result.output.prompt).toContain('Tradui');
      expect(result.output.prompt).toContain('Markdown');
    });

    it('reviewer has review instructions', () => {
      const result = buildPreset('babel-reviewer');
      expect(result.output.prompt).toContain('Révis');
      expect(result.output.prompt).toContain('Fidélité');
    });
  });

  describe('Arene', () => {
    it('quizmaster has quiz instructions', () => {
      const result = buildPreset('arene-quizmaster');
      expect(result.output.prompt).toContain('Quizmaster');
      expect(result.output.prompt).toContain('question');
    });

    it('player has competition instructions', () => {
      const result = buildPreset('arene-player');
      expect(result.output.prompt).toContain('compétition');
    });
  });

  describe('Carrefour', () => {
    it('contains conflict test instructions', () => {
      const result = buildPreset('carrefour');
      expect(result.output.prompt).toContain('MÊMES fichiers');
      expect(result.output.prompt).toContain('conflit');
    });
  });

  // Régression #38 — sequential-wait gatait sur le statut de thread seul, qui ne
  // dit RIEN du système de fichiers : un thread « resolved » peut précéder le
  // flush de l'artefact du prédécesseur (voire ne rien produire du tout, quand
  // c'est le balayage de timeout du coordinateur qui l'a résolu). Les deux côtés
  // du contrat sont testés : le producteur écrit avant de résoudre, le
  // consommateur gate sur les fichiers avec retry borné.
  describe('Artifact gate (#38)', () => {
    // Params réellement fournis par le skill invocateur via --set (cf. SMOKE_SET_PARAMS)
    const DEC_PARAMS = {
      'discovery-specialist': { transcript: 'notes/rencontres/test.md' },
      'discovery-synth': { transcript: 'notes/rencontres/test.md', projet: 'test' },
    };

    it('producer writes and verifies its artifact BEFORE proposing resolution', () => {
      // Scopé à la section mission : d'autres behaviors mentionnent
      // propose_resolution plus haut dans le prompt assemblé.
      const result = buildPreset('mekova-dec-risques', DEC_PARAMS);
      const mission = result.sectionTrace.find(
        s => s.behaviorName === 'discovery-specialist' && s.key === '030-mission',
      );
      expect(mission).toBeDefined();
      const write = mission!.prompt.indexOf('tmp/decouverte/risques.yaml');
      const resolveIdx = mission!.prompt.indexOf('propose_resolution');
      expect(write).toBeGreaterThan(-1);
      expect(resolveIdx).toBeGreaterThan(-1);
      expect(write).toBeLessThan(resolveIdx);
    });

    it('consumer gates on the expected files, not just thread status', () => {
      const prompt = buildPreset('mekova-dec-synth', DEC_PARAMS).output.prompt;
      for (const angle of ['features', 'risques', 'roi', 'questions']) {
        expect(prompt).toContain(`tmp/decouverte/${angle}.yaml`);
      }
      expect(prompt).toContain('Séquencement');
      expect(prompt).toContain('sleep');
    });

    it('a resolved thread is explicitly not proof the artifact exists', () => {
      const prompt = buildPreset('mekova-dec-synth', DEC_PARAMS).output.prompt;
      expect(prompt).toMatch(/ne (garantit|prouve) PAS/);
    });

    it('presets without expect_files render with no gate (strict-mode safe)', () => {
      const prompt = buildPreset('relais-2').output.prompt;
      expect(prompt).toContain('Séquencement');
      expect(prompt).not.toContain('Gate sur artefacts');
      expect(prompt).not.toContain('sleep');
    });
  });

  // Le contrat de sortie appartient au PRESET, pas à l'appelant. Un consommateur
  // aval (le runner nocturne, mais aussi n'importe quel autre) doit pouvoir
  // reconnaître un finding déjà signalé. La clé ne peut pas être le titre du
  // commit — le même bug est reformulé autrement d'un agent/d'une nuit à l'autre.
  // Le seul signal stable est le FICHIER FAUTIF, d'où le trailer.
  describe('Bughunt — contrat de sortie Essaim-Target', () => {
    it('exige le trailer nommant le fichier source fautif', () => {
      const prompt = buildPreset('mekova-bughunt').output.prompt;
      expect(prompt).toContain('Essaim-Target:');
    });

    it('demande le fichier SOURCE fautif, pas le fichier de test', () => {
      const prompt = buildPreset('mekova-bughunt').output.prompt;
      expect(prompt).toMatch(/Essaim-Target[\s\S]{0,200}source/i);
    });
  });

  describe('Solo mode', () => {
    it('strips coordination from any preset', () => {
      const result = buildPreset('raid', { 'coordinator-rules': { solo_mode: true } });
      expect(result.compositionRulesApplied).toContain('solo-mode-strip');
      expect(result.output.prompt).toContain('seul');
      expect(result.behaviors.some(b => b.name === 'announce-before-write')).toBe(false);
      expect(result.behaviors.some(b => b.name === 'conflict-resolution')).toBe(false);
      expect(result.behaviors.some(b => b.name === 'liaison-spawn')).toBe(false);
    });
  });
});

