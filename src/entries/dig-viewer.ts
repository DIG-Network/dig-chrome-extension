/**
 * DIG Viewer entry (dig-viewer.html) — fetches chia:// content via the background service worker
 * and renders it in a sandboxed iframe, showing the verified/failed banner and the branded,
 * non-leaking error page. Built by Vite as a multi-page entry into dist/ (see vite.config.ts +
 * build.js buildWebApp), which bundles the shared `#shared/*` view-models it imports.
 *
 * Pure DOM + chrome.* glue (no meaningful branch logic of its own — the decision cores live in the
 * unit-tested `#shared/*` modules), which is why it lives under `src/entries/` (coverage-excluded).
 */
import { friendlyCause } from '@/lib/error-page';
// Stable action names (no raw string literals) + the catalogued loader error codes so the viewer
// exposes a machine-readable failure discriminant alongside the friendly human copy.
import { ACTIONS } from '@/lib/messages';
import { classifyError, DIG_ERR, type DigErrorCode } from '@/lib/error-codes';
// Shared URN parser — derive the capsule (storeId:rootHash) + resource path so the per-resource
// proof verdict can be recorded into the DIG Shields ledger (#134).
import { parseURN, decodeUrnParam } from '@/lib/dig-urn';
// Build the chia:// URL for a resolved store reference — used to serve the in-page interceptor's
// relative-asset reads (#55) back through the background proxyRequest (the §5.3 node ladder).
import { buildDigUrl, type StoreRef } from '@/lib/store-refs';

// One canonical verified label across popup / viewer / toolbar.
const VERIFIED_LABEL = 'Verified on Chia';
const VERIFIED_TOOLTIP = 'Merkle-proven against the on-chain root and decrypted on this device';

/** The `proxyRequest` response envelope the background service worker replies with. */
interface ProxyResponse {
  success?: boolean;
  data?: string;
  contentType?: string;
  verified?: boolean;
  code?: DigErrorCode;
  error?: string;
}

/** A message posted from the sandboxed store frame's in-page interceptor to this page. */
interface DigFrameMessage {
  __dig?: boolean;
  type?: 'read' | 'ready' | 'nav' | 'entry-error' | 'nav-error';
  id?: unknown;
  ref?: StoreRef;
  verified?: boolean;
  urn?: string;
  message?: string;
  code?: DigErrorCode;
}

/** The capsule config handed to the in-page interceptor via `window.__DIG_CFG`. */
interface FrameConfig {
  storeId: string;
  root: string;
  salt: string | null;
  entryKey: string;
}

// Show the verified / verification-failed banner (mirrors the popup line + toolbar badge).
function showVerifyBanner(verified: boolean): void {
  const banner = document.getElementById('verifyBanner');
  const text = document.getElementById('verifyText');
  const close = document.getElementById('verifyClose');
  if (!banner || !text) return;
  if (verified) {
    banner.className = 'verified';
    banner.title = VERIFIED_TOOLTIP;
    text.textContent = VERIFIED_LABEL;
  } else {
    banner.className = 'failed';
    banner.title = 'This content could not be proven against the on-chain root — do not trust it.';
    text.textContent = 'Verification failed';
  }
  // Machine state as data-* (read by agents without scraping label/class).
  banner.setAttribute('data-verified', verified ? 'true' : 'false');
  document.documentElement.setAttribute('data-dig-verified', verified ? 'true' : 'false');
  document.body.classList.add('has-banner');
  if (close) {
    close.onclick = () => {
      banner.style.display = 'none';
      document.body.classList.remove('has-banner');
    };
  }
}

