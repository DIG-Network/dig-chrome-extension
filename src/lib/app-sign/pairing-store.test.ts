import { describe, it, expect, beforeEach } from 'vitest';
import { PairingStore, PAIRING_STORAGE_KEY, type KvStore } from './pairing-store';

/** An in-memory KvStore fake mirroring the chrome.storage.local subset. */
function memoryKv(): KvStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (k) => data.get(k),
    set: async (k, v) => void data.set(k, v),
    remove: async (k) => void data.delete(k),
  };
}

describe('PairingStore', () => {
  let kv: ReturnType<typeof memoryKv>;
  let store: PairingStore;

  beforeEach(() => {
    kv = memoryKv();
    store = new PairingStore(kv);
  });

  it('returns null when unpaired', async () => {
    expect(await store.load()).toBeNull();
  });

  it('saves a fresh pairing with nonce 0', async () => {
    await store.save({ pairingId: 'pid', channelTokenB64: 'dG9rZW4=', pairedAt: 123 });
    expect(await store.load()).toEqual({ pairingId: 'pid', channelTokenB64: 'dG9rZW4=', nonce: 0, pairedAt: 123 });
  });

  it('persists the last-issued nonce for monotonic resume', async () => {
    await store.save({ pairingId: 'pid', channelTokenB64: 't', pairedAt: 1 });
    await store.saveNonce(7);
    expect((await store.load())?.nonce).toBe(7);
  });

  it('saveNonce is a no-op when unpaired', async () => {
    await store.saveNonce(5);
    expect(await store.load()).toBeNull();
  });

  it('clear removes the record (local unpair)', async () => {
    await store.save({ pairingId: 'pid', channelTokenB64: 't', pairedAt: 1 });
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it('treats a malformed stored value as unpaired', async () => {
    kv.data.set(PAIRING_STORAGE_KEY, { pairingId: 42 });
    expect(await store.load()).toBeNull();
  });
});
