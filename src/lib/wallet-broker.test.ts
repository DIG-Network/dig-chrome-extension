/**
 * Tests for the wallet consent + permissions store (wallet-broker.ts).
 *
 * The extension is a self-custody wallet (dApp requests are served by the offscreen vault via
 * dapp-approval.ts); this module owns the shared per-origin consent map + the EIP-2255-shaped
 * connected-sites permission surface. These pin that contract:
 *   - approving/revoking an origin is durable + revocable,
 *   - connected sites list with stable grantedAt + lastUsed bookkeeping,
 *   - the permission methods read/clear the shared consent store.
 *
 * Run: node --test tests/
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  isOriginApproved,
  setOriginApproval,
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
