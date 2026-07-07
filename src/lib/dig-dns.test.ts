/**
 * Tests for the dig-dns Path-B proxy fallback (#175, Component C of #174).
 *
 * dig-dns (modules/apps/dig-dns) is a loopback OS service giving `*.dig` browser resolution two
 * independent ways to work: Path A (OS split-DNS routes `.dig` → 127.0.0.5) and Path B (a PAC
 * proxy — `/.dig/proxy.pac` — routes `*.dig` to the gateway as an HTTP proxy, no DNS needed). This
 * module makes the EXTENSION side of Path B self-healing: it detects when dig-dns is running, and
 * when a `.dig` navigation actually fails, engages `chrome.proxy` pointed at dig-dns's PAC file so
 * the page still loads. It disengages again once Path A appears to have recovered.
 *
 * Every dependency (fetch, chrome.proxy, the clock) is injected, so the state machine is fully
 * unit-testable without a browser — the SW wires the real `chrome.proxy`/`fetch`/webNavigation
 * events to it (src/background/index.ts, excluded from coverage as chrome.* glue).
 *
 * Run: node --test tests/ (vitest picks this up under src/**\/*.test.ts)
 */
import { test, describe, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  DIG_DNS_LOOPBACK_IP,
  DIG_DNS_GATEWAY_PORTS,
  DIG_DNS_RECOVERY_PROBE_THRESHOLD,
  DIG_DNS_STATUS_REFRESH_MS,
  buildDigDnsPacUrl,
  buildDigDnsProxyConfig,
  probeDigDns,
  createDigDnsAvailabilityController,
  isDotDigNavigationFailure,
  shouldRefreshDigDnsSnapshot,
} from '@/lib/dig-dns';

/** Build a minimal fetch double keyed by exact URL string. */
function fakeFetch(routes: Record<string, { status: number; body?: unknown } | Error>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const route = routes[url];
    if (route === undefined) throw new Error(`fakeFetch: no route for ${url}`);
    if (route instanceof Error) throw route;
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: async () => route.body,
    } as Response;
  }) as typeof fetch;
}

/** A chrome.proxy.settings double that records every set()/clear() call. */
function fakeChromeProxy() {
  const calls: Array<{ op: 'set' | 'clear'; arg: unknown }> = [];
  return {
    calls,
    set: async (config: unknown) => {
      calls.push({ op: 'set', arg: config });
    },
    clear: async (config: unknown) => {
      calls.push({ op: 'clear', arg: config });
    },
  };
}

describe('constants', () => {
  test('the dig-dns loopback IP + gateway port fallback order match the dig-dns contract', () => {
    assert.equal(DIG_DNS_LOOPBACK_IP, '127.0.0.5');
    assert.deepEqual(DIG_DNS_GATEWAY_PORTS, [80, 8053]);
  });
});

describe('buildDigDnsPacUrl / buildDigDnsProxyConfig', () => {
  test('builds the /.dig/proxy.pac URL for the bound port', () => {
    assert.equal(buildDigDnsPacUrl('127.0.0.5', 80), 'http://127.0.0.5:80/.dig/proxy.pac');
    assert.equal(buildDigDnsPacUrl('127.0.0.5', 8053), 'http://127.0.0.5:8053/.dig/proxy.pac');
  });

  test('builds a chrome.proxy.settings pac_script config scoped to the regular profile', () => {
    const cfg = buildDigDnsProxyConfig('http://127.0.0.5:80/.dig/proxy.pac');
    assert.deepEqual(cfg, {
      value: { mode: 'pac_script', pacScript: { url: 'http://127.0.0.5:80/.dig/proxy.pac' } },
      scope: 'regular',
    });
  });
});

