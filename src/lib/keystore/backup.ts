/**
 * Encrypted keystore FILE backup/restore (#115) — exports one wallet's existing at-rest DIGWX1
 * record as a downloadable JSON file, and validates a file back into a record the SW can add to the
 * wallet registry. This is a THIRD way to move a wallet between devices, alongside the 24-word
 * mnemonic (`Onboarding`'s import step) and nothing else — it never introduces new crypto: the
 * embedded `record` is the SAME Argon2id+AES-256-GCM blob `digwx1.ts` already produces, copied
 * byte-for-byte. The SW never decrypts it during export or import, so this module never touches the
 * wallet's secret key — it only reads/validates the public envelope + the opaque ciphertext.
 *
 * The envelope has its OWN magic/version (independent of `Digwx1Record`'s) so the FILE FORMAT can
 * evolve later (e.g. carrying more than one wallet) without colliding with the at-rest record's own
 * versioning — additive-only, mirroring §5.1's spirit for on-disk formats.
 */

import { isValidDigwx1Record, type Digwx1Record } from '@/lib/keystore/digwx1';

/** Fixed envelope magic + version (bumped only for a NEW writer format; readers stay additive). */
export const BACKUP_MAGIC = 'DIGWBK1' as const;
export const BACKUP_VERSION = 1 as const;

/** The downloadable backup file's shape — one wallet's label + its own encrypted DIGWX1 record. */
export interface KeystoreBackupFile {
  magic: typeof BACKUP_MAGIC;
  version: typeof BACKUP_VERSION;
  /** The wallet's display label at export time (restored as the new wallet's initial label). */
  label: string;
  /** The wallet's original creation timestamp (ms) — preserved across the round trip. */
  createdAt: number;
  /** When this backup file was produced (ms) — informational only. */
  exportedAt: number;
  /** The wallet's own encrypted DIGWX1 record, copied verbatim (never decrypted here). */
  record: Digwx1Record;
}

/** Machine error code for a rejected backup file. */
export type BackupParseError = 'BAD_FORMAT' | 'BAD_RECORD';
export type ParseBackupResult = { ok: true; backup: KeystoreBackupFile } | { ok: false; code: BackupParseError };

/** Build the backup envelope for one wallet. Pure — the caller writes/downloads the JSON. */
export function buildBackupFile(
  wallet: { label: string; createdAt: number; record: Digwx1Record },
  exportedAt: number = Date.now(),
): KeystoreBackupFile {
  return {
    magic: BACKUP_MAGIC,
    version: BACKUP_VERSION,
    label: wallet.label,
    createdAt: wallet.createdAt,
    exportedAt,
    record: wallet.record,
  };
}

/**
 * A filesystem-safe filename for the backup download: `dig-wallet-<slug>-<yyyy-mm-dd>.json`. Falls
 * back to a generic slug when the label has no ASCII-safe characters left after slugifying (e.g. a
 * label written entirely in a non-Latin script) so the filename is never empty/malformed.
 */
export function backupFilename(label: string, now: number = Date.now()): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const date = new Date(now).toISOString().slice(0, 10);
  return `dig-wallet-${slug || 'backup'}-${date}.json`;
}

/**
 * Parse + validate a candidate backup file's JSON text. Rejects malformed JSON, a non-envelope
 * shape, or a wrong magic/version as `BAD_FORMAT`; rejects a structurally-invalid embedded record
 * (see {@link isValidDigwx1Record}) as `BAD_RECORD` — never attempts to decrypt it.
 */
export function parseBackupFile(json: string): ParseBackupResult {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { ok: false, code: 'BAD_FORMAT' };
  }
  if (!value || typeof value !== 'object') return { ok: false, code: 'BAD_FORMAT' };
  const candidate = value as Partial<KeystoreBackupFile>;
  if (
    candidate.magic !== BACKUP_MAGIC ||
    candidate.version !== BACKUP_VERSION ||
    typeof candidate.label !== 'string' ||
    !candidate.label.trim() ||
    typeof candidate.createdAt !== 'number'
  ) {
    return { ok: false, code: 'BAD_FORMAT' };
  }
  if (!isValidDigwx1Record(candidate.record)) return { ok: false, code: 'BAD_RECORD' };
  return {
    ok: true,
    backup: {
      magic: BACKUP_MAGIC,
      version: BACKUP_VERSION,
      label: candidate.label,
      createdAt: candidate.createdAt,
      exportedAt: typeof candidate.exportedAt === 'number' ? candidate.exportedAt : Date.now(),
      record: candidate.record,
    },
  };
}
