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

// ── Granular revocable permissions + Connected-sites (#67 P0-4, EIP-2255-shaped) ──
import {
  toPermission,
  listPermissions,
  grantOrigin,
  noteOriginUsage,
  revokeOrigin,
  revokeAllOrigins,
  isPermissionMethod,
  handlePermissionMethod,
} from '@/lib/wallet-broker';

test('toPermission: a legacy boolean record { approved, ts } still reads as a connected permission', () => {
  const perm = toPermission(ORIGIN, { approved: true, ts: 1000 });
  assert.equal(perm?.approved, true);
  assert.equal(perm?.grantedAt, 1000);
  assert.deepEqual(perm?.addresses, []);
  assert.deepEqual(perm?.methods, []);
  assert.equal(perm?.lastUsed, null);
});

test('toPermission: an unapproved / missing record is not a permission', () => {
  assert.equal(toPermission(ORIGIN, undefined), null);
  assert.equal(toPermission(ORIGIN, { approved: false, ts: 1 }), null);
});

test('grantOrigin records addresses + methods and preserves grantedAt across re-grants', async () => {
  const storage = memStorage();
  await grantOrigin(storage, ORIGIN, { addresses: ['xch1a'], methods: ['chia_connect'] });
  const first = (await listPermissions(storage))[0];
  assert.equal(first.approved, true);
  assert.deepEqual(first.addresses, ['xch1a']);
  await grantOrigin(storage, ORIGIN, { addresses: ['xch1a', 'xch1b'], methods: ['chip0002_signCoinSpends'] });
  const again = (await listPermissions(storage))[0];
  assert.deepEqual(again.addresses, ['xch1a', 'xch1b']);
  assert.deepEqual(again.methods, ['chia_connect', 'chip0002_signCoinSpends']);
  assert.equal(again.grantedAt, first.grantedAt); // grantedAt is stable across re-grants
});

test('noteOriginUsage sets lastUsed + records the method (only for an approved origin)', async () => {
  const storage = memStorage();
  await noteOriginUsage(storage, ORIGIN, { method: 'chip0002_getPublicKeys' }); // not approved → no-op
  assert.deepEqual(await listPermissions(storage), []);
  await grantOrigin(storage, ORIGIN, {});
  await noteOriginUsage(storage, ORIGIN, { method: 'chip0002_getPublicKeys', address: 'xch1z' });
  const perm = (await listPermissions(storage))[0];
  assert.ok(perm.lastUsed && perm.lastUsed > 0);
  assert.deepEqual(perm.methods, ['chip0002_getPublicKeys']);
  assert.deepEqual(perm.addresses, ['xch1z']);
});

test('listPermissions returns every connected origin; revokeOrigin removes exactly one', async () => {
  const storage = memStorage();
  await grantOrigin(storage, 'https://a.example', {});
  await grantOrigin(storage, 'https://b.example', {});
  assert.equal((await listPermissions(storage)).length, 2);
  await revokeOrigin(storage, 'https://a.example');
  const left = await listPermissions(storage);
  assert.equal(left.length, 1);
  assert.equal(left[0].origin, 'https://b.example');
  assert.equal(await isOriginApproved(storage, 'https://a.example'), false); // consent cleared
});

test('revokeAllOrigins clears every connected site', async () => {
  const storage = memStorage();
  await grantOrigin(storage, 'https://a.example', {});
  await grantOrigin(storage, 'https://b.example', {});
  await revokeAllOrigins(storage);
  assert.deepEqual(await listPermissions(storage), []);
});

test('isPermissionMethod recognizes the EIP-2255-shaped methods (raw AND normalized wire form)', () => {
  assert.equal(isPermissionMethod('wallet_getPermissions'), true);
  assert.equal(isPermissionMethod('wallet_revokePermissions'), true);
  // The provider's normalizeMethod namespaces bare methods to chip0002_<name>; the SW must still match.
  assert.equal(isPermissionMethod('chip0002_wallet_getPermissions'), true);
  assert.equal(isPermissionMethod('chip0002_wallet_revokePermissions'), true);
  assert.equal(isPermissionMethod('chip0002_signCoinSpends'), false);
  assert.equal(isPermissionMethod('connect'), false);
});

test('handlePermissionMethod handles the normalized (chip0002_-prefixed) wire form', async () => {
  const storage = memStorage();
  await grantOrigin(storage, ORIGIN, { addresses: ['xch1a'] });
  const got = await handlePermissionMethod(storage, 'chip0002_wallet_getPermissions', ORIGIN);
  assert.equal(got.status, 200);
  assert.equal((got.body.data as unknown[]).length, 1);
  const rev = await handlePermissionMethod(storage, 'chip0002_wallet_revokePermissions', ORIGIN);
  assert.equal(rev.status, 200);
  assert.equal(await isOriginApproved(storage, ORIGIN), false);
});

test('handlePermissionMethod: getPermissions returns an EIP-2255 array (empty when none)', async () => {
  const storage = memStorage();
  const none = await handlePermissionMethod(storage, 'wallet_getPermissions', ORIGIN);
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.data, []);
  await grantOrigin(storage, ORIGIN, { addresses: ['xch1a'] });
  const got = await handlePermissionMethod(storage, 'wallet_getPermissions', ORIGIN);
  const perms = got.body.data as Array<{ invoker: string; parentCapability: string; caveats: unknown[] }>;
  assert.equal(perms.length, 1);
  assert.equal(perms[0].invoker, ORIGIN);
  assert.ok(Array.isArray(perms[0].caveats));
});

test('handlePermissionMethod: revokePermissions clears the origin and a re-read is empty', async () => {
  const storage = memStorage();
  await grantOrigin(storage, ORIGIN, { addresses: ['xch1a'] });
  const rev = await handlePermissionMethod(storage, 'wallet_revokePermissions', ORIGIN);
  assert.equal(rev.status, 200);
  assert.equal(await isOriginApproved(storage, ORIGIN), false);
  const after = await handlePermissionMethod(storage, 'wallet_getPermissions', ORIGIN);
  assert.deepEqual(after.body.data, []);
});

test('handlePermissionMethod: missing origin is rejected', async () => {
  const storage = memStorage();
  const env = await handlePermissionMethod(storage, 'wallet_getPermissions', '');
  assert.equal(env.status, 400);
});
