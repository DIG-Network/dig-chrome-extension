/**
 * Anchored-root cross-check (#2526) — who may establish the root a chia:// read is verified against.
 *
 * Property under test: a serving endpoint that answers `dig.getAnchoredRoot` with a FABRICATED root,
 * and serves content whose inclusion proof folds to that fabricated root, must NOT produce
 * `verified: true`. The nearest wrong implementation is the pre-#2526 behaviour — ask the endpoint
 * first, consult the independent chain source only when the endpoint FAILS — which, faced with an
 * endpoint that answers successfully (and dishonestly), never consults the chain at all.
 *
 * Fixture design notes (the reason each choice is what it is):
 *  - The spoof test asserts on the SURFACED verdict, by running the real pipeline the background
 *    service worker runs — the cross-check, then the real `resolveReadRoots`, then the real
 *    `verifyAndDecrypt`. A policy-only assertion would be blind to the pipeline still marking the
 *    content verified through some other route. (`src/background/index.ts` itself cannot be imported
 *    under vitest — heavy top-level SW side effects — which is why #2276 extracted verified-content.ts
 *    and why this module exists in the same shape.)
 *  - The crypto double's `verifyInclusion` returns true for the FAKE root and false for the honest one.
 *    That is the attacker's actual capability, and it is what makes the fixture able to EXPRESS the
 *    attack: under the old policy the fake root becomes the trusted root and the proof folds to it, so
 *    the read really would come back verified. A double that rejected every proof would make the test
 *    pass for a reason unrelated to the fix.
 *  - Decryption always SUCCEEDS, so a refusal can never be attributed to a decrypt failure.
 *  - The honest control keeps a truthful actor in the fixture: an endpoint AGREEING with the chain must
 *    still yield `verified: true`, which the nearest wrong "never trust anything" implementation fails.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  decideAnchoredRoot,
  resolveCrossCheckedAnchoredRoot,
  resolveTrustedAnchoredRoot,
  type AnchoredRootSources,
} from './anchored-root';
import { resolveReadRoots } from './trusted-root';
import { verifyAndDecrypt, type ContentCrypto } from './verified-content';

/** The store's REAL chain-anchored tip, as the independent coinset lineage walk reports it. */
const HONEST_ROOT = 'a'.repeat(64);
/** The root a hostile serving endpoint claims, and which its substituted content's proof folds to. */
const FAKE_ROOT = 'b'.repeat(64);

const ATTACKER_BYTES = new TextEncoder().encode('<html>attacker-substituted content</html>');
const CIPHERTEXT = new Uint8Array([1, 2, 3, 4]);

/**
 * A crypto double with the attacker's capability: it can produce a proof that folds to `foldsTo` (the
 * fabricated root) and to nothing else, and it can always decrypt.
 */
function makeAttackerCrypto(foldsTo: string): ContentCrypto {
  return {
    verifyInclusion: vi.fn((_ct: Uint8Array, _proof: unknown, trustedRoot: string) => trustedRoot === foldsTo),
    deriveKey: vi.fn(() => 'deadbeef'.repeat(8)),
    decryptChunk: vi.fn(() => ATTACKER_BYTES),
  };
}

/** The sources a read sees: an endpoint claim and an independent chain answer (either may be absent). */
const sources = (endpoint: string | null, chain: string | null): AnchoredRootSources => ({
  fromEndpoint: async () => endpoint,
  fromChain: async () => chain,
});

/**
 * Run the read pipeline exactly as `fetchContentViaRPC` does for a ROOTLESS urn: cross-check the
 * anchored root, decide the read roots, then verify + decrypt. Returns the surfaced verdict, or the
 * refusal, so a test can assert on what the caller actually observes.
 */
async function readRootlessUrn(
  src: AnchoredRootSources,
  dig: ContentCrypto,
): Promise<{ verified: boolean; bytes: Uint8Array } | { refused: string }> {
  const { root } = await resolveCrossCheckedAnchoredRoot(src);
  const { trustedRoot } = resolveReadRoots(null, root);
  try {
    return verifyAndDecrypt({
      dig,
      ciphertext: CIPHERTEXT,
      proof: { some: 'proof' },
      chunkLens: null,
      trustedRoot,
      storeId: 'store-1',
      resourceKey: 'index.html',
      salt: null,
    });
  } catch (e) {
    return { refused: (e as Error).message };
  }
}

