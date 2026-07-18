import { describe, it, expect } from 'vitest';
import {
  canonicalFrameBytes,
  buildAuth,
  bytesToBase64,
  base64ToBytes,
  NonceCounter,
  webCryptoHmacSha256,
  type HmacSha256,
} from './auth-frame';

const dec = new TextDecoder();

describe('canonicalFrameBytes (§5.6.3 framing)', () => {
  it('lays out nonce ‖ 0x00 ‖ method ‖ 0x00 ‖ canonical_json(params)', () => {
    const bytes = canonicalFrameBytes(7, 'sign.request', { b: 1, a: 2 });
    // Two NUL separators split the three fields.
    const nul1 = bytes.indexOf(0x00);
    const nul2 = bytes.indexOf(0x00, nul1 + 1);
    expect(dec.decode(bytes.slice(0, nul1))).toBe('7');
    expect(dec.decode(bytes.slice(nul1 + 1, nul2))).toBe('sign.request');
    // params canonicalized (keys sorted, no whitespace).
    expect(dec.decode(bytes.slice(nul2 + 1))).toBe('{"a":2,"b":1}');
  });

  it('binds params byte-exactly — reordered keys produce identical frames, changed values differ', () => {
    const a = canonicalFrameBytes(1, 'm', { x: 1, y: 2 });
    const b = canonicalFrameBytes(1, 'm', { y: 2, x: 1 });
    expect(dec.decode(a)).toBe(dec.decode(b));
    const c = canonicalFrameBytes(1, 'm', { x: 1, y: 3 });
    expect(dec.decode(a)).not.toBe(dec.decode(c));
  });
});

describe('base64 round-trip', () => {
  it('encodes and decodes bytes losslessly', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});

describe('NonceCounter (strict monotonicity)', () => {
  it('returns strictly increasing values from a fresh counter', () => {
    const n = new NonceCounter();
    expect(n.next()).toBe(1);
    expect(n.next()).toBe(2);
    expect(n.value).toBe(2);
  });

  it('resumes strictly above a persisted seed (survives SW restart)', () => {
    const n = new NonceCounter(41);
    expect(n.next()).toBe(42);
  });
});

describe('buildAuth', () => {
  // A deterministic fake HMAC = concat(key, message) so the test asserts the exact inputs the MAC
  // is computed over, without depending on a crypto backend.
  const fakeHmac: HmacSha256 = async (key, message) => new Uint8Array([...key, ...message]);

  it('produces an auth object binding pairing_id, nonce, and the framed MAC', async () => {
    const channelSecret = new Uint8Array([9, 9]);
    const auth = await buildAuth(
      { pairingId: 'pid-1', channelSecret, nonce: 3, method: 'connect.request', params: { origin: 'https://x' } },
      fakeHmac,
    );
    expect(auth.pairing_id).toBe('pid-1');
    expect(auth.nonce).toBe(3);
    const macBytes = base64ToBytes(auth.mac_b64);
    // fake mac = key ‖ frame; strip the 2-byte key to recover the frame the MAC covered.
    const frame = macBytes.slice(channelSecret.length);
    expect(frame).toEqual(canonicalFrameBytes(3, 'connect.request', { origin: 'https://x' }));
  });

  it('changes the MAC when the nonce changes (replay of a captured MAC fails)', async () => {
    const channelSecret = new Uint8Array([1]);
    const a = await buildAuth({ pairingId: 'p', channelSecret, nonce: 1, method: 'm', params: {} }, fakeHmac);
    const b = await buildAuth({ pairingId: 'p', channelSecret, nonce: 2, method: 'm', params: {} }, fakeHmac);
    expect(a.mac_b64).not.toBe(b.mac_b64);
  });
});

describe('webCryptoHmacSha256 (real primitive)', () => {
  it('computes a 32-byte HMAC-SHA256 that verifies against WebCrypto', async () => {
    const key = new Uint8Array([1, 2, 3, 4]);
    const msg = new TextEncoder().encode('hello');
    const mac = await webCryptoHmacSha256(key, msg);
    expect(mac.length).toBe(32);
    // Independently verify with SubtleCrypto.verify.
    const cryptoKey = await globalThis.crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    expect(await globalThis.crypto.subtle.verify('HMAC', cryptoKey, mac as BufferSource, msg as BufferSource)).toBe(true);
  });
});