// Render the branded, white-theme error state in place of the loading indicator.
// NEVER shows the raw failure message — friendlyCause() maps it to a safe, plain-language
// cause (so internal strings like "decoy or wrong key" never reach the user). The stable
// machine code (DIG_ERR_*) is exposed as a document data-* attribute + on the mount so an
// agent can branch on the failure kind without scraping the human copy.
function showError(url: string, rawMessage: string | null | undefined, code?: DigErrorCode): void {
  const loading = document.getElementById('loading');
  const mount = document.getElementById('errorMount');
  if (loading) loading.style.display = 'none';
  const errCode = code || classifyError(rawMessage) || DIG_ERR.DIG_ERR_NETWORK;
  document.documentElement.setAttribute('data-dig-error', errCode);
  if (mount) mount.setAttribute('data-dig-error', errCode);
  if (!mount) return;
  mount.innerHTML = '';

  const card = document.createElement('div');
  card.style.cssText =
    'max-width:520px;width:calc(100% - 64px);margin:10vh auto 0;text-align:center;' +
    'background:#ffffff;border:1px solid #e4e1f0;border-radius:16px;padding:40px 36px;' +
    'box-shadow:0 8px 32px rgba(20,18,43,0.08);' +
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#14122b;";

  const mark = document.createElement('div');
  mark.textContent = 'DIG';
  mark.setAttribute('aria-hidden', 'true');
  mark.style.cssText =
    'width:56px;height:56px;margin:0 auto 20px;border-radius:50%;display:flex;align-items:center;' +
    'justify-content:center;background:linear-gradient(135deg,#5800D6 0%,#FF00DE 100%);' +
    'color:#fff;font-size:24px;font-weight:700;';

  const h1 = document.createElement('h1');
  h1.textContent = "This DIG page couldn't be loaded";
  h1.style.cssText = 'font-size:22px;font-weight:700;margin:0 0 10px;';

  const lead = document.createElement('p');
  lead.textContent = friendlyCause(rawMessage); // safe, plain-language; never the raw string
  lead.style.cssText = 'font-size:15px;line-height:1.6;color:#5e5a7c;margin:0 0 18px;';

  const addr = document.createElement('div');
  addr.textContent = url || '';
  addr.style.cssText =
    'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;' +
    'color:#14122b;background:#f7f7fb;border:1px solid #e4e1f0;border-radius:8px;padding:8px 10px;' +
    'word-break:break-all;margin:0 0 24px;';

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:12px;justify-content:center;';

  const retry = document.createElement('button');
  retry.textContent = 'Try again';
  retry.style.cssText =
    'flex:1 1 180px;padding:13px 18px;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;' +
    'border:none;background:linear-gradient(135deg,#5800D6 0%,#FF00DE 100%);color:#fff;' +
    'box-shadow:0 4px 14px rgba(88,0,214,0.35);';
  retry.addEventListener('click', () => location.reload());

  const home = document.createElement('a');
  home.textContent = 'Go to DIG Home';
  home.href = 'https://dig.net';
  home.style.cssText =
    'flex:1 1 180px;padding:13px 18px;border-radius:10px;font-size:15px;font-weight:600;' +
    'text-decoration:none;border:1px solid #5800D6;color:#5800D6;background:#fff;';

  actions.append(retry, home);
  card.append(mark, h1, lead);
  if (url) card.append(addr);
  card.append(actions);
  mount.appendChild(card);
}

