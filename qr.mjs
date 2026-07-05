/**
 * Tiny QR renderer for the wallet Receive view (and the WalletConnect pairing URI).
 *
 * Wraps the battle-tested `qrcode-generator` (MIT) so the extension stays offline — the encoder
 * is inlined into dist/qr.mjs at build time (esbuild), so the MV3 extension-page CSP
 * (`script-src 'self'`) is satisfied with no runtime CDN. This mirrors the native DIG Browser
 * wallet's dig-wallet/wc/qr.js: same encoder, same crisp black-on-white SVG, so a receive QR
 * scans identically whether the user is on the DIG Browser or on Chrome/Edge/Brave with this
 * extension.
 *
 * Pure (no DOM / chrome.*): returns an `<svg>…</svg>` STRING the popup injects via innerHTML,
 * so the output contract is unit-testable and the renderer stays thin glue.
 */

import qrcode from 'qrcode-generator';

/**
 * Render `text` as a crisp black-on-white QR SVG string sized to `size` px. Uses
 * error-correction level "M" and auto type-number (0 = pick the smallest that fits), which
 * comfortably holds an `xch1…` address or a WalletConnect `wc:` URI.
 *
 * @param {string} text the payload to encode (e.g. a receive address)
 * @param {number} [size=180] the SVG's width/height in CSS px
 * @returns {string} an `<svg>…</svg>` string
 */
export function qrSvg(text, size = 180) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text == null ? '' : text));
  qr.make();
  const count = qr.getModuleCount();
  const cell = size / count;
  let rects = '';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) {
        const x = (c * cell).toFixed(2);
        const y = (r * cell).toFixed(2);
        const w = cell.toFixed(2);
        rects += `<rect x="${x}" y="${y}" width="${w}" height="${w}" fill="#000"/>`;
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>${rects}</svg>`
  );
}
