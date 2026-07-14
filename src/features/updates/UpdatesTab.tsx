import { useState } from 'react';
import { FormattedMessage, FormattedDate } from 'react-intl';
import { FourState } from '@/components/FourState';
import { StatusPill } from '@/components/StatusPill';
import { PairingSection } from '@/features/control/PairingSection';
import { controlPanelViewModel } from '@/lib/dig-control';
import { useGetControlStatusQuery } from '@/features/control/controlApi';
import {
  useGetUpdaterStatusQuery,
  usePauseUpdaterMutation,
  useResumeUpdaterMutation,
  useCheckNowUpdaterMutation,
} from '@/features/updates/updaterApi';
import {
  updaterActionLabelId,
  updaterOutcomeLabelId,
  updaterResultLabelId,
  updaterResultTone,
  updaterPausedTone,
  type UpdaterStatus,
} from '@/lib/updater-status';

/** A mutation trigger's settled result — the shape every RTK Query mutation promise resolves to. */
type MutationOutcome = { data: unknown } | { error: unknown };

/**
 * The beacon status + component-decision readout, and the three controls (dig-updater SPEC §13.3):
 * pause/resume the daily schedule, and trigger an on-demand full check. A THIN presenter — every
 * number/label here comes straight from the node's `control.updater.*` proxy; this component makes
 * no update decisions of its own.
 */