describe('probeDigDns', () => {
  test('available on port 80 when resolve-probe answers 204 and health reports the bound port', async () => {
    const fetchImpl = fakeFetch({
      'http://127.0.0.5:80/.dig/resolve-probe': { status: 204 },
      'http://127.0.0.5:80/.dig/health': {
        status: 200,
        body: { status: 'ok', version: '0.6.0', bound_port: 80, loopback_ip: '127.0.0.5', tld: 'dig', paths: { dns: true, gateway: true } },
      },
    });
    const result = await probeDigDns({ fetchImpl });
    assert.equal(result.available, true);
    assert.equal(result.boundPort, 80);
    assert.equal(result.health?.status, 'ok');
  });

  test('falls back to 8053 when port 80 does not answer (e.g. held by http.sys)', async () => {
    const fetchImpl = fakeFetch({
      'http://127.0.0.5:80/.dig/resolve-probe': new Error('ECONNREFUSED'),
      'http://127.0.0.5:8053/.dig/resolve-probe': { status: 204 },
      'http://127.0.0.5:8053/.dig/health': {
        status: 200,
        body: { status: 'ok', bound_port: 8053 },
      },
    });
    const result = await probeDigDns({ fetchImpl });
    assert.equal(result.available, true);
    assert.equal(result.boundPort, 8053);
  });

  test('unavailable when neither candidate port answers (dig-dns not installed/running)', async () => {
    const fetchImpl = fakeFetch({
      'http://127.0.0.5:80/.dig/resolve-probe': new Error('ECONNREFUSED'),
      'http://127.0.0.5:8053/.dig/resolve-probe': new Error('ECONNREFUSED'),
    });
    const result = await probeDigDns({ fetchImpl });
    assert.equal(result.available, false);
    assert.equal(result.boundPort, null);
    assert.equal(result.health, null);
  });

  test('still available (boundPort = the answering port) when resolve-probe succeeds but health fails', async () => {
    const fetchImpl = fakeFetch({
      'http://127.0.0.5:80/.dig/resolve-probe': { status: 204 },
      'http://127.0.0.5:80/.dig/health': new Error('timeout'),
    });
    const result = await probeDigDns({ fetchImpl });
    assert.equal(result.available, true);
    assert.equal(result.boundPort, 80);
    assert.equal(result.health, null);
  });

  test('a non-204 resolve-probe response is treated as not answering that port', async () => {
    const fetchImpl = fakeFetch({
      'http://127.0.0.5:80/.dig/resolve-probe': { status: 404 },
      'http://127.0.0.5:8053/.dig/resolve-probe': { status: 204 },
      'http://127.0.0.5:8053/.dig/health': { status: 200, body: { bound_port: 8053 } },
    });
    const result = await probeDigDns({ fetchImpl });
    assert.equal(result.boundPort, 8053);
  });
});

describe('isDotDigNavigationFailure', () => {
  test('true for a top-level DNS failure on a .dig host', () => {
    assert.equal(
      isDotDigNavigationFailure({ url: 'http://abc123.dig/', error: 'net::ERR_NAME_NOT_RESOLVED', frameId: 0 }),
      true,
    );
    assert.equal(
      isDotDigNavigationFailure({ url: 'http://abc123.dig/index.html', error: 'net::ERR_CONNECTION_REFUSED', frameId: 0 }),
      true,
    );
  });

  test('false for a sub-frame (frameId !== 0)', () => {
    assert.equal(
      isDotDigNavigationFailure({ url: 'http://abc123.dig/', error: 'net::ERR_NAME_NOT_RESOLVED', frameId: 1 }),
      false,
    );
  });

  test('false for a non-.dig host, even with a matching error code', () => {
    assert.equal(
      isDotDigNavigationFailure({ url: 'http://dig.local/', error: 'net::ERR_NAME_NOT_RESOLVED', frameId: 0 }),
      false,
    );
    assert.equal(
      isDotDigNavigationFailure({ url: 'https://example.com/', error: 'net::ERR_NAME_NOT_RESOLVED', frameId: 0 }),
      false,
    );
  });

  test('false for a .dig host with a non-DNS/connect error (e.g. the gateway served an HTTP error)', () => {
    assert.equal(
      isDotDigNavigationFailure({ url: 'http://abc123.dig/', error: 'net::ERR_ABORTED', frameId: 0 }),
      false,
    );
  });

  test('false for missing url/error and an unparsable url', () => {
    assert.equal(isDotDigNavigationFailure({ error: 'net::ERR_NAME_NOT_RESOLVED', frameId: 0 }), false);
    assert.equal(isDotDigNavigationFailure({ url: 'http://abc123.dig/', frameId: 0 }), false);
    assert.equal(isDotDigNavigationFailure({ url: 'not a url', error: 'net::ERR_NAME_NOT_RESOLVED', frameId: 0 }), false);
  });
});

