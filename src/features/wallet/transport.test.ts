import { describe, it, expect } from 'vitest';
import { sessionAddress, readConnection, writeConnection } from '@/features/wallet/transport';

describe('wallet transport (pure)', () => {
  it('extracts a chia address from a WC session', () => {
    expect(sessionAddress({ namespaces: { chia: { accounts: ['chia:mainnet:xch1abc'] } } })).toBe('xch1abc');
  });

  it('returns empty for a malformed session', () => {
    expect(sessionAddress(null)).toBe('');
    expect(sessionAddress({})).toBe('');
    expect(sessionAddress({ namespaces: { chia: { accounts: [] } } })).toBe('');
  });

  it('reads a default (disconnected) connection when none stored', async () => {
    await chrome.storage.local.remove('wallet.connection');
    expect(await readConnection()).toEqual({ connected: false });
  });

  it('round-trips a written connection', async () => {
    await writeConnection({ connected: true, address: 'xch1z', network: 'mainnet', topic: 't' });
    expect(await readConnection()).toMatchObject({ connected: true, address: 'xch1z' });
  });
});
