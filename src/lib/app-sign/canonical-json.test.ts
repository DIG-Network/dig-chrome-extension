import { describe, it, expect } from 'vitest';
import { canonicalJson } from './canonical-json';

describe('canonicalJson (APP-SIGN auth-HMAC wire contract)', () => {
  it('sorts object keys ascending regardless of input order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    // The SAME logical value from a different key order yields the SAME bytes.
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }));
  });

  it('emits no insignificant whitespace', () => {
    expect(canonicalJson({ origin: 'https://x', n: [2, 3] })).toBe('{"n":[2,3],"origin":"https://x"}');
  });

  it('serializes the primitives on the wire', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(0)).toBe('0');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson('hi')).toBe('"hi"');
  });

  it('sorts nested object keys recursively', () => {
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: [{ q: 1, p: 2 }] })).toBe('{"a":[{"p":2,"q":1}],"z":{"x":2,"y":1}}');
  });

  it('omits undefined-valued object entries (Rust Option::None parity)', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson({ dapp_name: undefined, origin: 'https://x' })).toBe('{"origin":"https://x"}');
  });

  it('escapes strings the same way JSON does', () => {
    expect(canonicalJson('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(canonicalJson('tab\tend')).toBe('"tab\\tend"');
  });

  it('serializes arrays in order without whitespace', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson([])).toBe('[]');
  });

  it('rejects a non-finite number rather than emitting null', () => {
    expect(() => canonicalJson(NaN)).toThrow(RangeError);
    expect(() => canonicalJson(Infinity)).toThrow(RangeError);
  });

  it('sorts keys by Unicode CODEPOINT, not UTF-16 code unit (dig-app / Rust parity KAT)', () => {
    // A supplementary-plane char (codepoint 0x1F600 = 128512) is a UTF-16 surrogate PAIR whose LEAD
    // unit is 0xD83D (55357). A BMP key at U+E000 (57344) sorts BEFORE it by CODEPOINT, but AFTER it
    // by UTF-16 code unit (55357 < 57344). This KAT locks codepoint (= UTF-8 byte / Rust str) order.
    const supplementary = String.fromCodePoint(0x1f600);
    const bmp = String.fromCodePoint(0xe000);
    const out = canonicalJson({ [supplementary]: 1, [bmp]: 2 });
    // Codepoint order: bmp (57344) < supplementary (128512) → the bmp key serializes first.
    expect(out).toBe(`{${JSON.stringify(bmp)}:2,${JSON.stringify(supplementary)}:1}`);
    // Prove this is NOT JS's default UTF-16 order, which would place the supplementary key first.
    expect([supplementary, bmp].sort()[0]).toBe(supplementary);
  });

  it('canonicalizes a realistic sign.request params block deterministically', () => {
    const params = {
      payload_type: 'spend',
      origin: 'https://cxch.app',
      payload_b64: 'ZGVhZGJlZWY=',
    };
    // Keys sorted: origin, payload_b64, payload_type.
    expect(canonicalJson(params)).toBe(
      '{"origin":"https://cxch.app","payload_b64":"ZGVhZGJlZWY=","payload_type":"spend"}',
    );
  });
});
