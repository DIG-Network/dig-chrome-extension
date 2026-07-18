import { describe, it, expect } from 'vitest';
import { createAppSignController } from './app-sign-ws';
import { AppSignError } from './errors';
import type { WebSocketLike } from '../dig-node-ws';

/** A controllable fake socket that never opens on its own — the test drives open/message/close. */
function fakeSocket() {
  const sent: string[] = [];
  const s: WebSocketLike & { send: (d: string) => void; sent: string[] } = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (d: string) => void sent.push(d),
    close: () => s.onclose?.({}),
    sent,
  };
  return s;
}

const noopTimers = {
  scheduleTimeout: (fn: () => void) => fn as unknown, // never auto-fire; tests fire explicitly if needed
  clearScheduledTimeout: () => {},
};

describe('createAppSignController', () => {
  it('connects, sends a JSON-RPC 2.0 frame, and resolves on the correlated result', async () => {
    const socket = fakeSocket();
    const ctrl = createAppSignController({ createSocket: () => socket, ...noopTimers });
    ctrl.start();
    socket.onopen?.({});
    expect(ctrl.getConnState()).toBe('connected');

    const p = ctrl.request('connect.request', { origin: 'https://x' });
    const frame = JSON.parse(socket.sent[0]);
    expect(frame).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'connect.request', params: { origin: 'https://x' } });

    socket.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { granted: true } }) });
    await expect(p).resolves.toEqual({ granted: true });
  });

  it('attaches the auth object when supplied', async () => {
    const socket = fakeSocket();
    const ctrl = createAppSignController({ createSocket: () => socket, ...noopTimers });
    ctrl.start();
    socket.onopen?.({});
    void ctrl.request('sign.request', { origin: 'https://x' }, { pairing_id: 'p', nonce: 5, mac_b64: 'bWFj' });
    expect(JSON.parse(socket.sent[0]).auth).toEqual({ pairing_id: 'p', nonce: 5, mac_b64: 'bWFj' });
  });

  it('rejects with the §5.6.7 symbolic code carried in error.data', async () => {
    const socket = fakeSocket();
    const ctrl = createAppSignController({ createSocket: () => socket, ...noopTimers });
    ctrl.start();
    socket.onopen?.({});
    const p = ctrl.request('sign.request', {});
    socket.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'no', data: 'SIGN_DENIED' } }) });
    await expect(p).rejects.toMatchObject({ code: 'SIGN_DENIED' });
  });

  it('maps an unknown error.data to BAD_RESPONSE', async () => {
    const socket = fakeSocket();
    const ctrl = createAppSignController({ createSocket: () => socket, ...noopTimers });
    ctrl.start();
    socket.onopen?.({});
    const p = ctrl.request('sign.request', {});
    socket.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, data: 'WAT' } }) });
    await expect(p).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('rejects APP_NOT_RUNNING when the socket is not connected (no fallback exists)', async () => {
    const ctrl = createAppSignController({ createSocket: fakeSocket, ...noopTimers });
    // never started → disconnected
    await expect(ctrl.request('pair.begin', {})).rejects.toMatchObject({ code: 'APP_NOT_RUNNING' });
  });

  it('fails in-flight requests as TRANSPORT_CLOSED on socket close', async () => {
    const socket = fakeSocket();
    const ctrl = createAppSignController({ createSocket: () => socket, ...noopTimers, baseReconnectDelayMs: 0 });
    ctrl.start();
    socket.onopen?.({});
    const p = ctrl.request('sign.request', {});
    socket.onclose?.({});
    await expect(p).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' });
    expect(ctrl.getConnState()).toBe('disconnected');
  });

  it('times out an unanswered request with TRANSPORT_TIMEOUT', async () => {
    const socket = fakeSocket();
    const fired: Array<() => void> = [];
    const ctrl = createAppSignController({
      createSocket: () => socket,
      scheduleTimeout: (fn: () => void) => {
        fired.push(fn);
        return 1;
      },
      clearScheduledTimeout: () => {},
    });
    ctrl.start();
    socket.onopen?.({});
    const p = ctrl.request('sign.request', {});
    // The last scheduled timer is this request's timeout (earlier ones are the stale watchdog).
    fired[fired.length - 1]();
    await expect(p).rejects.toBeInstanceOf(AppSignError);
    await expect(p).rejects.toMatchObject({ code: 'TRANSPORT_TIMEOUT' });
  });

  it('notifies subscribers on connection-state changes', () => {
    const socket = fakeSocket();
    const states: string[] = [];
    const ctrl = createAppSignController({ createSocket: () => socket, ...noopTimers });
    ctrl.subscribe((s) => states.push(s));
    ctrl.start();
    socket.onopen?.({});
    ctrl.stop();
    expect(states).toEqual(['connecting', 'connected', 'disconnected']);
  });
});
