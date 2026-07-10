/* tslint:disable */
/* eslint-disable */

/**
 * Install a panic hook that forwards Rust panics to the JS console with a
 * real message instead of an opaque "unreachable executed" trap. Call once
 * at module load; idempotent (subsequent calls are no-ops).
 */
export function init(): void;

/**
 * Open a blob produced by [`seal`], returning the original secret bytes.
 *
 * Fails with a thrown error for a wrong password, a tampered/corrupted
 * blob, or a blob that isn't a `dig-keystore` opaque-secret container
 * (e.g., it's a validator/wallet `DIGVK1`/`DIGLW1` keystore file instead).
 */
export function open(password: string, blob: Uint8Array): Uint8Array;

/**
 * Seal `secret` under `password`, returning the encoded container bytes.
 *
 * Uses [`KdfParams::DEFAULT`] (64 MiB / 3 iterations / 4 lanes — the same
 * default every native DIG keystore file uses) and OS randomness (via
 * `getrandom`'s "js" backend) for the salt + nonce. `secret` may be any
 * length, including empty (e.g., raw BIP-39 entropy of 16-32 bytes, or any
 * other opaque application secret).
 */
export function seal(password: string, secret: Uint8Array): Uint8Array;

/**
 * Seal `secret` under `password` using the STRONG Argon2id preset (256 MiB /
 * 4 iterations / 4 lanes — [`KdfParams::STRONG`]) instead of [`seal`]'s
 * [`KdfParams::DEFAULT`], for a caller's high-value-secret option (dig_ecosystem
 * #147 Phase B — the extension's `ARGON2_STRONG` wallet preset). Otherwise
 * identical to [`seal`]: OS randomness, any secret length, opened by the same
 * [`open`] (the preset is recorded in the blob's own self-describing header,
 * not tracked by the caller).
 */
export function sealStrong(password: string, secret: Uint8Array): Uint8Array;

/**
 * **Test/fixture-only.** Seals `secret` under `password` using a
 * deterministic RNG seeded from `seed`, so the exact output bytes are
 * reproducible. Used exclusively to prove `wasm/tests/opaque_wasm.rs`'s
 * known-answer vector matches `tests/opaque_vectors.rs`'s native vector
 * byte-for-byte (dig_ecosystem #147 Phase A native↔wasm compatibility
 * proof).
 *
 * # ⚠️ Never use this for a real secret
 *
 * A seeded RNG is trivially predictable — a caller who knows (or can guess)
 * `seed` can derive the exact salt/nonce used, defeating the encryption.
 * Production callers MUST use [`seal`] (OS randomness) instead.
 */
export function sealWithSeed(password: string, secret: Uint8Array, seed: bigint): Uint8Array;

/**
 * `true` if `password` opens `blob` without exposing the secret. Never
 * throws — a malformed blob or a wrong password both report `false`.
 */
export function verifyPassword(password: string, blob: Uint8Array): boolean;
