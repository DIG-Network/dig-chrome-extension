import { describe, it, expect, vi } from 'vitest';
import { makeNodeCustodyClient, type NodeCustodyTransport } from './node-custody';

/** A fake transport recording every (method, params) and replying from a canned map. */
function fakeTransport(replies: Record<string, unknown>): { send: NodeCustodyTransport; calls: Array<[string, Record<string, unknown>]> } {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const send: NodeCustodyTransport = async (method, params) => {
    calls.push([method, params]);
    if (method in replies) return replies[method];
    throw new Error(`no canned reply for ${method}`);
  };
  return { send, calls };
}

describe('makeNodeCustodyClient', () => {
  it('maps wallet.status tri-state + address', async () => {
    const { send } = fakeTransport({ 'wallet.status': { state: 'unlocked', address: 'xch1abc' } });
    expect(await makeNodeCustodyClient(send).status()).toEqual({ state: 'unlocked', address: 'xch1abc' });
  });

  it('narrows a malformed status to none/null (never trusts raw wire)', async () => {
    const { send } = fakeTransport({ 'wallet.status': { state: 'bogus', address: 42 } });
    expect(await makeNodeCustodyClient(send).status()).toEqual({ state: 'none', address: null });
  });

  it('status locked carries no address', async () => {
    const { send } = fakeTransport({ 'wallet.status': { state: 'locked' } });
    expect(await makeNodeCustodyClient(send).status()).toEqual({ state: 'locked', address: null });
  });

  it('create sends { password } and returns the address', async () => {
    const { send, calls } = fakeTransport({ 'wallet.create': { address: 'xch1new' } });
    expect(await makeNodeCustodyClient(send).create('pw')).toEqual({ address: 'xch1new' });
    expect(calls).toEqual([['wallet.create', { password: 'pw' }]]);
  });

  it('import sends { mnemonic, password } (the one-time migration import)', async () => {
    const { send, calls } = fakeTransport({ 'wallet.import': { address: 'xch1imp' } });
    expect(await makeNodeCustodyClient(send).import('word '.repeat(24).trim(), 'pw')).toEqual({ address: 'xch1imp' });
    expect(calls[0][0]).toBe('wallet.import');
    expect(calls[0][1]).toEqual({ mnemonic: 'word '.repeat(24).trim(), password: 'pw' });
  });

  it('restore sends { mnemonic, password }', async () => {
    const { send, calls } = fakeTransport({ 'wallet.restore': { address: 'xch1res' } });
    await makeNodeCustodyClient(send).restore('m', 'pw');
    expect(calls).toEqual([['wallet.restore', { mnemonic: 'm', password: 'pw' }]]);
  });

  it('unlock sends { password } and returns the address', async () => {
    const { send, calls } = fakeTransport({ 'wallet.unlock': { address: 'xch1u' } });
    expect(await makeNodeCustodyClient(send).unlock('pw')).toEqual({ address: 'xch1u' });
    expect(calls).toEqual([['wallet.unlock', { password: 'pw' }]]);
  });

  it('lock returns the resulting state', async () => {
    const { send, calls } = fakeTransport({ 'wallet.lock': { state: 'locked' } });
    expect(await makeNodeCustodyClient(send).lock()).toEqual({ state: 'locked' });
    expect(calls).toEqual([['wallet.lock', {}]]);
  });

  it('delete sends { password } and reports none', async () => {
    const { send, calls } = fakeTransport({ 'wallet.delete': { state: 'none' } });
    expect(await makeNodeCustodyClient(send).delete('pw')).toEqual({ state: 'none' });
    expect(calls).toEqual([['wallet.delete', { password: 'pw' }]]);
  });

  it('throws when an address-returning op omits the address (never silently succeeds)', async () => {
    const { send } = fakeTransport({ 'wallet.create': {} });
    await expect(makeNodeCustodyClient(send).create('pw')).rejects.toThrow(/receive address/);
  });

  it('propagates a transport rejection (e.g. -32030 unauthorized)', async () => {
    const send = vi.fn().mockRejectedValue(new Error('unauthorized'));
    await expect(makeNodeCustodyClient(send).unlock('pw')).rejects.toThrow('unauthorized');
  });
});
