import { FormattedMessage } from 'react-intl';

/**
 * The Advertise tab (#411) — a fullscreen-only top-level surface that RESERVES a future $DIG-movement
 * venue (pay $DIG to advertise across the DIG Network, per the North Star §6.0). For now it is a
 * clean, centered "Coming soon" placeholder; the real advertise flow is a later ticket.
 *
 * Purely presentational (no data/fetch, no state) so it needs no loading/error handling. Copy flows
 * through react-intl; the heading + placeholder carry stable `data-testid`s and semantic landmarks
 * (a labelled `region`) so it is accessible AND agent-drivable.
 */
export function AdvertiseTab() {
  return (
    <section className="dig-card" data-testid="advertise-panel" aria-labelledby="advertise-title">
      <h2 className="dig-heading" id="advertise-title">
        <FormattedMessage id="advertise.title" />
      </h2>
      <div
        data-testid="advertise-comingsoon"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          gap: 10,
          padding: '48px 24px',
        }}
      >
        <span aria-hidden="true" style={{ fontSize: 40, lineHeight: 1 }}>
          📣
        </span>
        <p style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
          <FormattedMessage id="advertise.soon.title" />
        </p>
        <p className="dig-muted" style={{ margin: 0, maxWidth: 420 }}>
          <FormattedMessage id="advertise.soon.body" />
        </p>
      </div>
    </section>
  );
}
