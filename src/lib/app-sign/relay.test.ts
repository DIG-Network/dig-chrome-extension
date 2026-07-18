import { describe, it, expect, beforeEach } from 'vitest';
import { createAppSignController } from './app-sign-ws';
import { AppSignRelay } from './relay';
import { PairingStore, type KvStore } from './pairing-store';
import { MockAppServer } from './testing/mock-app-server';

function memoryKv(): KvStore {
  const data = new Map<string, unknown>();
  return { get: async (k) => data.get(k), set: async (k, v) => void data.set(k, v), remove: async (k) => void data.delete(k) };
}

/** Wire a relay to a fresh mock dig-app server through a real controller. */
function harness(config?: ConstructorParameters<typeof MockAppServer>[0]) {
  const server = new MockAppServer(config);
  const controller = createAppSignController({ createSocket: () => server.socket });
  const relay = new AppSignRelay({ controller, pairingStore: new PairingStore(memoryKv()), extId: 'chrome-extension://pinned', extLabel: 'DIG' });
  controller.start();
  return { server, controller, relay };
}

// Give the microtask-based mock time to open + reply.
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('AppSignRelay ↔ MockAppServer (SPEC §5.6 round-trip)', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(async () => {
    h = harness();
    await tick();
  });

  it('pairs, then connects, then signs — the full happy path', async () => {
    expect(await h.relay.isPaired()).toBe(false);
    await h.relay.pair();
    expect(await h.relay.isPaired()).toBe(true);

    const connectRes = await h.relay.connect('https://cxch.app', { dappName: 'cXch' });
    expect(connectRes.granted).toBe(true);
    expect(connectRes.profile_did).toBe('did:chia:mock');

    const signRes = await h.relay.sign('https://cxch.app', { payloadType: 'spend', payloadB64: 'ZGVhZGJlZWY=' });
    expect(signRes.signature_b64).toBeTruthy();
    expect(signRes.pubkey_hex).toBe('b0mockpubkey');
  });

  it('relays the TRUE committed origin the caller supplies (never a page-claimed one)', async () => {
    await h.relay.pair();
    // The extension passes the browser-committed origin; the mock records what it received.
    await h.relay.connect('https://real-origin.example', {});
    const connectFrame = h.server.observed.find((f) => f.method === 'connect.request');
    expect(connectFrame?.origin).toBe('https://real-origin.example');
    // There is no relay API path that reads an origin out of params — connect() takes it as arg 1.
  });

  it('the mock verifies the auth-MAC — proving canonical_json + HMAC match byte-for-byte', async () => {
    await h.relay.pair();
    // A bad MAC would come back AUTH_BAD_MAC; a grant proves the mock recomputed the same MAC.
    await expect(h.relay.connect('https://x', {})).resolves.toMatchObject({ granted: true });
  });

  it('enforces strict nonce monotonicity across sequential authed frames', async () => {
    await h.relay.pair();
    // Three sequential authed frames must each carry a strictly greater nonce; the mock rejects
    // AUTH_REPLAY otherwise, so all three succeeding proves monotonicity.
    await expect(h.relay.connect('https://x', {})).resolves.toMatchObject({ granted: true });
    await expect(h.relay.connect('https://x', {})).resolves.toMatchObject({ granted: true });
    await expect(h.relay.sign('https://x', { payloadType: 'spend', payloadB64: 'AA==' })).resolves.toBeTruthy();
  });

  it('rejects a sign for an un-whitelisted origin with CONNECT_REQUIRED', async () => {
    await h.relay.pair();
    await expect(h.relay.sign('https://not-connected', { payloadType: 'spend', payloadB64: 'AA==' })).rejects.toMatchObject({
      code: 'CONNECT_REQUIRED',
    });
  });

  it('surfaces the §5.6.7 code when the user denies a sign', async () => {
    const denied = harness({ signOutcome: 'SIGN_DENIED', whitelisted: ['https://x'] });
    await tick();
    await denied.relay.pair();
    await expect(denied.relay.sign('https://x', { payloadType: 'spend', payloadB64: 'AA==' })).rejects.toMatchObject({
      code: 'SIGN_DENIED',
    });
  });

  it('rejects an authed request with NOT_PAIRED before pairing', async () => {
    await expect(h.relay.connect('https://x', {})).rejects.toMatchObject({ code: 'NOT_PAIRED' });
  });

  it('unpair clears the local record', async () => {
    await h.relay.pair();
    await h.relay.unpair();
    expect(await h.relay.isPaired()).toBe(false);
  });
});

describe('AppSignRelay — app not running', () => {
  it('rejects APP_NOT_RUNNING when the channel never connects', async () => {
    // A controller whose socket never opens (createSocket returns a dead socket).
    const dead = { onopen: null, onmessage: null, onclose: null, onerror: null, send: () => {}, close: () => {} };
    const controller = createAppSignController({ createSocket: () => dead });
    const relay = new AppSignRelay({ controller, pairingStore: new PairingStore(memoryKv()), extId: 'x' });
    controller.start();
    await expect(relay.pair()).rejects.toMatchObject({ code: 'APP_NOT_RUNNING' });
  });
});
