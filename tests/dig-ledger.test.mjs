/**
 * Tests for the per-capsule inclusion-proof LEDGER (dig-ledger.mjs) — the pure model
 * behind the extension's DIG Shields per-resource proof list.
 *
 * This is a BYTE-MIRROR of the native DIG Browser's dig/shields/dig_ledger.mjs (#134),
 * so these tests mirror the browser's dig_ledger.test.mjs verbatim. The entry shape, the
 * capsule key, the grouping, and the two #134 display models MUST stay identical across the
 * browser, this extension, and the native C++ LedgerStore (SYSTEM.md "align UX across
 * modules"). Change all of them in lockstep.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  capsuleKey,
  LedgerStore,
  groupLedger,
  inclusionProofDisplay,
  executionProofDisplay,
} from '../dig-ledger.mjs';

const STORE = '1426d9064bb59353e2ad3845c1d250af1f75476a6d4d85f2c4d6b90696359907';
const ROOT = 'cc77916250e587e9d39d9fca59afdaf1bce89aa26c4d56249b2c14406dda8e4e';

test('capsuleKey is the canonical storeId:rootHash (lowercased)', () => {
  assert.equal(capsuleKey(STORE, ROOT), STORE + ':' + ROOT);
  assert.equal(capsuleKey(STORE.toUpperCase(), ROOT.toUpperCase()), STORE + ':' + ROOT);
  // A rootless capsule (root resolved to "latest" / unknown) still keys cleanly.
  assert.equal(capsuleKey(STORE, ''), STORE + ':latest');
  assert.equal(capsuleKey(STORE, 'latest'), STORE + ':latest');
});

test('LedgerStore.record accumulates per-capsule entries keyed by storeId:rootHash', () => {
  const store = new LedgerStore();
  store.record({ storeId: STORE, rootHash: ROOT, resourcePath: 'index.html', inclusionProofPassed: true });
  store.record({ storeId: STORE, rootHash: ROOT, resourcePath: 'app.js', inclusionProofPassed: true });
  const entries = store.entriesFor(STORE, ROOT);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.resourcePath), ['index.html', 'app.js']);
  // A different capsule is a separate ledger.
  assert.equal(store.entriesFor(STORE, 'deadbeef').length, 0);
});

test("LedgerStore.record normalizes resourcePath (leading slash dropped, empty/'/' → index.html)", () => {
  const store = new LedgerStore();
  store.record({ storeId: STORE, rootHash: ROOT, resourcePath: '/style.css', inclusionProofPassed: true });
  store.record({ storeId: STORE, rootHash: ROOT, resourcePath: '', inclusionProofPassed: true });
  // A bare "/" normalizes to the SAME default-view key as "" → it updates, not duplicates.
  store.record({ storeId: STORE, rootHash: ROOT, resourcePath: '/', inclusionProofPassed: true });
  const paths = store.entriesFor(STORE, ROOT).map((e) => e.resourcePath);
  assert.deepEqual(paths, ['style.css', 'index.html']);
});

test('LedgerStore.record is idempotent per resourcePath — re-fetch UPDATES, never duplicates', () => {
  const store = new LedgerStore();
  store.record({ storeId: STORE, rootHash: ROOT, resourcePath: 'app.js', inclusionProofPassed: false, errorCode: 'DIG_ERR_PROOF_MISMATCH' });
  // Same resource re-served (e.g. retry succeeds) → the latest verdict wins, one entry.
  store.record({ storeId: STORE, rootHash: ROOT, resourcePath: 'app.js', inclusionProofPassed: true });
  const entries = store.entriesFor(STORE, ROOT);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].inclusionProofPassed, true);
  assert.equal(entries[0].errorCode, '');
});

test('LedgerStore caps per-capsule entries (bounds memory) keeping the most recent', () => {
  const store = new LedgerStore({ maxEntries: 3 });
  for (let i = 0; i < 5; i++) {
    store.record({ storeId: STORE, rootHash: ROOT, resourcePath: 'r' + i + '.js', inclusionProofPassed: true });
  }
  const entries = store.entriesFor(STORE, ROOT);
  assert.equal(entries.length, 3);
  // Oldest (r0, r1) evicted; the most recent three remain in order.
  assert.deepEqual(entries.map((e) => e.resourcePath), ['r2.js', 'r3.js', 'r4.js']);
});

test('groupLedger splits PASSED vs FAILED and counts each', () => {
  const entries = [
    { resourcePath: 'index.html', inclusionProofPassed: true, errorCode: '' },
    { resourcePath: 'app.js', inclusionProofPassed: true, errorCode: '' },
    { resourcePath: 'evil.js', inclusionProofPassed: false, errorCode: 'DIG_ERR_PROOF_MISMATCH' },
    { resourcePath: 'missing.png', inclusionProofPassed: false, errorCode: 'DIG_ERR_NOT_FOUND' },
  ];
  const g = groupLedger(entries);
  assert.equal(g.passedCount, 2);
  assert.equal(g.failedCount, 2);
  assert.deepEqual(g.passed.map((e) => e.resourcePath), ['index.html', 'app.js']);
  assert.deepEqual(g.failed.map((e) => e.resourcePath), ['evil.js', 'missing.png']);
  // The aggregate verdict is true only when there are entries and NONE failed.
  assert.equal(g.allPassed, false);
  assert.equal(g.total, 4);
  assert.equal(g.empty, false);
});

test('groupLedger: all-passed and empty states are distinguishable', () => {
  const allPass = groupLedger([
    { resourcePath: 'index.html', inclusionProofPassed: true, errorCode: '' },
  ]);
  assert.equal(allPass.allPassed, true);
  assert.equal(allPass.empty, false);
  assert.equal(allPass.failedCount, 0);

  const none = groupLedger([]);
  assert.equal(none.empty, true);
  assert.equal(none.allPassed, false, "no entries is NOT 'all passed' — nothing was verified yet");
  assert.equal(none.passedCount, 0);
  assert.equal(none.failedCount, 0);

  // Defensive: a non-array argument is treated as empty.
  assert.equal(groupLedger(null).empty, true);
  assert.equal(groupLedger(undefined).empty, true);
});

test('groupLedger does not mutate its input and tolerates missing fields', () => {
  const entries = [{ resourcePath: 'x.js' }]; // no inclusionProofPassed → treated as failed (fail-closed)
  const g = groupLedger(entries);
  assert.equal(g.failedCount, 1, 'an entry without a positive pass verdict counts as failed (fail-closed)');
  assert.equal(g.passedCount, 0);
  assert.equal(entries.length, 1, 'input untouched');
});

// ---- #134: per-resource INCLUSION-PROOF detail (root + verified-against-root) --

test('inclusionProofDisplay: a passed entry is verified against its on-chain proof root', () => {
  const d = inclusionProofDisplay({ inclusionProofPassed: true, rootHash: ROOT, storeId: STORE });
  assert.equal(d.verified, true);
  assert.equal(d.proofRoot, ROOT, 'surfaces the capsule root the leaf was proven against');
  assert.equal(d.hasRoot, true);
  assert.match(d.label, /verified/i);
});

test('inclusionProofDisplay: a failed entry is NOT verified (fail-closed) and carries its error code', () => {
  const d = inclusionProofDisplay({
    inclusionProofPassed: false,
    rootHash: ROOT,
    errorCode: 'DIG_ERR_PROOF_MISMATCH',
  });
  assert.equal(d.verified, false);
  assert.equal(d.errorCode, 'DIG_ERR_PROOF_MISMATCH');
  assert.equal(d.proofRoot, ROOT);
});

test("inclusionProofDisplay: a rootless entry surfaces 'latest' and is honest that no pinned root is shown", () => {
  const d = inclusionProofDisplay({ inclusionProofPassed: true, rootHash: '' });
  assert.equal(d.hasRoot, false);
  assert.equal(d.proofRoot, 'latest');
});

// ---- #134: per-resource EXECUTION-PROOF status — HONEST about mock/absent ------

test('executionProofDisplay: a REAL succeeded receipt is the only state shown as verified', () => {
  for (const s of ['succeeded', 'verified']) {
    const d = executionProofDisplay({ executionProofStatus: s });
    assert.equal(d.verified, true, `'${s}' is a real verified execution proof`);
    assert.equal(d.state, 'verified');
    assert.match(d.label, /execution proof.*verified/i);
  }
});

test('executionProofDisplay: a MOCK proof is NEVER green-checked (honesty rule)', () => {
  const d = executionProofDisplay({ executionProofStatus: 'mock' });
  assert.equal(d.verified, false, 'a mock execution proof must NEVER show as verified');
  assert.equal(d.state, 'mock');
  assert.match(d.label, /mock|not a real|not verified/i);
  assert.doesNotMatch(d.label, /^execution proof: verified$/i);
});

test('executionProofDisplay: pending states (running/queued/control-plane) are honest, not verified', () => {
  for (const s of ['running', 'queued', 'request_via_control_plane']) {
    const d = executionProofDisplay({ executionProofStatus: s });
    assert.equal(d.verified, false, `'${s}' is not (yet) a verified proof`);
    assert.equal(d.state, 'pending');
    assert.match(d.label, /pending|not yet|requested|progress/i);
  }
});

test("executionProofDisplay: failed/not_found are an honest 'not provided', never verified", () => {
  for (const s of ['failed', 'not_found']) {
    const d = executionProofDisplay({ executionProofStatus: s });
    assert.equal(d.verified, false);
    assert.equal(d.state, 'absent');
  }
});

test('executionProofDisplay: ABSENT/UNKNOWN is the honest default when the loader provided nothing', () => {
  // The extension read path fetches dig.getContent (inclusion only); it does NOT call
  // dig.getProof, so today there is NO execution-proof field. The default must be an
  // honest 'not provided / unknown' — NEVER a green check.
  for (const e of [{}, { executionProofStatus: '' }, { executionProofStatus: undefined }, null]) {
    const d = executionProofDisplay(e);
    assert.equal(d.verified, false, 'absent execution proof is NEVER verified');
    assert.equal(d.state, 'unknown');
    assert.match(d.label, /not provided|unknown|none/i);
  }
});
