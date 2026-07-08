/**
 * Tests for the hardened injected-provider ↔ content-script channel (#73).
 *
 * The window.postMessage pipe between the MAIN-world provider (dig-provider.js) and the isolated
 * content bridge (content.js) is the wallet's outermost trust boundary. Before this pass it was a
 * flat `{ type, id, method, params }` message with a `Math.random()` id, NO origin check, and an
 * unbounded pending map — a same-page script could read the request id off the wire and forge a
 * `DIG_WALLET_RESPONSE` (poisoning what a dApp believes the wallet returned), a foreign-frame
 * message was distinguished only by `event.source`, and a flood of requests grew the pending map
 * without bound.
 *
 * This suite pins the pure channel primitives that both sides now share: a namespaced/versioned
 * envelope, a CSPRNG id, strict inbound validation that DROPS (never throws on) anything malformed
 * or cross-origin, and a bounded, id-correlated pending registry where a response can settle its
 * request exactly once (a forged/duplicate/unknown-id response is dropped, and concurrent requests
 * never cross).
 */
import { describe, it, expect, vi } from 'vitest';
import { BRIDGE } from './messages';
import {
  PROVIDER_CHANNEL,
  MAX_INFLIGHT,
  MAX_ID_LEN,
  MAX_METHOD_LEN,
  newRequestId,
  buildRequest,
  buildResponse,
  postTargetOrigin,
  parseInboundRequest,
  parseInboundResponse,
  PendingRegistry,
} from './provider-channel';

const ORIGIN = 'https://dapp.example';

describe('envelope builders', () => {
  it('buildRequest emits a namespaced, versioned, id/method/params envelope', () => {
    const req = buildRequest('abc123', 'chip0002_connect', { eager: true });
    expect(req.channel).toBe(PROVIDER_CHANNEL);
    expect(req.type).toBe(BRIDGE.WALLET_REQUEST);
    expect(req.id).toBe('abc123');
    expect(req.method).toBe('chip0002_connect');
    expect(req.params).toEqual({ eager: true });
  });

  it('buildRequest defaults params to an empty object', () => {
    expect(buildRequest('id', 'm').params).toEqual({});
  });

  it('buildResponse echoes the id and carries the wallet envelope fields', () => {
    const res = buildResponse('abc123', { status: 200, body: { data: { ok: 1 } } });
    expect(res.channel).toBe(PROVIDER_CHANNEL);
    expect(res.type).toBe(BRIDGE.WALLET_RESPONSE);
    expect(res.id).toBe('abc123');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { ok: 1 } });
  });
});

