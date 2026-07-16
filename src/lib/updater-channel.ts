/**
 * The DIG auto-update channel model (#591/#606) — the ONE place the extension names, normalizes, and
 * routes the two update streams the beacon (`dig-updater`) can track:
 *
 * - **stable** — tested `vX.Y.Z` releases only (the beacon's default, #591).
 * - **nightly** — bleeding-edge dated builds: newest features, may be less stable.
 *
 * `control.updater.status` forwards the beacon's `channel` field verbatim (dig-node #515) and is
 * INFORMATIONAL, so this reader tolerates any token: the legacy `"alpha"` stream is an alias for
 * `nightly` (canonical: `alpha` ≡ nightly, #591), and anything unknown/absent defaults to `stable`
 * rather than throwing — an unrecognized future channel must never break the Updates tab, only fall
 * back to the safe default. The node proxy is the sole validator of what we SEND (dig-node v0.32.0
 * keeps no enum of its own), so this enum governs only what the extension DISPLAYS and requests.
 */

/** The two user-selectable update channels. */
export type UpdateChannel = 'stable' | 'nightly';

/** The channels offered by the switcher, stable first (the safe default leads). */
export const UPDATE_CHANNELS: readonly UpdateChannel[] = ['stable', 'nightly'];

/** The channel the beacon tracks when none is set / the token is unknown (#591). */
export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'stable';

/**
 * Map a raw beacon `channel` token to a known {@link UpdateChannel}. `"alpha"` (the legacy stream)
 * resolves to `nightly`; any unknown/empty token resolves to the safe {@link DEFAULT_UPDATE_CHANNEL}
 * — never throwing, so an out-of-date reader degrades gracefully against a newer beacon.
 */
export function normalizeChannel(raw: string | null | undefined): UpdateChannel {
  switch (raw) {
    case 'nightly':
    case 'alpha':
      return 'nightly';
    case 'stable':
      return 'stable';
    default:
      return DEFAULT_UPDATE_CHANNEL;
  }
}

/** The react-intl id for a channel's short option label (never raw prose here). */
export function channelOptionLabelId(channel: UpdateChannel): string {
  return channel === 'nightly' ? 'updates.channel.option.nightly' : 'updates.channel.option.stable';
}

/** The react-intl id for a channel's honest one-line tradeoff description (§6.0/§6.1). */
export function channelDescriptionId(channel: UpdateChannel): string {
  return channel === 'nightly' ? 'updates.channel.desc.nightly' : 'updates.channel.desc.stable';
}
