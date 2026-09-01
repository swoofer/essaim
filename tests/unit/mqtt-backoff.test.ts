// tests/unit/mqtt-backoff.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Fake mqtt client — just enough surface for the listener.
class FakeClient extends EventEmitter {
  ended = false;
  options = { reconnectPeriod: 5000 }; // mqtt.js relit reconnectPeriod entre deux tentatives (#33)
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

  // Regression — a post-connect "error" (a plain network blip) used to call
  // giveUp()+reject() immediately, never consulting the MAX_RECONNECT_ATTEMPTS
  // budget the "reconnect" handler is meant to govern.
  it('a post-connect error does not give up — the reconnect budget stays in charge', async () => {
    const listener = createMqttListener({ url: 'ws://c/mqtt', agentId: 'a1', agentModules: [] });
    const promise = listener.connect();
    fake.emit('connect');
    await promise;
    expect(listener.connected).toBe(true);

    fake.emit('error', new Error('transient network blip'));
    expect(fake.end).not.toHaveBeenCalled();

    // The reconnect budget still governs attempts afterwards.
    for (let i = 0; i < 10; i++) fake.emit('reconnect');
    expect(fake.end).toHaveBeenCalled();
  });

  it('an error before any connection still gives up immediately', async () => {
    const listener = createMqttListener({ url: 'ws://c/mqtt', agentId: 'a1', agentModules: [] });
    const promise = listener.connect();
    fake.emit('error', new Error('initial refusal'));
    await expect(promise).rejects.toThrow('initial refusal');
    expect(fake.end).toHaveBeenCalled();
    expect(listener.connected).toBe(false);
  });
});

// #33 — backoff exponentiel plafonné entre deux tentatives, plutôt qu'un
// intervalle fixe qui martèle un ingress refusant l'upgrade WS.
describe('mqtt-listener — backoff exponentiel plafonné (#33)', () => {
  it('double le délai à chaque reconnexion, plafonné à 30s', () => {
    const listener = createMqttListener({ url: 'ws://c/mqtt', agentId: 'a1', agentModules: [] });
    listener.connect().catch(() => {});
    const periods: number[] = [];
    for (let i = 0; i < 4; i++) { fake.emit('reconnect'); periods.push(fake.options.reconnectPeriod); }
    // 5s×2^1=10s, ×2^2=20s, ×2^3=40s→cap 30s, ×2^4=80s→cap 30s
    expect(periods).toEqual([10_000, 20_000, 30_000, 30_000]);
  });

  it('une connexion réussie remet le délai de base (5s)', () => {
    const listener = createMqttListener({ url: 'ws://c/mqtt', agentId: 'a1', agentModules: [] });
    listener.connect().catch(() => {});
    fake.emit('reconnect'); fake.emit('reconnect'); // délai monté à 20s
    expect(fake.options.reconnectPeriod).toBe(20_000);
    fake.emit('connect');
    expect(fake.options.reconnectPeriod).toBe(5_000); // repart de zéro
  });
});
