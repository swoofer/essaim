// tests/unit/mqtt-backoff.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Fake mqtt client — just enough surface for the listener.
class FakeClient extends EventEmitter {
  ended = false;
  subscribe = vi.fn((_topics: unknown, cb: (e?: Error) => void) => cb());
  end = vi.fn((_force?: boolean) => { this.ended = true; });
}

const connectMock = vi.fn();
vi.mock('mqtt', () => ({
  default: { connect: (...args: unknown[]) => connectMock(...args) },
  connect: (...args: unknown[]) => connectMock(...args),
  MqttClient: class {},
}));

const { createMqttListener } = await import('../../src/agent-loop/mqtt-listener.js');

let fake: FakeClient;
beforeEach(() => {
  fake = new FakeClient();
  connectMock.mockReset();
  connectMock.mockImplementation(() => fake);
});

// Régression #33 — contre un coordinateur distant (wss derrière un ingress), le
// listener logguait « disconnected » en boucle serrée pendant TOUT le run.
// mqtt.js reconnecte par défaut toutes les 1 s, indéfiniment ; et surtout, quand
// connect() échouait, le client n'était jamais fermé : l'appelant dégradait
// proprement pendant que le client, lui, continuait à retenter dans son dos.
describe('mqtt-listener — backoff et abandon (#33)', () => {
  it('ne reconnecte pas toutes les secondes (défaut mqtt.js)', () => {
    const listener = createMqttListener({ url: 'ws://c/mqtt', agentId: 'a1', agentModules: [] });
    listener.connect().catch(() => {});
    const opts = connectMock.mock.calls[0][1] as { reconnectPeriod: number };
    expect(opts.reconnectPeriod).toBeGreaterThanOrEqual(5000);
  });

  it('ferme le client quand la connexion échoue — sinon il retente dans le dos de l\'appelant', async () => {
    const listener = createMqttListener({ url: 'ws://c/mqtt', agentId: 'a1', agentModules: [] });
    const promise = listener.connect();
    fake.emit('error', new Error('WS upgrade refusé'));
    await expect(promise).rejects.toThrow('WS upgrade refusé');
    expect(fake.end).toHaveBeenCalled();
    expect(listener.connected).toBe(false);
  });

  it('abandonne après un nombre borné de tentatives au lieu de spammer tout le run', async () => {
    const listener = createMqttListener({ url: 'ws://c/mqtt', agentId: 'a1', agentModules: [] });
    listener.connect().catch(() => {});
    for (let i = 0; i < 10; i++) fake.emit('reconnect');
    expect(fake.end).toHaveBeenCalled();
  });

  it('une connexion réussie remet le budget de reconnexions à zéro', async () => {
    const listener = createMqttListener({ url: 'ws://c/mqtt', agentId: 'a1', agentModules: [] });
    const promise = listener.connect();
    fake.emit('connect');
    await promise;
    expect(listener.connected).toBe(true);

    // Quelques coupures réseau passagères ne doivent pas condamner le listener.
    for (let i = 0; i < 3; i++) fake.emit('reconnect');
    expect(fake.end).not.toHaveBeenCalled();
  });
});
