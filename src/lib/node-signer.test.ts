import { describe, it, expect, vi } from 'vitest';
import { makeNodeSignerClient, isNodeMutationMethod, NODE_MUTATION_METHODS } from './node-signer';

describe('isNodeMutationMethod', () => {
  it('recognizes the mutation group', () => {
    expect(isNodeMutationMethod('send_xch')).toBe(true);
    expect(isNodeMutationMethod('make_offer')).toBe(true);
    expect(NODE_MUTATION_METHODS.has('send_cat')).toBe(true);
  });
  it('rejects reads', () => {
    expect(isNodeMutationMethod('get_sync_status')).toBe(false);
    expect(isNodeMutationMethod('get_cats')).toBe(false);
  });
});

describe('makeNodeSignerClient', () => {
  it('sendXch maps to send_xch with auto_submit and maps the fee + coin-spend count', async () => {
    const send = vi.fn().mockResolvedValue({ summary: { fee: '10' }, coin_spends: [{}, {}] });
    const r = await makeNodeSignerClient(send).sendXch({ address: 'xch1dst', amount: '600', fee: '10' });
    expect(send).toHaveBeenCalledWith('send_xch', {
      address: 'xch1dst',
      amount: '600',
      fee: '10',
      memos: [],
      auto_submit: true,
    });
    expect(r).toEqual({ fee: '10', coinSpendCount: 2, raw: { summary: { fee: '10' }, coin_spends: [{}, {}] } });
  });

  it('sendXch forwards memos when present', async () => {
    const send = vi.fn().mockResolvedValue({ summary: { fee: 0 }, coin_spends: [] });
    await makeNodeSignerClient(send).sendXch({ address: 'a', amount: '1', fee: '0', memos: ['hi'] });
    expect(send.mock.calls[0][1]).toMatchObject({ memos: ['hi'] });
  });

  it('sendCat maps assetId → asset_id with auto_submit', async () => {
    const send = vi.fn().mockResolvedValue({ summary: { fee: 5 }, coin_spends: [{}] });
    const r = await makeNodeSignerClient(send).sendCat({ assetId: 'tail', address: 'a', amount: '3', fee: '5' });
    expect(send).toHaveBeenCalledWith('send_cat', {
      asset_id: 'tail',
      address: 'a',
      amount: '3',
      fee: '5',
      auto_submit: true,
    });
    expect(r.fee).toBe('5');
    expect(r.coinSpendCount).toBe(1);
  });

  it('signAndBroadcast routes an arbitrary mutation with auto_submit', async () => {
    const send = vi.fn().mockResolvedValue({ summary: { fee: 0 } });
    await makeNodeSignerClient(send).signAndBroadcast('make_offer', { offered_assets: [] });
    expect(send).toHaveBeenCalledWith('make_offer', { auto_submit: true, offered_assets: [] });
  });

  it('signAndBroadcast REJECTS a read method (reads never route through the signer)', async () => {
    const send = vi.fn();
    await expect(makeNodeSignerClient(send).signAndBroadcast('get_cats', {})).rejects.toThrow(/not a node mutation/);
    expect(send).not.toHaveBeenCalled();
  });

  it('defaults fee to 0 and count to 0 on a malformed result', async () => {
    const send = vi.fn().mockResolvedValue({});
    const r = await makeNodeSignerClient(send).sendXch({ address: 'a', amount: '1', fee: '0' });
    expect(r).toEqual({ fee: '0', coinSpendCount: 0, raw: {} });
  });

  it('propagates a transport rejection (unconsented/unauthorized fails closed)', async () => {
    const send = vi.fn().mockRejectedValue(new Error('broadcast requires explicit per-op consent'));
    await expect(makeNodeSignerClient(send).sendXch({ address: 'a', amount: '1', fee: '0' })).rejects.toThrow(/consent/);
  });
});