describe('shouldRefreshDigDnsSnapshot', () => {
  test('true when there is no snapshot yet, or lastProbeAt is null', () => {
    assert.equal(shouldRefreshDigDnsSnapshot(undefined, 1_000), true);
    assert.equal(shouldRefreshDigDnsSnapshot(null, 1_000), true);
    assert.equal(shouldRefreshDigDnsSnapshot({ lastProbeAt: null }, 1_000), true);
  });

  test('false when the snapshot is fresher than the refresh window', () => {
    assert.equal(shouldRefreshDigDnsSnapshot({ lastProbeAt: 1_000 }, 1_000 + DIG_DNS_STATUS_REFRESH_MS - 1), false);
  });

  test('true once the snapshot is older than the refresh window', () => {
    assert.equal(shouldRefreshDigDnsSnapshot({ lastProbeAt: 1_000 }, 1_000 + DIG_DNS_STATUS_REFRESH_MS + 1), true);
  });

  test('respects a custom refreshMs', () => {
    assert.equal(shouldRefreshDigDnsSnapshot({ lastProbeAt: 1_000 }, 1_500, 1_000), false);
    assert.equal(shouldRefreshDigDnsSnapshot({ lastProbeAt: 1_000 }, 2_500, 1_000), true);
  });
});

describe('createDigDnsAvailabilityController', () => {
  let proxy: ReturnType<typeof fakeChromeProxy>;

  beforeEach(() => {
    proxy = fakeChromeProxy();
  });

  test('starts in phase "unknown" with no proxy engaged', () => {
    const controller = createDigDnsAvailabilityController({ chromeProxy: proxy });
    const snap = controller.getSnapshot();
    assert.equal(snap.phase, 'unknown');
    assert.equal(snap.proxyActive, false);
    assert.equal(snap.boundPort, null);
  });

  test('probe() moves to "direct" when dig-dns answers, without engaging the proxy', async () => {
    const fetchImpl = fakeFetch({
      'http://127.0.0.5:80/.dig/resolve-probe': { status: 204 },
      'http://127.0.0.5:80/.dig/health': { status: 200, body: { bound_port: 80 } },
    });
    const controller = createDigDnsAvailabilityController({ chromeProxy: proxy, fetchImpl });
    const snap = await controller.probe();
    assert.equal(snap.phase, 'direct');
    assert.equal(snap.boundPort, 80);
    assert.equal(snap.proxyActive, false);
    assert.equal(proxy.calls.length, 0);
  });

  test('probe() moves to "unavailable" when dig-dns does not answer, and clears any engaged proxy', async () => {
    const deadFetch = fakeFetch({
      'http://127.0.0.5:80/.dig/resolve-probe': new Error('refused'),
      'http://127.0.0.5:8053/.dig/resolve-probe': new Error('refused'),
    });
    const controller = createDigDnsAvailabilityController({ chromeProxy: proxy, fetchImpl: deadFetch });
    const snap = await controller.probe();
    assert.equal(snap.phase, 'unavailable');
    assert.equal(snap.proxyActive, false);
  });

  test('reportNavigationError() engages the PAC proxy when dig-dns is reachable', async () => {
    const fetchImpl = fakeFetch({
      'http://127.0.0.5:80/.dig/resolve-probe': { status: 204 },
      'http://127.0.0.5:80/.dig/health': { status: 200, body: { bound_port: 80 } },
    });
    const controller = createDigDnsAvailabilityController({ chromeProxy: proxy, fetchImpl });
    await controller.probe(); // phase: direct
    const snap = await controller.reportNavigationError();

    assert.equal(snap.phase, 'proxy');
    assert.equal(snap.proxyActive, true);
    assert.equal(snap.pacUrl, 'http://127.0.0.5:80/.dig/proxy.pac');
    assert.equal(proxy.calls.length, 1);
    assert.deepEqual(proxy.calls[0], {
      op: 'set',
      arg: { value: { mode: 'pac_script', pacScript: { url: 'http://127.0.0.5:80/.dig/proxy.pac' } }, scope: 'regular' },
    });
  });

  test('reportNavigationError() does NOT engage the proxy when dig-dns itself is unreachable', async () => {
    const deadFetch = fakeFetch({
      'http://127.0.0.5:80/.dig/resolve-probe': new Error('refused'),
      'http://127.0.0.5:8053/.dig/resolve-probe': new Error('refused'),
    });
    const controller = createDigDnsAvailabilityController({ chromeProxy: proxy, fetchImpl: deadFetch });
    const snap = await controller.reportNavigationError();

    assert.equal(snap.phase, 'unavailable');
    assert.equal(snap.proxyActive, false);
    assert.equal(proxy.calls.filter((c) => c.op === 'set').length, 0);
  });

  test('self-heals: after N consecutive healthy probes with no further nav errors, the proxy is removed', async () => {
    const fetchImpl = fakeFetch({
      'http://127.0.0.5:80/.dig/resolve-probe': { status: 204 },
      'http://127.0.0.5:80/.dig/health': { status: 200, body: { bound_port: 80 } },
    });
    const controller = createDigDnsAvailabilityController({ chromeProxy: proxy, fetchImpl, recoveryThreshold: DIG_DNS_RECOVERY_PROBE_THRESHOLD });
    await controller.probe();
    await controller.reportNavigationError(); // engage
    assert.equal(controller.getSnapshot().phase, 'proxy');
    proxy.calls.length = 0; // only count calls from here

    for (let i = 0; i < DIG_DNS_RECOVERY_PROBE_THRESHOLD - 1; i += 1) {
      const snap = await controller.probe();
      assert.equal(snap.phase, 'proxy', `still proxy after ${i + 1} healthy probe(s), below threshold`);
    }
    assert.equal(proxy.calls.some((c) => c.op === 'clear'), false);

    const finalSnap = await controller.probe();
    assert.equal(finalSnap.phase, 'direct');
    assert.equal(finalSnap.proxyActive, false);
    assert.equal(proxy.calls.some((c) => c.op === 'clear'), true);
  });

  test('a navigation error while already in "proxy" phase resets the recovery streak', async () => {
    const fetchImpl = fakeFetch({
      'http://127.0.0.5:80/.dig/resolve-probe': { status: 204 },
      'http://127.0.0.5:80/.dig/health': { status: 200, body: { bound_port: 80 } },
    });
    const controller = createDigDnsAvailabilityController({ chromeProxy: proxy, fetchImpl, recoveryThreshold: 3 });
    await controller.probe();
    await controller.reportNavigationError(); // engage, streak=0

    await controller.probe(); // streak=1
    await controller.probe(); // streak=2
    await controller.reportNavigationError(); // still broken → streak resets to 0, stays proxy
    assert.equal(controller.getSnapshot().phase, 'proxy');

    await controller.probe(); // streak=1
    await controller.probe(); // streak=2
    assert.equal(controller.getSnapshot().phase, 'proxy', 'has not reached the threshold again yet');
    await controller.probe(); // streak=3 → recovers
    assert.equal(controller.getSnapshot().phase, 'direct');
  });

  test('dispose() clears an engaged proxy and is a safe no-op otherwise', async () => {
    const fetchImpl = fakeFetch({
      'http://127.0.0.5:80/.dig/resolve-probe': { status: 204 },
      'http://127.0.0.5:80/.dig/health': { status: 200, body: { bound_port: 80 } },
    });
    const controller = createDigDnsAvailabilityController({ chromeProxy: proxy, fetchImpl });
    await controller.probe();
    await controller.reportNavigationError();
    assert.equal(controller.getSnapshot().proxyActive, true);

    await controller.dispose();
    assert.equal(proxy.calls.some((c) => c.op === 'clear'), true);

    proxy.calls.length = 0;
    await controller.dispose(); // idempotent, no throw, no redundant clear necessary either way
  });

  test('subscribe() notifies listeners of every state change and unsubscribe stops delivery', async () => {
    const fetchImpl = fakeFetch({
      'http://127.0.0.5:80/.dig/resolve-probe': { status: 204 },
      'http://127.0.0.5:80/.dig/health': { status: 200, body: { bound_port: 80 } },
    });
    const controller = createDigDnsAvailabilityController({ chromeProxy: proxy, fetchImpl });
    const seen: string[] = [];
    const unsubscribe = controller.subscribe((snap) => seen.push(snap.phase));

    await controller.probe();
    assert.ok(seen.includes('direct'));

    unsubscribe();
    seen.length = 0;
    await controller.reportNavigationError();
    assert.deepEqual(seen, []);
  });

  test('getSnapshot() returns a defensive copy (mutating it does not affect internal state)', async () => {
    const controller = createDigDnsAvailabilityController({ chromeProxy: proxy });
    const snap = controller.getSnapshot();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately mutate the copy under test
    (snap as any).phase = 'proxy';
    assert.equal(controller.getSnapshot().phase, 'unknown');
  });
});