describe('hostile serving endpoint cannot fabricate the anchored root (#2526)', () => {
  it('does NOT report verified when the endpoint claims a fake root its own content proof folds to', async () => {
    const result = await readRootlessUrn(
      sources(FAKE_ROOT, HONEST_ROOT),
      makeAttackerCrypto(FAKE_ROOT),
    );

    expect(result).not.toHaveProperty('verified', true);
    // The chain root IS available here, so the fail-closed gate (#2276) applies: the attacker bytes are
    // refused outright rather than served with an advisory badge.
    expect(result).toEqual({ refused: expect.stringMatching(/inclusion proof failed/i) });
  });

  it('still reports verified when the endpoint agrees with the independent chain source', async () => {
    const result = await readRootlessUrn(
      sources(HONEST_ROOT, HONEST_ROOT),
      makeAttackerCrypto(HONEST_ROOT), // an honest host: its proof folds to the real root
    );

    expect(result).toEqual({ verified: true, bytes: ATTACKER_BYTES });
  });

  it('reports verified when only the chain source answers (endpoint silent, e.g. rpc.dig.net -32601)', async () => {
    const result = await readRootlessUrn(sources(null, HONEST_ROOT), makeAttackerCrypto(HONEST_ROOT));

    expect(result).toEqual({ verified: true, bytes: ATTACKER_BYTES });
  });

  it('degrades to the ADVISORY blind path — not a refusal — when the chain source is unavailable', async () => {
    // The endpoint answers, but nothing independent can corroborate it. Content must still LOAD
    // (unverified badge); an outage must never trap the user, and must never confer trust either.
    const result = await readRootlessUrn(sources(FAKE_ROOT, null), makeAttackerCrypto(FAKE_ROOT));

    expect(result).toEqual({ verified: false, bytes: ATTACKER_BYTES });
  });
});

describe('resolveTrustedAnchoredRoot — the read-path wiring', () => {
  /** A raw `dig.getAnchoredRoot` JSON-RPC result, as `rpcCall` returns it. */
  const rpcResult = (root: string) => ({ root });

  it('lets the coinset walk establish the root while the endpoint only corroborates', async () => {
    // Load-bearing: the two wirings are SHAPE-asymmetric (raw RPC object vs extracted root string),
    // so swapping them resolves nothing at all rather than silently restoring endpoint-first trust.
    await expect(resolveTrustedAnchoredRoot('store-1', {
      askEndpoint: async () => rpcResult(HONEST_ROOT),
      walkChain: async () => HONEST_ROOT,
    })).resolves.toBe(HONEST_ROOT);

    await expect(resolveTrustedAnchoredRoot('store-1', {
      askEndpoint: async () => rpcResult(FAKE_ROOT),
      walkChain: async () => null,
    })).resolves.toBeNull();
  });

  it('passes the store id to BOTH sources and reports a disagreement to onMismatch', async () => {
    const askEndpoint = vi.fn(async () => rpcResult(FAKE_ROOT));
    const walkChain = vi.fn(async () => HONEST_ROOT);
    const onMismatch = vi.fn();

    await expect(resolveTrustedAnchoredRoot('store-7', { askEndpoint, walkChain, onMismatch }))
      .resolves.toBe(HONEST_ROOT);

    expect(askEndpoint).toHaveBeenCalledWith('store-7');
    expect(walkChain).toHaveBeenCalledWith('store-7');
    expect(onMismatch).toHaveBeenCalledWith('store-7');
  });

  it('ignores a malformed endpoint result instead of throwing on it', async () => {
    for (const bogus of [null, undefined, 'a-bare-string', { root: 42 }, {}]) {
      await expect(resolveTrustedAnchoredRoot('store-1', {
        askEndpoint: async () => bogus,
        walkChain: async () => HONEST_ROOT,
      })).resolves.toBe(HONEST_ROOT);
    }
  });
});

/**
 * The service worker (`src/background/index.ts`) carries a justified `// @ts-nocheck` and heavy
 * top-level side effects, so it cannot be imported or type-checked — which leaves its one remaining
 * security-critical decision, WHICH concrete lookup is wired to WHICH role, asserted nowhere. Swapping
 * the two would restore the pre-#2526 vulnerability in full while every behavioural test still passed.
 * This reads the source text to pin that binding; it is the only instrument the file's shape allows.
 */
