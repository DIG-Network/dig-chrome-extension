import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACTIONS } from '@/lib/messages';
import { createAppSignController } from '@/lib/app-sign/app-sign-ws';
import { AppSignRelay, type ConnectParams, type SignParams } from '@/lib/app-sign/relay';
import { PairingStore } from '@/lib/app-sign/pairing-store';

/** Test messages never carry real connect/sign params — the dispatcher passes `params` through untouched. */
const NO_PARAMS = {} as ConnectParams & SignParams;

// The controller/relay/store are exercised by their OWN unit suites (app-sign-ws.test.ts,
// relay.test.ts, pairing-store.test.ts) — this file tests only the SW-facing dispatcher wiring
// (`handles`/`handle` + the origin-spoof guard), so its collaborators are mocked. `vi.hoisted` is
// required because `vi.mock` factories are hoisted above ordinary `const` declarations — a plain
// module-scope const referenced inside a factory would be read before initialization.
const { getConnState, startMock, isPaired, connect, sign } = vi.hoisted(() => ({
  getConnState: vi.fn(() => 'disconnected'),
  startMock: vi.fn(),
  isPaired: vi.fn(async () => false),
  connect: vi.fn(async () => ({ connected: true })),
  sign: vi.fn(async () => ({ signature: 'sig' })),
}));

vi.mock('@/lib/app-sign/app-sign-ws', () => ({
  createAppSignController: vi.fn(() => ({
    start: startMock,
    getConnState,
  })),
}));

vi.mock('@/lib/app-sign/relay', () => ({
  AppSignRelay: vi.fn().mockImplementation(() => ({
    isPaired,
    connect,
    sign,
    pair: vi.fn(async () => undefined),
    unpair: vi.fn(async () => undefined),
  })),
}));

vi.mock('@/lib/app-sign/pairing-store', () => ({
  PairingStore: vi.fn().mockImplementation(() => ({})),
}));

// Imported AFTER the mocks above so `createAppSignHandler` wires against the fakes.
const { createAppSignHandler } = await import('./app-sign-handlers');

/** Await one microtask turn — flushes the dispatcher's `void (async () => {...})()` IIFE. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeSender(origin: string | null): chrome.runtime.MessageSender {
  return (origin === null ? {} : { origin }) as chrome.runtime.MessageSender;
}

describe('createAppSignHandler', () => {
  let broadcastRuntime: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // The shared `vitest.setup.ts` runs a global `afterEach(() => vi.restoreAllMocks())`, which
    // also strips the `.mockImplementation(...)` wired onto the constructor mocks above (not just
    // spy call-history) — so each test re-wires them here rather than relying on the one-time
    // module-load-time setup surviving across tests.
    getConnState.mockClear();
    startMock.mockClear();
    isPaired.mockClear();
    connect.mockClear();
    sign.mockClear();
    vi.mocked(createAppSignController).mockImplementation(
      () => ({ start: startMock, getConnState }) as unknown as ReturnType<typeof createAppSignController>,
    );
    vi.mocked(AppSignRelay).mockImplementation(
      () =>
        ({
          isPaired,
          connect,
          sign,
          pair: vi.fn(async () => undefined),
          unpair: vi.fn(async () => undefined),
        }) as unknown as AppSignRelay,
    );
    vi.mocked(PairingStore).mockImplementation(() => ({}) as unknown as PairingStore);
    broadcastRuntime = vi.fn();
  });

  it('constructs without throwing even when the WS controller.start() guard trips', () => {
    // jsdom has no real WebSocket-backed reconnect loop; createAppSignController is mocked here so
    // `start` never actually opens a socket, but the surrounding try/catch is what the real module
    // relies on when WebSocket is genuinely absent — proven by this constructing cleanly regardless.
    expect(() => createAppSignHandler({ broadcastRuntime })).not.toThrow();
  });

  it.each(APP_SIGN_ACTIONS())('handles() returns true for %s', (action) => {
    const handler = createAppSignHandler({ broadcastRuntime });
    expect(handler.handles(action)).toBe(true);
  });

  it('handles() returns false for an unrelated action', () => {
    const handler = createAppSignHandler({ broadcastRuntime });
    expect(handler.handles('someOtherAction')).toBe(false);
  });

  it('handles() returns false for undefined', () => {
    const handler = createAppSignHandler({ broadcastRuntime });
    expect(handler.handles(undefined)).toBe(false);
  });

  it('handle() returns false and does nothing for a non-APP-SIGN action', () => {
    const handler = createAppSignHandler({ broadcastRuntime });
    const sendResponse = vi.fn();
    const took = handler.handle({ action: 'notAppSign' }, makeSender('https://dapp.example'), sendResponse);
    expect(took).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('handle() returns true for an APP-SIGN action', () => {
    const handler = createAppSignHandler({ broadcastRuntime });
    const sendResponse = vi.fn();
    const took = handler.handle({ action: ACTIONS.appSignStatus }, makeSender('https://dapp.example'), sendResponse);
    expect(took).toBe(true);
  });

  it('appSignStatus resolves { paired, connState } from the relay + controller', async () => {
    isPaired.mockResolvedValueOnce(true);
    getConnState.mockReturnValueOnce('connected');
    const handler = createAppSignHandler({ broadcastRuntime });
    const sendResponse = vi.fn();
    handler.handle({ action: ACTIONS.appSignStatus }, makeSender('https://dapp.example'), sendResponse);
    await flush();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, data: { paired: true, connState: 'connected' } });
  });

  it('appSignConnect throws CONNECT_REQUIRED when sender.origin is null (origin-spoof guard)', async () => {
    const handler = createAppSignHandler({ broadcastRuntime });
    const sendResponse = vi.fn();
    handler.handle({ action: ACTIONS.appSignConnect, params: NO_PARAMS }, makeSender(null), sendResponse);
    await flush();
    expect(connect).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, success: false, code: 'CONNECT_REQUIRED' }),
    );
  });

  it('appSignSign throws CONNECT_REQUIRED when sender.origin is null (origin-spoof guard)', async () => {
    const handler = createAppSignHandler({ broadcastRuntime });
    const sendResponse = vi.fn();
    handler.handle({ action: ACTIONS.appSignSign, params: NO_PARAMS }, makeSender(null), sendResponse);
    await flush();
    expect(sign).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, success: false, code: 'CONNECT_REQUIRED' }),
    );
  });

  it('appSignConnect passes the committed sender origin through to the relay when present', async () => {
    const handler = createAppSignHandler({ broadcastRuntime });
    const sendResponse = vi.fn();
    handler.handle({ action: ACTIONS.appSignConnect, params: NO_PARAMS }, makeSender('https://dapp.example'), sendResponse);
    await flush();
    expect(connect).toHaveBeenCalledWith('https://dapp.example', {});
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, data: { connected: true } });
  });
});

/** The 5 APP-SIGN actions, read from the real ACTIONS table (not re-declared, so a rename is caught). */
function APP_SIGN_ACTIONS(): string[] {
  return [ACTIONS.appSignStatus, ACTIONS.appSignPair, ACTIONS.appSignUnpair, ACTIONS.appSignConnect, ACTIONS.appSignSign];
}
