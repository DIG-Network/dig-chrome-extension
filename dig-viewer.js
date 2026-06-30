// DIG Viewer — fetches chia:// content via the background SW and renders it in an iframe.
// Loaded as an ES module so it can import the shared branded error page.
import { friendlyCause } from './error-page.mjs';
// Stable action names (no raw string literals) + the catalogued loader error codes so the
// viewer exposes a machine-readable failure discriminant alongside the friendly human copy.
import { ACTIONS } from './messages.mjs';
import { classifyError, DIG_ERR } from './error-codes.mjs';
// Shared URN parser — derive the capsule (storeId:rootHash) + resource path so the per-resource
// proof verdict can be recorded into the DIG Shields ledger (#134).
import { parseURN } from './dig-urn.mjs';

// One canonical verified label across popup / viewer / toolbar.
const VERIFIED_LABEL = 'Verified on Chia';
const VERIFIED_TOOLTIP = 'Merkle-proven against the on-chain root and decrypted on this device';

// Show the verified / verification-failed banner (mirrors the popup line + toolbar badge).
function showVerifyBanner(verified) {
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
function showError(url, rawMessage, code) {
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

function init() {
  const urlParams = new URLSearchParams(window.location.search);
  const urn = urlParams.get('urn');
  const loading = document.getElementById('loading');
  const digUrl = urn && (urn.startsWith('chia://') ? urn : `chia://${urn}`);

  if (!urn) {
    showError('', 'This address may not exist.');
    return;
  }

  chrome.runtime.sendMessage({ action: ACTIONS.proxyRequest, url: digUrl }, async (response) => {
    if (chrome.runtime.lastError) {
      showError(digUrl, chrome.runtime.lastError.message);
      return;
    }
    if (response && response.error) {
      // The coded envelope carries response.code (DIG_ERR_*); pass it through so the viewer
      // surfaces the machine discriminant (data-dig-error) even though the human copy stays friendly.
      showError(digUrl, response.error, response.code);
      return;
    }
    if (!response || !response.success || !response.data) {
      showError(digUrl, 'Failed to fetch', DIG_ERR.DIG_ERR_NETWORK);
      return;
    }

    const dataUrl = response.data;
    const verified = !!response.verified;

    // Report verification to the background SW (sets the toolbar badge) + show the banner.
    try {
      chrome.runtime.sendMessage(
        { action: ACTIONS.reportVerification, verified, urn },
        () => { void chrome.runtime.lastError; }
      );
    } catch (e) { /* non-fatal */ }

    // Record this resource's inclusion-proof verdict into the active tab's DIG Shields proof
    // ledger (#134) so the popup's Shield action can list the per-resource proofs. The verdict
    // is the loader's (response.verified) — the ledger never re-verifies. Best-effort.
    try {
      const parsed = parseURN(String(urn).replace(/^chia:\/\//, ''));
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
          () => { void chrome.runtime.lastError; }
        );
      }
    } catch (e) { /* non-fatal */ }

    showVerifyBanner(verified);

    if (loading) loading.style.display = 'none';

    const iframe = document.createElement('iframe');
    iframe.src = dataUrl;
    iframe.onerror = () => showError(digUrl, 'Failed to fetch');
    document.body.appendChild(iframe);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