describe('background service-worker wiring (source-level guard)', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/background/index.ts'), 'utf8');
  const wiring = source.slice(source.indexOf('return resolveTrustedAnchoredRoot(storeId, {'));

  it('is present — the guard fails loudly if the call site is renamed or removed', () => {
    expect(wiring).not.toBe('');
    expect(wiring).toContain('askEndpoint:');
    expect(wiring).toContain('walkChain:');
  });

  it('wires the UNTRUSTED serving endpoint to askEndpoint (corroboration only)', () => {
    expect(/askEndpoint:[^\n]*rpcCall\([^\n]*dig\.getAnchoredRoot/.test(wiring)).toBe(true);
  });

  it('wires the INDEPENDENT coinset walk to walkChain (the only source that may establish trust)', () => {
    expect(/walkChain:[^\n]*resolveAnchoredRootFromCoinset\(/.test(wiring)).toBe(true);
  });
});

describe('decideAnchoredRoot', () => {
  it('never lets the endpoint alone establish a root', () => {
    expect(decideAnchoredRoot(FAKE_ROOT, null)).toEqual({ root: null, trust: 'unconfirmed' });
    expect(decideAnchoredRoot(FAKE_ROOT, 'not-a-root')).toEqual({ root: null, trust: 'unconfirmed' });
  });

  it('takes the chain root and records whether the endpoint corroborated it', () => {
    expect(decideAnchoredRoot(HONEST_ROOT, HONEST_ROOT)).toEqual({ root: HONEST_ROOT, trust: 'confirmed' });
    expect(decideAnchoredRoot(null, HONEST_ROOT)).toEqual({ root: HONEST_ROOT, trust: 'chain-only' });
    expect(decideAnchoredRoot(FAKE_ROOT, HONEST_ROOT)).toEqual({ root: HONEST_ROOT, trust: 'mismatch' });
  });

  it('normalizes 0x-prefixed and upper-case roots on both sides before comparing', () => {
    expect(decideAnchoredRoot(`0x${HONEST_ROOT.toUpperCase()}`, HONEST_ROOT)).toEqual({
      root: HONEST_ROOT,
      trust: 'confirmed',
    });
  });
});

describe('resolveCrossCheckedAnchoredRoot', () => {
  it('treats a throwing source as an absent answer rather than failing the read', async () => {
    const decision = await resolveCrossCheckedAnchoredRoot({
      fromEndpoint: async () => { throw new Error('node unreachable'); },
      fromChain: async () => HONEST_ROOT,
    });
    expect(decision).toEqual({ root: HONEST_ROOT, trust: 'chain-only' });

    const blind = await resolveCrossCheckedAnchoredRoot({
      fromEndpoint: async () => HONEST_ROOT,
      fromChain: async () => { throw new Error('coinset unreachable'); },
    });
    expect(blind).toEqual({ root: null, trust: 'unconfirmed' });
  });

  it('treats a source that throws SYNCHRONOUSLY as an absent answer, not a hard failure', async () => {
    // `f().catch(...)` catches only a REJECTION. A source that throws before it returns a promise
    // would escape the resolver entirely and turn an advisory read into a thrown error, breaking the
    // "non-throwing throughout" contract the read path documents.
    const throwsSync = (): Promise<string | null> => { throw new Error('offscreen document gone'); };

    await expect(
      resolveCrossCheckedAnchoredRoot({ fromEndpoint: throwsSync, fromChain: async () => HONEST_ROOT }),
    ).resolves.toEqual({ root: HONEST_ROOT, trust: 'chain-only' });

    await expect(
      resolveCrossCheckedAnchoredRoot({ fromEndpoint: async () => HONEST_ROOT, fromChain: throwsSync }),
    ).resolves.toEqual({ root: null, trust: 'unconfirmed' });
  });

  it('queries both sources concurrently — the chain walk is not gated on the endpoint answering', async () => {
    // The pre-#2526 policy short-circuited: a successful endpoint answer meant the chain was never
    // consulted. This asserts the chain source is ALWAYS consulted, which is what makes the spoof
    // detectable at all.
    const fromChain = vi.fn(async () => HONEST_ROOT);
    await resolveCrossCheckedAnchoredRoot({ fromEndpoint: async () => FAKE_ROOT, fromChain });
    expect(fromChain).toHaveBeenCalledTimes(1);
  });
});
