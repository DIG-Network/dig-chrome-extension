/**
 * QR camera scanning (#107) — pure decode + error-classification helpers, kept separate from the
 * React camera-lifecycle component (`features/wallet/custody/QrScanner.tsx`) so the actual pixel
 * decode + error mapping is unit-tested without a real camera or `HTMLCanvasElement` rendering
 * (jsdom has neither). No new wasm — `jsqr` is a small pure-JS decoder (no native/wasm binding).
 */
import jsQR from 'jsqr';

/** The camera-access failure classes the UI shows a distinct, actionable message for. */
export type CameraErrorKind = 'permission-denied' | 'not-found' | 'unsupported' | 'unknown';

/**
 * Decode one captured video frame (as `ImageData` from a `<canvas>` 2D context) into the QR
 * payload text, or `null` when no code is found in this frame — the scan loop just tries again on
 * the next frame. `dontInvert` skips jsQR's slower inverted-colors pass (a wallet/offer QR is
 * always dark-on-light, matching every QR generator in this codebase, `lib/qr.ts`).
 */
export function decodeQrFromImageData(imageData: ImageData): string | null {
  const result = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
  return result?.data ?? null;
}

/**
 * Classify a `getUserMedia` rejection into an actionable UI state. `NotAllowedError`/
 * `SecurityError` = the user (or the browser/OS) denied camera access; `NotFoundError`/
 * `OverconstrainedError` = no camera device satisfies the request; anything else is a generic
 * failure. {@link isCameraSupported} covers the "no camera API at all" case separately, BEFORE a
 * request is even attempted.
 */
export function classifyCameraError(err: unknown): CameraErrorKind {
  const name = err instanceof DOMException ? err.name : typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : undefined;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'permission-denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'not-found';
  return 'unknown';
}

/** Whether this browsing context exposes the camera API at all (extension pages always do in
 * Chrome, but a defensive check avoids ever calling `getUserMedia` when it doesn't exist). */
export function isCameraSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}
