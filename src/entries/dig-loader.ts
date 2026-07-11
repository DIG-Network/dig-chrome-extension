/**
 * DIG Loader entry (dig-loader.html, #311) — the instant, never-blank branded interstitial the
 * background service worker flashes the tab to FIRST on a `dig`-keyword / `chia://` /
 * `urn:dig:chia:` / `<sub>.on.dig.net` URN-bar submit (`handleDigUrlNavigation`), while the §5.3/§5.4
 * node-or-sandbox resolve runs. Mirrors `*.on.dig.net`'s loader-shell UX (instant paint, async
 * resolve, never-blank) and the extension's own `DigLoader.tsx` React component — this vanilla-TS
 * page renders the IDENTICAL `.dig-loader`/`.dig-loader-card` markup (theme.css) so it looks pixel-
 * identical, without pulling React into a page whose own logic is this thin (same rationale as
 * welcome.ts / dig-viewer.ts).
 *
 * This page does NOT resolve anything itself — the SW does the resolve (best-effort, wrapped in its
 * own try/catch) and then navigates the tab PAST this page to the resolved destination, or to the
 * branded recoverable error page (`error-page.ts`) on failure. The only thing this page needs to do
 * is paint instantly and show which address is resolving. A defensive failsafe (below) guards the
 * pathological case where the SW never follows up (never spinner-forever, even then).
 */
import '@/styles/theme.css';
import { parseLoaderInput, loaderDisplayAddress } from '@/lib/dig-loader';

/** If the SW hasn't navigated the tab away by this deadline, something went wrong upstream (a bug,
 *  not the ordinary resolve path — that always finishes in well under this window); show a
 *  recoverable fallback rather than spinning forever. Not started at all in the ordinary path –
 *  the whole document (including this timer) is torn down by the SW's own follow-up navigation
 *  long before it fires. */
const FAILSAFE_TIMEOUT_MS = 20_000;

/** Build the same DIG-mark SVG `DigLoader.tsx` renders (a fixed literal — safe to set via
 *  `innerHTML`; no user-controlled data is interpolated into it). */
function buildMarkSvg(): string {
  return `<svg viewBox="0 0 168 72" role="img" aria-label="DIG Network">
    <defs>
      <linearGradient id="dig-loader-mark-grad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#9466ff" />
        <stop offset="0.55" stop-color="#7a3dff" />
        <stop offset="1" stop-color="#ff00de" />
      </linearGradient>
    </defs>
    <text x="84" y="44" text-anchor="middle" font-family="'Space Grotesk', system-ui, sans-serif" font-size="46" font-weight="700" letter-spacing="1.5" fill="url(#dig-loader-mark-grad)">DIG</text>
    <text x="84" y="66" text-anchor="middle" font-family="'Space Grotesk', system-ui, sans-serif" font-size="15" font-weight="600" letter-spacing="7" fill="#ffffff">NETWORK</text>
  </svg>`;
}

/** Render the branded loader card — identical structure/classes to `DigLoader.tsx` so the two never
 *  visually diverge. `address` is set via `textContent` (never `innerHTML`) — defence in depth even
 *  though it is normally just a `chia://`/URN value. */
function renderLoader(root: HTMLElement, address: string): void {
  root.innerHTML = '';
  const overlay = document.createElement('div');
  overlay.className = 'dig-loader';
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'polite');
  overlay.setAttribute('aria-busy', 'true');
  overlay.setAttribute('data-state', 'loading');
  overlay.setAttribute('data-testid', 'dig-loader-page');

  const card = document.createElement('div');
  card.className = 'dig-loader-card';

  const mark = document.createElement('div');
  mark.className = 'dig-loader-mark';
  mark.innerHTML = buildMarkSvg();

  const spinner = document.createElement('div');
  spinner.className = 'dig-loader-spinner';
  spinner.setAttribute('aria-hidden', 'true');
  spinner.setAttribute('data-testid', 'dig-loader-spinner');

  const title = document.createElement('p');
  title.className = 'dig-loader-title';
  title.textContent = 'Loading your DIG page…';

  const subtitle = document.createElement('p');
  subtitle.className = 'dig-loader-subtitle';
  subtitle.setAttribute('data-testid', 'dig-loader-address');
  subtitle.textContent = `Resolving ${address}…`;

  card.append(mark, spinner, title, subtitle);
  overlay.appendChild(card);
  root.appendChild(overlay);
}

/** The defensive fallback (never spinner-forever): swap the title/subtitle for a recoverable
 *  message + retry/home actions, matching `error-page.ts`'s recovery affordances. */
function renderFailsafe(root: HTMLElement): void {
  const title = root.querySelector<HTMLElement>('.dig-loader-title');
  const subtitle = root.querySelector<HTMLElement>('.dig-loader-subtitle');
  const spinner = root.querySelector<HTMLElement>('.dig-loader-spinner');
  const card = root.querySelector<HTMLElement>('.dig-loader-card');
  if (!card) return;
  if (spinner) spinner.style.display = 'none';
  if (title) title.textContent = "This is taking longer than expected";
  if (subtitle) subtitle.textContent = 'The DIG Network may be unreachable, or this address may not exist.';

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:10px;justify-content:center;margin-top:16px;';

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Try again';
  retry.setAttribute('data-testid', 'dig-loader-retry');
  retry.style.cssText =
    'flex:1 1 140px;padding:11px 14px;border-radius:10px;font:inherit;font-weight:600;cursor:pointer;' +
    'border:none;background:linear-gradient(135deg,#7a3dff 0%,#ff00de 100%);color:#fff;';
  retry.addEventListener('click', () => location.reload());

  const home = document.createElement('a');
  home.textContent = 'Go to DIG Home';
  home.href = 'https://dig.net';
  home.setAttribute('data-testid', 'dig-loader-home');
  home.style.cssText =
    'flex:1 1 140px;padding:11px 14px;border-radius:10px;font-weight:600;text-align:center;' +
    'text-decoration:none;border:1px solid #7a3dff;color:#c9b3ff;';

  actions.append(retry, home);
  card.appendChild(actions);
}

function init(): void {
  const root = document.getElementById('root');
  if (!root) return;
  const input = parseLoaderInput(window.location.search);
  renderLoader(root, loaderDisplayAddress(input));
  window.setTimeout(() => renderFailsafe(root), FAILSAFE_TIMEOUT_MS);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