function UpdaterPanel({ status }: { status: UpdaterStatus }) {
  const [pause, pauseState] = usePauseUpdaterMutation();
  const [resume, resumeState] = useResumeUpdaterMutation();
  const [checkNow, checkNowState] = useCheckNowUpdaterMutation();
  const [actionError, setActionError] = useState(false);

  const busy = pauseState.isLoading || resumeState.isLoading || checkNowState.isLoading;

  // Every control shares one outcome handler: clear any prior error, run the trigger, and surface a
  // recoverable inline error on failure (the query's own `Updater` tag invalidation refreshes the
  // status automatically on success — no manual refetch wiring, §6.4).
  async function runControl(trigger: () => Promise<MutationOutcome>) {
    setActionError(false);
    const outcome = await trigger();
    if (!('data' in outcome)) setActionError(true);
  }

  return (
    <div data-testid="updates-panel" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section className="dig-card" data-testid="updates-summary" aria-labelledby="updates-summary-title">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <h3 className="dig-subheading" id="updates-summary-title" style={{ margin: 0 }}>
            <FormattedMessage id="updates.summary.title" />
          </h3>
          <StatusPill tone={updaterPausedTone(status.paused)} testid="updates-paused-pill">
            <FormattedMessage id={status.paused ? 'updates.status.paused' : 'updates.status.active'} />
          </StatusPill>
        </div>
        <p className="dig-muted" data-testid="updates-version" style={{ marginTop: 4 }}>
          <FormattedMessage id="updates.version" values={{ version: status.version ?? '—' }} />
        </p>

        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', rowGap: 8, columnGap: 12, margin: '12px 0 0' }}>
          <dt className="dig-muted">
            <FormattedMessage id="updates.channel.label" />
          </dt>
          <dd data-testid="updates-channel" style={{ margin: 0, fontFamily: 'monospace' }}>
            {status.channel ?? '—'}
          </dd>

          <dt className="dig-muted">
            <FormattedMessage id="updates.lastCheck.label" />
          </dt>
          <dd data-testid="updates-last-check" style={{ margin: 0 }}>
            {status.lastCheckUnixSec ? (
              <>
                <FormattedDate value={status.lastCheckUnixSec * 1000} dateStyle="medium" timeStyle="short" />
                {status.lastCheckKind && (
                  <>
                    {' · '}
                    <FormattedMessage id={status.lastCheckKind === 'dry' ? 'updates.lastCheck.kind.dry' : 'updates.lastCheck.kind.run'} />
                  </>
                )}
              </>
            ) : (
              <FormattedMessage id="updates.lastCheck.never" />
            )}
          </dd>

          <dt className="dig-muted">
            <FormattedMessage id="updates.nextWake.label" />
          </dt>
          <dd data-testid="updates-next-wake" style={{ margin: 0 }}>
            {status.nextWakeUnixSec ? (
              <FormattedDate value={status.nextWakeUnixSec * 1000} dateStyle="medium" timeStyle="short" />
            ) : (
              <FormattedMessage id="updates.nextWake.none" />
            )}
          </dd>

          <dt className="dig-muted">
            <FormattedMessage id="updates.outcome.label" />
          </dt>
          <dd data-testid="updates-outcome" style={{ margin: 0 }}>
            <FormattedMessage id={updaterOutcomeLabelId(status.lastOutcome)} />
            {status.lastDetail && <span className="dig-muted"> — {status.lastDetail}</span>}
          </dd>
        </dl>
      </section>

      <section className="dig-card" data-testid="updates-components" aria-labelledby="updates-components-title">
        <h3 className="dig-subheading" id="updates-components-title" style={{ margin: '0 0 8px' }}>
          <FormattedMessage id="updates.components.title" />
        </h3>
        {status.components.length === 0 ? (
          <p className="dig-muted" data-testid="updates-components-empty" style={{ margin: 0 }}>
            <FormattedMessage id="updates.components.empty" />
          </p>
        ) : (
          <ul className="dig-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {status.components.map((c) => (
              <li
                key={c.component}
                data-testid="updates-component-row"
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--dig-border, #3333)' }}
              >
                <span style={{ fontFamily: 'monospace', minWidth: 90 }}>{c.component}</span>
                <span>
                  <FormattedMessage id={updaterActionLabelId(c.action)} />
                </span>
                {c.detail && (
                  <span className="dig-muted" data-testid="updates-component-detail">
                    {c.detail}
                  </span>
                )}
                <span style={{ marginLeft: 'auto' }}>
                  <StatusPill tone={updaterResultTone(c.result)}>
                    <FormattedMessage id={updaterResultLabelId(c.result)} />
                  </StatusPill>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="dig-card" data-testid="updates-controls" aria-labelledby="updates-controls-title">
        <h3 className="dig-subheading" id="updates-controls-title" style={{ margin: '0 0 8px' }}>
          <FormattedMessage id="updates.controls.title" />
        </h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {status.paused ? (
            <button
              type="button"
              className="dig-btn dig-btn--primary"
              data-testid="updates-resume"
              disabled={busy}
              onClick={() => void runControl(resume)}
            >
              <FormattedMessage id={resumeState.isLoading ? 'updates.resume.pending' : 'updates.resume'} />
            </button>
          ) : (
            <button
              type="button"
              className="dig-btn"
              data-testid="updates-pause"
              disabled={busy}
              onClick={() => void runControl(() => pause())}
            >
              <FormattedMessage id={pauseState.isLoading ? 'updates.pause.pending' : 'updates.pause'} />
            </button>
          )}
          <button
            type="button"
            className="dig-btn dig-btn--primary"
            data-testid="updates-check-now"
            disabled={busy}
            onClick={() => void runControl(checkNow)}
          >
            <FormattedMessage id={checkNowState.isLoading ? 'updates.checkNow.pending' : 'updates.checkNow'} />
          </button>
        </div>
        <p className="dig-muted" style={{ marginTop: 8, marginBottom: 0 }}>
          <FormattedMessage id="updates.checkNow.hint" />
        </p>
        {actionError && (
          <p className="dig-error-text" role="alert" data-testid="updates-action-error" style={{ marginTop: 8, marginBottom: 0 }}>
            <FormattedMessage id="updates.error.action" />
          </p>
        )}
      </section>
    </div>
  );
}

/**
 * The paired, node-dependent Updates panel: reads the live `control.updater.status` and renders the
 * beacon readout + controls once pairing is established. Owns the query's four states so the panel
 * never renders on absent/stale status — `installed: false` (the beacon was never installed) is its
 * own real EMPTY state, never an error wall (family #516 requirement).
 */
function UpdaterStatusGate() {
  const status = useGetUpdaterStatusQuery();

  return (
    <FourState
      isLoading={status.isLoading}
      isError={status.isError}
      isEmpty={!status.data?.installed}
      onRetry={() => void status.refetch()}
      errorId="updates.error.status"
      emptyId="updates.notInstalled.body"
      testid="updates-status"
    >
      {status.data?.status && <UpdaterPanel status={status.data.status} />}
    </FourState>
  );
}

/**
 * The fullscreen **Updates tab** (#504-K, child of epic #504). The management surface over the DIG
 * auto-update beacon (`dig-updater`): channel, last-check time, per-component last result, next
 * wake, and pause/resume + an on-demand check — all read/driven through the dig-node
 * `control.updater.*` proxy (dig-node #515), never re-implemented here (the node stays the ONLY
 * place that fetches/verifies/installs).
 *
 * Fullscreen-only (§145 surface tiering) — auto-update management lives fullscreen, never the
 * compact popup. Node-dependent + paired-gated: a node-offline state renders honestly (never a
 * broken view), and the panel renders only once the control-token pairing is established (the
 * SAME auth the other paired management sections use — no new auth surface, dig-node #515).
 */
export function UpdatesTab() {
  const control = useGetControlStatusQuery();
  const vm = control.data ? controlPanelViewModel(control.data) : null;
  const nodeOnline = !!vm?.nodeOnline;

  return (
    <section className="dig-card" data-testid="updates-tab-panel" aria-labelledby="updates-title">
      <h2 className="dig-heading" id="updates-title">
        <FormattedMessage id="updates.tab.title" />
      </h2>
      <p className="dig-muted" style={{ marginTop: 0 }}>
        <FormattedMessage id="updates.tab.intro" />
      </p>

      <FourState
        isLoading={control.isLoading}
        isError={control.isError}
        isEmpty={false}
        onRetry={() => void control.refetch()}
        testid="updates-control"
      >
        {nodeOnline ? (
          <PairingSection>
            <UpdaterStatusGate />
          </PairingSection>
        ) : (
          <p className="dig-muted" data-testid="updates-nodedown" style={{ margin: 0 }}>
            <FormattedMessage id="updates.tab.nodeDown" />
          </p>
        )}
      </FourState>
    </section>
  );
}
