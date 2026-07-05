/**
 * The offscreen keystore VAULT — the in-memory custody core that runs ONLY inside the long-lived
 * `chrome.offscreen` document (§5.1). It is the sole place the decrypted wallet secret ever lives:
 * `unlockWallet` decrypts the DIGWX1 blob and holds the BIP-39 entropy in this object's memory;
 * `lockWallet` zeroizes it. The service worker coordinates + owns storage, but never sees the key —
 * it forwards `VaultRequest`s here and gets back only public results (lock state, the encrypted
 * record to persist, or the once-shown mnemonic).
 *
 * This class is PURE (WebCrypto + hash-wasm + @scure/bip39 via the tested `lib/keystore` modules;
 * no chrome.* / DOM), so it is unit-tested in Vitest with a fast injected Argon2. `src/offscreen/
 * main.ts` is the thin runtime glue that instantiates it and wires `chrome.runtime.onMessage`.
 *
 * Zeroization is best-effort in JS (§5.9): the held entropy is `fill(0)`-ed and dropped on lock,
 * and transient copies (e.g. the reveal buffer) are wiped immediately. JS cannot guarantee erasure.
 */

import {
  encryptEntropy,
  decryptEntropy,
  ARGON2_DEFAULT,
  ARGON2_STRONG,
  KeystoreError,
  type Digwx1Record,
  type Argon2Fn,
} from '@/lib/keystore/digwx1';
import {
  generateMnemonic,
  isValidMnemonic,
  mnemonicToEntropy,
  entropyToMnemonic,
} from '@/lib/keystore/bip39';

/** The keystore operations the vault handles (mirrors the SW custody actions). */
export type VaultOp =
  | 'createWallet'
  | 'importWallet'
  | 'unlockWallet'
  | 'lockWallet'
  | 'revealPhrase'
  | 'getVaultState';

/** A request forwarded from the SW to the vault. `record` is the persisted DIGWX1 blob for ops that need it. */
export interface VaultRequest {
  op: VaultOp;
  password?: string;
  mnemonic?: string;
  label?: string;
  /** Use the STRONG (256 MiB) Argon2 preset for a high-value wallet. */
  strong?: boolean;
  /** The persisted keystore record (SW reads it from storage for unlock / reveal). */
  record?: Digwx1Record;
}

/** The vault's reply. Never carries the persisted key; `mnemonic` is for one-time display only. */
export interface VaultResponse {
  success: boolean;
  /** Machine code on failure (`UNLOCK_FAILED`, `INVALID_MNEMONIC`, `BAD_REQUEST`). */
  code?: string;
  message?: string;
  /** Whether the vault currently holds a decrypted key. */
  hasKey?: boolean;
  /** True when the PBKDF2 fallback engaged (caller warns + schedules re-encryption). */
  usedFallback?: boolean;
  /** The encrypted record to persist (create / import only). */
  record?: Digwx1Record;
  /** The 24-word phrase — create + reveal only; shown once, never stored. */
  mnemonic?: string;
}

/** Test/DI seam. */
export interface VaultDeps {
  argon2Fn?: Argon2Fn;
}

export class Vault {
  /** The decrypted BIP-39 entropy — the ONLY secret held, in memory only. */
  private entropy: Uint8Array | null = null;

  /** True iff a decrypted key is currently held in memory. */
  hasKey(): boolean {
    return this.entropy !== null;
  }

  /** Zeroize + drop the held secret (best-effort). Idempotent. */
  lock(): void {
    if (this.entropy) this.entropy.fill(0);
    this.entropy = null;
  }

  /** Replace the held entropy, zeroizing any prior copy first. */
  private hold(entropy: Uint8Array): void {
    this.lock();
    this.entropy = entropy;
  }

  /** Dispatch one vault request. Never throws — failures come back as `{success:false, code}`. */
  async handle(req: VaultRequest, deps: VaultDeps = {}): Promise<VaultResponse> {
    try {
      switch (req.op) {
        case 'createWallet':
          return await this.createWallet(req, deps);
        case 'importWallet':
          return await this.importWallet(req, deps);
        case 'unlockWallet':
          return await this.unlockWallet(req, deps);
        case 'revealPhrase':
          return await this.revealPhrase(req, deps);
        case 'lockWallet':
          this.lock();
          return { success: true, hasKey: false };
        case 'getVaultState':
          return { success: true, hasKey: this.hasKey() };
        default:
          return { success: false, code: 'BAD_REQUEST', message: `unknown vault op` };
      }
    } catch (e) {
      // Never leak internals; map keystore errors to their code, everything else to a generic code.
      if (e instanceof KeystoreError) return { success: false, code: e.code, message: e.message };
      return { success: false, code: 'VAULT_ERROR', message: 'vault operation failed' };
    }
  }

  private async createWallet(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!req.password) return { success: false, code: 'BAD_REQUEST', message: 'password required' };
    const mnemonic = generateMnemonic();
    const entropy = mnemonicToEntropy(mnemonic);
    const { record, usedFallback } = await encryptEntropy(entropy, req.password, {
      argon2Params: req.strong ? ARGON2_STRONG : ARGON2_DEFAULT,
      ...(req.label ? { label: req.label } : {}),
      ...(deps.argon2Fn ? { argon2Fn: deps.argon2Fn } : {}),
    });
    this.hold(entropy);
    return { success: true, hasKey: true, record, mnemonic, usedFallback };
  }

  private async importWallet(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!req.password) return { success: false, code: 'BAD_REQUEST', message: 'password required' };
    if (!req.mnemonic || !isValidMnemonic(req.mnemonic)) {
      return { success: false, code: 'INVALID_MNEMONIC', message: 'recovery phrase is invalid' };
    }
    const entropy = mnemonicToEntropy(req.mnemonic);
    const { record, usedFallback } = await encryptEntropy(entropy, req.password, {
      argon2Params: req.strong ? ARGON2_STRONG : ARGON2_DEFAULT,
      ...(req.label ? { label: req.label } : {}),
      ...(deps.argon2Fn ? { argon2Fn: deps.argon2Fn } : {}),
    });
    this.hold(entropy);
    return { success: true, hasKey: true, record, usedFallback };
  }

  private async unlockWallet(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!req.password || !req.record) {
      return { success: false, code: 'BAD_REQUEST', message: 'password and record required' };
    }
    const entropy = await decryptEntropy(req.record, req.password, deps.argon2Fn);
    this.hold(entropy);
    return { success: true, hasKey: true };
  }

  /**
   * Reveal the recovery phrase for backup — re-runs the FULL password decrypt (§5.5: never from the
   * TTL window). Does not alter the held-key state; the transient entropy copy is zeroized.
   */
  private async revealPhrase(req: VaultRequest, deps: VaultDeps): Promise<VaultResponse> {
    if (!req.password || !req.record) {
      return { success: false, code: 'BAD_REQUEST', message: 'password and record required' };
    }
    const entropy = await decryptEntropy(req.record, req.password, deps.argon2Fn);
    const mnemonic = entropyToMnemonic(entropy);
    entropy.fill(0);
    return { success: true, mnemonic };
  }
}
