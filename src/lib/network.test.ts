import { describe, it, expect } from 'vitest';
import { NETWORK_IDS, DEFAULT_NETWORK_ID, NETWORKS, isNetworkId, resolveNetwork } from '@/lib/network';
import { MAINNET_AGG_SIG_ME, TESTNET11_AGG_SIG_ME } from '@/offscreen/signing';

describe('network (#108)', () => {
  it('ships mainnet + testnet, defaulting to mainnet', () => {
    expect(NETWORK_IDS).toEqual(['mainnet', 'testnet']);
    expect(DEFAULT_NETWORK_ID).toBe('mainnet');
  });

  it('validates a network id string', () => {
    expect(isNetworkId('mainnet')).toBe(true);
    expect(isNetworkId('testnet')).toBe(true);
    expect(isNetworkId('devnet')).toBe(false);
    expect(isNetworkId(undefined)).toBe(false);
    expect(isNetworkId(null)).toBe(false);
  });

  it('mainnet config: xch prefix, mainnet AGG_SIG_ME, the coinset.org default', () => {
    const m = NETWORKS.mainnet;
    expect(m.addressPrefix).toBe('xch');
    expect(m.aggSigMeHex).toBe(MAINNET_AGG_SIG_ME);
    expect(m.coinsetUrl).toBe('https://api.coinset.org');
  });

  it('testnet config: txch prefix, testnet11 AGG_SIG_ME, the testnet11 coinset endpoint', () => {
    const t = NETWORKS.testnet;
    expect(t.addressPrefix).toBe('txch');
    expect(t.aggSigMeHex).toBe(TESTNET11_AGG_SIG_ME);
    expect(t.coinsetUrl).toBe('https://testnet11.api.coinset.org');
  });

  it('resolveNetwork falls back to mainnet for missing/unknown ids', () => {
    expect(resolveNetwork(undefined).id).toBe('mainnet');
    expect(resolveNetwork(null).id).toBe('mainnet');
    expect(resolveNetwork('devnet').id).toBe('mainnet');
    expect(resolveNetwork('testnet').id).toBe('testnet');
  });
});
