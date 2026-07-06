/**
 * Tests for the wallet broker (wallet-broker.mjs).
 *
 * The broker is the extension's per-origin consent gate + CHIP-0002 method router for
 * the injected `window.chia` provider (backed by WalletConnect→Sage). These pin the
 * security-critical contract that mirrors the native DIG Browser's origin gate:
 *   - unknown origins cannot call key/sign methods (must connect() first),
 *   - connect() yields 202 (pending) until the origin is approved AND a wallet session
 *     exists, then 200,
 *   - approved methods route through the WC transport and surface its result/errors.
 *
 * Run: node --test tests/
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  brokerRequest,
  isOriginApproved,
  setOriginApproval,
  CONNECTION_KEY,
} from '@/lib/wallet-broker';

// In-memory chrome.storage.local stand-in.
function memStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    async get(key: string) {
      if (typeof key === 'string') return { [key]: data[key] };
      return { ...data };
    },
    async set(obj: Record<string, unknown>) { Object.assign(data, obj); },
  };
}

const ORIGIN = 'https://dapp.example';

function transport({ connected = true, result = { foo: 1 } as unknown, throws = null as string | null }: { connected?: boolean; result?: unknown; throws?: string | null } = {}) {
  return {
    async isConnected() { return connected; },
    async request() {
      if (throws) throw new Error(throws);
      return result;
    },
  };
}

test('unknown origin cannot call a sign method (must connect first)', async () => {
  const storage = memStorage();
  const env = await brokerRequest(
    { storage, transport: transport() },
    'chip0002_signCoinSpends', {}, ORIGIN
  );
  assert.equal(env.status, 401);
  assert.match(env.body.error!, /connect/i);
});

test('connect with no consent + no requestConsent yields pending (202)', async () => {
  const storage = memStorage();
  const env = await brokerRequest(
    { storage, transport: transport() },
    'connect', {}, ORIGIN
  );
  assert.equal(env.status, 202);
  // origin still not approved (it must be approved out-of-band)
  assert.equal(await isOriginApproved(storage, ORIGIN), false);
});

test('connect approves origin via requestConsent and returns address when session live', async () => {
  const storage = memStorage({
    [CONNECTION_KEY]: { connected: true, address: 'xch1abc', network: 'mainnet' },
  });
  const env = await brokerRequest(
    {
      storage,
      transport: transport({ connected: true }),
      requestConsent: async () => true,
    },
    'chip0002_connect', {}, ORIGIN
  );
  assert.equal(env.status, 200);
  assert.equal((env.body.data as { address?: string }).address, 'xch1abc');
  assert.equal(await isOriginApproved(storage, ORIGIN), true);
});

test('connect with approved origin but no wallet session yields pending', async () => {
  const storage = memStorage();
  await setOriginApproval(storage, ORIGIN, true);
  const env = await brokerRequest(
    { storage, transport: transport({ connected: false }) },
    'chip0002_connect', {}, ORIGIN
  );
  assert.equal(env.status, 202);
});

test('approved origin: supported read method routes through transport', async () => {
  const storage = memStorage();
  await setOriginApproval(storage, ORIGIN, true);
  const env = await brokerRequest(
    { storage, transport: transport({ result: { address: 'xch1xyz' } }) },
    'chia_getAddress', {}, ORIGIN
  );
  assert.equal(env.status, 200);
  assert.deepEqual(env.body.data, { address: 'xch1xyz' });
});

test('approved origin: unsupported method is rejected 404', async () => {
  const storage = memStorage();
  await setOriginApproval(storage, ORIGIN, true);
  const env = await brokerRequest(
    { storage, transport: transport() },
    'chia_dropAllFunds', {}, ORIGIN
  );
  assert.equal(env.status, 404);
});

test('approved origin: transport error surfaces as 502', async () => {
  const storage = memStorage();
  await setOriginApproval(storage, ORIGIN, true);
  const env = await brokerRequest(
    { storage, transport: transport({ throws: 'user rejected' }) },
    'chip0002_signCoinSpends', {}, ORIGIN
  );
  assert.equal(env.status, 502);
  assert.match(env.body.error!, /rejected/i);
});

test('approved origin: no wallet session yields 503 for non-connect methods', async () => {
  const storage = memStorage();
  await setOriginApproval(storage, ORIGIN, true);
  const env = await brokerRequest(
    { storage, transport: transport({ connected: false }) },
    'chip0002_getPublicKeys', {}, ORIGIN
  );
  assert.equal(env.status, 503);
});

test('missing origin is rejected', async () => {
  const storage = memStorage();
  const env = await brokerRequest({ storage, transport: transport() }, 'connect', {}, '');
  assert.equal(env.status, 400);
});

test('setOriginApproval(false) revokes access', async () => {
  const storage = memStorage();
  await setOriginApproval(storage, ORIGIN, true);
  assert.equal(await isOriginApproved(storage, ORIGIN), true);
  await setOriginApproval(storage, ORIGIN, false);
  assert.equal(await isOriginApproved(storage, ORIGIN), false);
});
