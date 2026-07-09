import { describe, it, expect } from 'vitest';
import { buildBackupFile, backupFilename, parseBackupFile, BACKUP_MAGIC, BACKUP_VERSION } from './backup';
import { MAGIC, VERSION, type Digwx1Record } from './digwx1';

const RECORD: Digwx1Record = {
  version: VERSION,
  magic: MAGIC,
  kdf: { id: 'argon2id', memKiB: 65536, iters: 3, lanes: 4, salt: 'c2FsdA==' },
  cipher: { id: 'aes-256-gcm', nonce: 'bm9uY2U=' },
  ciphertext: 'Y2lwaGVydGV4dA==',
  createdAt: 1_700_000_000_000,
  label: 'Wallet 1',
};

describe('keystore file backup (#115)', () => {
  it('builds a versioned envelope carrying the wallet label + its own DIGWX1 record verbatim', () => {
    const file = buildBackupFile({ label: 'Wallet 1', createdAt: RECORD.createdAt, record: RECORD }, 1_700_000_500_000);
    expect(file.magic).toBe(BACKUP_MAGIC);
    expect(file.version).toBe(BACKUP_VERSION);
    expect(file.label).toBe('Wallet 1');
    expect(file.createdAt).toBe(RECORD.createdAt);
    expect(file.exportedAt).toBe(1_700_000_500_000);
    // The embedded record is NEVER re-encrypted/decrypted here — it is copied byte-for-byte (the SW
    // never touches decrypted key material, #115's whole point).
    expect(file.record).toEqual(RECORD);
  });

  it('derives a stable, filesystem-safe filename from the label + export date', () => {
    const name = backupFilename('My Wallet #1!', 1_700_000_500_000);
    expect(name).toMatch(/^dig-wallet-my-wallet-1-\d{4}-\d{2}-\d{2}\.json$/);
  });

  it('falls back to a generic filename slug when the label has no safe characters', () => {
    const name = backupFilename('日本語', 1_700_000_500_000);
    expect(name).toMatch(/^dig-wallet-backup-\d{4}-\d{2}-\d{2}\.json$/);
  });

  it('round-trips a built file through JSON.stringify/parse', () => {
    const file = buildBackupFile({ label: 'Wallet 1', createdAt: RECORD.createdAt, record: RECORD });
    const json = JSON.stringify(file);
    const result = parseBackupFile(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.backup.record).toEqual(RECORD);
      expect(result.backup.label).toBe('Wallet 1');
    }
  });

  it('rejects malformed JSON', () => {
    const result = parseBackupFile('{not json');
    expect(result).toEqual({ ok: false, code: 'BAD_FORMAT' });
  });

  it('rejects valid JSON that is not a backup envelope', () => {
    expect(parseBackupFile('{}')).toEqual({ ok: false, code: 'BAD_FORMAT' });
    expect(parseBackupFile('[]')).toEqual({ ok: false, code: 'BAD_FORMAT' });
    expect(parseBackupFile('"hello"')).toEqual({ ok: false, code: 'BAD_FORMAT' });
  });

  it('rejects an envelope with the wrong magic/version', () => {
    const file = buildBackupFile({ label: 'W', createdAt: 0, record: RECORD });
    expect(parseBackupFile(JSON.stringify({ ...file, magic: 'NOPE' }))).toEqual({ ok: false, code: 'BAD_FORMAT' });
    expect(parseBackupFile(JSON.stringify({ ...file, version: 99 }))).toEqual({ ok: false, code: 'BAD_FORMAT' });
  });

  it('rejects an envelope whose embedded record is structurally invalid (BAD_RECORD)', () => {
    const file = buildBackupFile({ label: 'W', createdAt: 0, record: RECORD });
    const tampered = { ...file, record: { ...RECORD, magic: 'NOPE' } };
    expect(parseBackupFile(JSON.stringify(tampered))).toEqual({ ok: false, code: 'BAD_RECORD' });
  });

  it('rejects an envelope with a missing/blank label', () => {
    const file = buildBackupFile({ label: 'W', createdAt: 0, record: RECORD });
    expect(parseBackupFile(JSON.stringify({ ...file, label: '' }))).toEqual({ ok: false, code: 'BAD_FORMAT' });
    expect(parseBackupFile(JSON.stringify({ ...file, label: undefined }))).toEqual({ ok: false, code: 'BAD_FORMAT' });
  });
});