// Report a resource's verification verdict to the background SW (sets the toolbar badge) and
// record it into the active tab's DIG Shields proof ledger (#134). Best-effort; the ledger never
// re-verifies — the verdict is the loader's. `urnStr` is a chia:// / bare URN for the resource.
function recordVerification(verified: boolean, urnStr: string): void {
  try {
    chrome.runtime.sendMessage(
      { action: ACTIONS.reportVerification, verified, urn: urnStr },
      () => {
        void chrome.runtime.lastError;
      },
    );
  } catch {
    /* non-fatal */
  }
  try {
    const parsed = parseURN(String(urnStr).replace(/^chia:\/\//, ''));
    if (parsed) {
      chrome.runtime.sendMessage(
        {
          action: ACTIONS.recordLedgerEntry,
          storeId: parsed.storeId,
          rootHash: parsed.roothash || 'latest',
          resourcePath: parsed.resourceKey || 'index.html',
          inclusionProofPassed: verified,
          errorCode: verified ? '' : DIG_ERR.DIG_ERR_PROOF_MISMATCH,
          // The extension read path fetches inclusion only (dig.getContent) — no execution
          // proof is available, so the ledger honestly records none.
          executionProofStatus: '',
        },
        () => {
          void chrome.runtime.lastError;
        },
      );
    }
  } catch {
    /* non-fatal */
  }
}

// Serve ONE store read for the in-page interceptor (#55): resolve the ref to its chia:// URL and
// proxy it through the background (the §5.3 node ladder + verify + decrypt), replying to the
// requesting frame with a `data:` URL. This is the extension's analogue of the *.on.dig.net loader
// SW's fetch handler — a store's relative asset request routed back to the node as a capsule read.
function serveRead(source: Window, id: unknown, ref: StoreRef | undefined): void {
  const reply = (payload: Record<string, unknown>): void => {
    try {
      source.postMessage({ __dig: true, type: 'read-result', id, ...payload }, '*');
    } catch {
      /* frame gone */
    }
  };
  let url: string;
  try {
    if (!ref || !ref.storeId) throw new Error('missing store');
    url = buildDigUrl(ref);
  } catch {
    reply({ ok: false, code: DIG_ERR.DIG_ERR_INVALID_URN, message: 'Invalid store reference' });
    return;
  }
  chrome.runtime.sendMessage({ action: ACTIONS.proxyRequest, url }, (response: ProxyResponse | undefined) => {
    if (chrome.runtime.lastError) {
      reply({ ok: false, code: DIG_ERR.DIG_ERR_NETWORK, message: chrome.runtime.lastError.message });
      return;
    }
    if (!response || !response.success || !response.data) {
      reply({
        ok: false,
        code: (response && response.code) || DIG_ERR.DIG_ERR_NETWORK,
        message: (response && response.error) || 'Failed to fetch',
      });
      return;
    }
    reply({ ok: true, dataUrl: response.data, contentType: response.contentType, verified: !!response.verified });
  });
}

// Build the sandboxed store-frame document: an opaque-origin `data:` document (isolated from the
// extension — no chrome.* access) that boots the in-page interceptor with the capsule config. The
// interceptor requests the entry + every relative asset back through this page's message bridge.
function storeFrameDoc(cfg: FrameConfig, interceptorSrc: string): string {
  const cfgJson = JSON.stringify(cfg);
  const html =
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="color-scheme" content="light dark"><title>DIG Network Content</title>' +
    '<style>html,body{margin:0;padding:0;min-height:100%;background:#fff}</style>' +
    '<script>window.__DIG_CFG=' + cfgJson + ';</scr' + 'ipt>' +
    '<script>' + interceptorSrc + '</scr' + 'ipt>' +
    '</head><body></body></html>';
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

async function init(): Promise<void> {
  const urlParams = new URLSearchParams(window.location.search);
  // URLSearchParams decodes the value ONCE; some navigation paths encode the chia:// URL twice, so
  // fully decode until stable (a valid URN has no literal '%') — otherwise a still-encoded value
  // like `chia%3A%2F%2F…` fails parseURN and the page never loads.
  const urn = decodeUrnParam(urlParams.get('urn'));
  const loading = document.getElementById('loading');
  const digUrl = urn && (urn.startsWith('chia://') ? urn : `chia://${urn}`);

  if (!urn) {
    showError('', 'This address may not exist.');
    return;
  }

  // Resolve the entry capsule so the interceptor can resolve relative references against it.
  const parsed = parseURN(String(urn).replace(/^chia:\/\//, ''));
  if (!parsed) {
    showError(digUrl, 'This address may not exist.', DIG_ERR.DIG_ERR_INVALID_URN);
    return;
  }
  const cfg: FrameConfig = {
    storeId: parsed.storeId,
    root: parsed.roothash || 'latest',
    salt: parsed.salt || null,
    entryKey: parsed.resourceKey || 'index.html',
  };

  // Load the interceptor bundle (self-contained IIFE) so it can be inlined into the opaque frame —
  // an opaque `data:` document cannot import a module or fetch a cross-origin script.
  let interceptorSrc: string;
  try {
    interceptorSrc = await (await fetch(chrome.runtime.getURL('store-interceptor.js'))).text();
  } catch {
    showError(digUrl, 'Failed to fetch', DIG_ERR.DIG_ERR_NETWORK);
    return;
  }

  const iframe = document.createElement('iframe');

  // Bridge: serve the interceptor's reads + react to its lifecycle notifications.
  const onMessage = (event: MessageEvent): void => {
    if (event.source !== iframe.contentWindow) return; // only our store frame
    const d = event.data as DigFrameMessage | null;
    if (!d || d.__dig !== true) return;
    switch (d.type) {
      case 'read':
        serveRead(event.source as Window, d.id, d.ref);
        break;
      case 'ready':
        // The entry document rendered — reveal it, drop the spinner, record the entry verdict.
        showVerifyBanner(!!d.verified);
        recordVerification(!!d.verified, urn);
        if (loading) loading.style.display = 'none';
        break;
      case 'nav':
        // An in-page navigation to another store document — update the badge + ledger.
        showVerifyBanner(!!d.verified);
        recordVerification(!!d.verified, d.urn || urn);
        break;
      case 'entry-error':
        window.removeEventListener('message', onMessage);
        showError(digUrl, d.message || 'Failed to fetch', d.code);
        break;
      case 'nav-error':
        // A failed in-page link — surface it without tearing down the current view.
        showError(digUrl, d.message || 'Failed to fetch', d.code);
        break;
      default:
        break;
    }
  };
  window.addEventListener('message', onMessage);

  iframe.src = storeFrameDoc(cfg, interceptorSrc);
  iframe.onerror = () => showError(digUrl, 'Failed to fetch');
  document.body.appendChild(iframe);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    void init();
  });
} else {
  void init();
}
