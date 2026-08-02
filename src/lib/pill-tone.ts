/**
 * The `StatusPill` tone vocabulary, defined at the `lib` layer.
 *
 * Several `lib/*` status-derivation modules (dig-dns-status, wallet-source-status, node-version,
 * updater-status) compute a tone for a `StatusPill` to render, but `lib` must never depend
 * UPWARD on `components` (§6.4 layering). Owning the type here — with `components/StatusPill`
 * importing it back down — keeps the dependency pointing the right way.
 */
export type PillTone = 'neutral' | 'good' | 'warn' | 'bad';
