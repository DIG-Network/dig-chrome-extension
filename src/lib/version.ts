/**
 * App-version resolution (§6.7). The extension surfaces its semver THREE ways so a bug report
 * always records which build it came from: a subtle on-page footer, a `<meta name="app-version">`
 * tag, and a `window.__APP_VERSION__` global. This module owns the single resolution + the global
 * publish, sourced from the build-injected `__APP_VERSION__` (Vite `define`, from package.json) so
 * it can never drift from a hardcoded literal.
 */

/** The build-time semver, injected by Vite `define` (see vite.config.ts). */
declare const __APP_VERSION__: string;

/** The resolved app version, or '' when unknown (un-built source). */
export function appVersion(): string {
  try {
    const v = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__.trim() : '';
    return v && v !== '__APP_VERSION__' ? v : '';
  } catch {
    return '';
  }
}

/** A footer-ready label: `vX.Y.Z`, or an em dash when the version is unknown. */
export function versionLabel(): string {
  const v = appVersion();
  return v ? `v${v}` : '—';
}

/**
 * Publish the version to `window.__APP_VERSION__` so `<BugReportButton>` (and any agent) can read
 * the running build. Idempotent; safe to call on every mount.
 */
export function publishVersionGlobal(): void {
  try {
    (window as unknown as { __APP_VERSION__?: string }).__APP_VERSION__ = appVersion();
  } catch {
    /* window may be unavailable in a non-DOM context — ignore */
  }
}