describe('newRequestId', () => {
  it('returns a long hex id from the CSPRNG, unique across calls', () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it('draws from crypto.getRandomValues (not Math.random)', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    newRequestId();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('postTargetOrigin', () => {
  it('passes a normal origin through so the reply is delivered same-origin only', () => {
    expect(postTargetOrigin(ORIGIN)).toBe(ORIGIN);
  });
  it('falls back to "*" for an opaque ("null") origin (sandboxed/data: document)', () => {
    // targetOrigin "null" is invalid for postMessage and throws — an opaque doc must use "*".
    expect(postTargetOrigin('null')).toBe('*');
  });
});

describe('parseInboundRequest — accepts only well-formed, same-origin requests', () => {
  const good = buildRequest('id-1', 'chip0002_getPublicKeys', { x: 1 });

  it('accepts a valid same-origin request and returns the correlated fields', () => {
    expect(parseInboundRequest(good, ORIGIN, ORIGIN)).toEqual({
      id: 'id-1',
      method: 'chip0002_getPublicKeys',
      params: { x: 1 },
    });
  });

  it('drops a request whose event origin differs from the document origin (cross-origin spoof)', () => {
    expect(parseInboundRequest(good, 'https://evil.example', ORIGIN)).toBeNull();
  });

  it('drops a message on the wrong channel (unrelated postMessage traffic)', () => {
    expect(parseInboundRequest({ ...good, channel: 'other' }, ORIGIN, ORIGIN)).toBeNull();
  });

  it('drops a response-typed message posing as a request', () => {
    expect(parseInboundRequest({ ...good, type: BRIDGE.WALLET_RESPONSE }, ORIGIN, ORIGIN)).toBeNull();
  });

  it('drops non-object / null / primitive payloads without throwing', () => {
    expect(parseInboundRequest(null, ORIGIN, ORIGIN)).toBeNull();
    expect(parseInboundRequest(undefined, ORIGIN, ORIGIN)).toBeNull();
    expect(parseInboundRequest('DIG_WALLET_REQUEST', ORIGIN, ORIGIN)).toBeNull();
    expect(parseInboundRequest(42, ORIGIN, ORIGIN)).toBeNull();
  });

  it('drops a request with a missing / non-string / empty / oversized id', () => {
    expect(parseInboundRequest({ ...good, id: undefined }, ORIGIN, ORIGIN)).toBeNull();
    expect(parseInboundRequest({ ...good, id: 123 }, ORIGIN, ORIGIN)).toBeNull();
    expect(parseInboundRequest({ ...good, id: '' }, ORIGIN, ORIGIN)).toBeNull();
    expect(parseInboundRequest({ ...good, id: 'x'.repeat(MAX_ID_LEN + 1) }, ORIGIN, ORIGIN)).toBeNull();
  });

  it('drops a request with a missing / non-string / oversized method', () => {
    expect(parseInboundRequest({ ...good, method: undefined }, ORIGIN, ORIGIN)).toBeNull();
    expect(parseInboundRequest({ ...good, method: 5 }, ORIGIN, ORIGIN)).toBeNull();
    expect(parseInboundRequest({ ...good, method: 'm'.repeat(MAX_METHOD_LEN + 1) }, ORIGIN, ORIGIN)).toBeNull();
  });

  it('coerces a non-object params to an empty object', () => {
    expect(parseInboundRequest({ ...good, params: 'nope' }, ORIGIN, ORIGIN)?.params).toEqual({});
    expect(parseInboundRequest({ ...good, params: undefined }, ORIGIN, ORIGIN)?.params).toEqual({});
  });
});

describe('parseInboundResponse — accepts only well-formed, same-origin responses', () => {
  const good = buildResponse('id-1', { status: 200, body: { data: { a: 1 } } });

  it('accepts a valid same-origin response', () => {
    expect(parseInboundResponse(good, ORIGIN, ORIGIN)).toEqual({
      id: 'id-1',
      status: 200,
      body: { data: { a: 1 } },
      error: undefined,
    });
  });

  it('drops a response from a foreign event origin', () => {
    expect(parseInboundResponse(good, 'https://evil.example', ORIGIN)).toBeNull();
  });

  it('drops a request-typed message posing as a response', () => {
    expect(parseInboundResponse({ ...good, type: BRIDGE.WALLET_REQUEST }, ORIGIN, ORIGIN)).toBeNull();
  });

  it('drops wrong-channel / malformed payloads', () => {
    expect(parseInboundResponse({ ...good, channel: 'x' }, ORIGIN, ORIGIN)).toBeNull();
    expect(parseInboundResponse(null, ORIGIN, ORIGIN)).toBeNull();
    expect(parseInboundResponse({ ...good, id: '' }, ORIGIN, ORIGIN)).toBeNull();
  });
});

describe('PendingRegistry — bounded, id-correlated, settle-once', () => {
  it('settles a pending request exactly once by its id', () => {
    const reg = new PendingRegistry<number>();
    const resolve = vi.fn();
    expect(reg.add('a', { resolve })).toBe(true);
    expect(reg.size).toBe(1);
    expect(reg.settle('a', 7)).toBe(true);
    expect(resolve).toHaveBeenCalledWith(7);
    expect(reg.size).toBe(0);
  });

  it('drops a response for an unknown id (a forged reply cannot resolve a request)', () => {
    const reg = new PendingRegistry<number>();
    reg.add('a', { resolve: vi.fn() });
    expect(reg.settle('guessed', 1)).toBe(false);
    expect(reg.size).toBe(1);
  });

  it('drops a duplicate/replayed response — the second settle for an id is a no-op', () => {
    const reg = new PendingRegistry<number>();
    const resolve = vi.fn();
    reg.add('a', { resolve });
    expect(reg.settle('a', 1)).toBe(true);
    expect(reg.settle('a', 999)).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(1);
  });

  it('keeps concurrent multiplexed requests from crossing — each id resolves independently', () => {
    const reg = new PendingRegistry<string>();
    const ra = vi.fn();
    const rb = vi.fn();
    reg.add('a', { resolve: ra });
    reg.add('b', { resolve: rb });
    reg.settle('b', 'B');
    expect(rb).toHaveBeenCalledWith('B');
    expect(ra).not.toHaveBeenCalled();
    reg.settle('a', 'A');
    expect(ra).toHaveBeenCalledWith('A');
  });

  it('refuses a colliding id rather than overwriting an in-flight request', () => {
    const reg = new PendingRegistry<number>();
    const first = vi.fn();
    reg.add('a', { resolve: first });
    expect(reg.add('a', { resolve: vi.fn() })).toBe(false);
    reg.settle('a', 1);
    expect(first).toHaveBeenCalledWith(1);
  });

  it('is bounded — add returns false past capacity (a request flood cannot grow it without bound)', () => {
    const reg = new PendingRegistry<number>(3);
    expect(reg.add('a', { resolve: vi.fn() })).toBe(true);
    expect(reg.add('b', { resolve: vi.fn() })).toBe(true);
    expect(reg.add('c', { resolve: vi.fn() })).toBe(true);
    expect(reg.add('d', { resolve: vi.fn() })).toBe(false);
    expect(reg.size).toBe(3);
  });

  it('defaults capacity to MAX_INFLIGHT', () => {
    const reg = new PendingRegistry<number>();
    expect(MAX_INFLIGHT).toBeGreaterThan(0);
    for (let i = 0; i < MAX_INFLIGHT; i++) expect(reg.add(`id${i}`, { resolve: vi.fn() })).toBe(true);
    expect(reg.add('overflow', { resolve: vi.fn() })).toBe(false);
  });

  it('runs a per-entry cleanup on settle and on clear (timeout teardown)', () => {
    const reg = new PendingRegistry<number>();
    const cleanupA = vi.fn();
    const cleanupB = vi.fn();
    reg.add('a', { resolve: vi.fn(), cleanup: cleanupA });
    reg.add('b', { resolve: vi.fn(), cleanup: cleanupB });
    reg.settle('a', 1);
    expect(cleanupA).toHaveBeenCalledTimes(1);
    reg.clear();
    expect(cleanupB).toHaveBeenCalledTimes(1);
    expect(reg.size).toBe(0);
  });
});
