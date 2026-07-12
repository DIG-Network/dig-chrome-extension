import { describe, it, expect } from 'vitest';
import {
  THIN_CLIENT_FLAG_KEY,
  DEFAULT_THIN_CLIENT_CUTOVER,
  isThinClientCutoverEnabled,
} from './thin-client-flags';

describe('thin-client cutover flag', () => {
  it('defaults OFF (local custody preserved until migration proves the node path)', () => {
    expect(DEFAULT_THIN_CLIENT_CUTOVER).toBe(false);
    expect(isThinClientCutoverEnabled(null)).toBe(false);
    expect(isThinClientCutoverEnabled(undefined)).toBe(false);
    expect(isThinClientCutoverEnabled({})).toBe(false);
  });

  it('is ON only for a strict boolean true', () => {
    expect(isThinClientCutoverEnabled({ [THIN_CLIENT_FLAG_KEY]: true })).toBe(true);
  });

  it('treats any non-true value as OFF (a corrupt flag can never purge keys)', () => {
    expect(isThinClientCutoverEnabled({ [THIN_CLIENT_FLAG_KEY]: false })).toBe(false);
    expect(isThinClientCutoverEnabled({ [THIN_CLIENT_FLAG_KEY]: 'true' })).toBe(false);
    expect(isThinClientCutoverEnabled({ [THIN_CLIENT_FLAG_KEY]: 1 })).toBe(false);
    expect(isThinClientCutoverEnabled({ [THIN_CLIENT_FLAG_KEY]: {} })).toBe(false);
  });
});
