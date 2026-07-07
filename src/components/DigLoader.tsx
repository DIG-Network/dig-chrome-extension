import type { ReactNode } from 'react';

/**
 * The DIG-branded loading card (#157) — matches `*.on.dig.net`'s resolver loader shell
 * (`services/on.dig.net/assets/loader.html`): a dark card (DIG Mark wordmark + a purple spinner +
 * message + subtext) on a contained radial-glow backdrop, so every DIG surface shows the SAME
 * "DIG is loading your content" experience. Purely presentational — the caller supplies the copy
 * (already run through react-intl) so this stays reusable across surfaces (the in-window dApp
 * app-view today; the open-by-URN content view is a natural next consumer).
 *
 * Renders as an absolute-fill overlay — mount it inside a `position: relative` host that already
 * has the size you want the branded loader to cover (the in-window app-view's body, a future
 * full-page content host, …).
 */
export function DigLoader({ title, subtitle, testid }: { title: ReactNode; subtitle?: ReactNode; testid?: string }) {
  return (
    <div className="dig-loader" role="status" aria-live="polite" aria-busy="true" data-state="loading" data-testid={testid}>
      <div className="dig-loader-card">
        <div className="dig-loader-mark">
          {/* The DIG Network wordmark, byte-identical in spirit to the on.dig.net loader's inline
              SVG: "DIG" in the brand purple→magenta gradient, "NETWORK" in solid white beneath it
              (never inheriting a background-clip fill — the full mark must always read). The SVG
              itself carries role="img" + aria-label, so it — not the wrapping div — is the
              accessible unit; the div must NOT be aria-hidden or it swallows that label. */}
          <svg viewBox="0 0 168 72" role="img" aria-label="DIG Network">
            <defs>
              <linearGradient id="dig-loader-mark-grad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#9466ff" />
                <stop offset="0.55" stopColor="#7a3dff" />
                <stop offset="1" stopColor="#ff00de" />
              </linearGradient>
            </defs>
            <text x="84" y="44" textAnchor="middle" fontFamily="'Space Grotesk', system-ui, sans-serif" fontSize="46" fontWeight="700" letterSpacing="1.5" fill="url(#dig-loader-mark-grad)">
              DIG
            </text>
            <text x="84" y="66" textAnchor="middle" fontFamily="'Space Grotesk', system-ui, sans-serif" fontSize="15" fontWeight="600" letterSpacing="7" fill="#ffffff">
              NETWORK
            </text>
          </svg>
        </div>
        <div className="dig-loader-spinner" aria-hidden="true" />
        <p className="dig-loader-title">{title}</p>
        {subtitle && <p className="dig-loader-subtitle">{subtitle}</p>}
      </div>
    </div>
  );
}
