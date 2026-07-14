import { describe, it, expect } from 'vitest';
import {
  normalizeUpdaterStatus,
  updaterActionLabelId,
  updaterOutcomeLabelId,
  updaterResultTone,
  updaterPausedTone,
} from '@/lib/updater-status';

describe('normalizeUpdaterStatus (dig-updater SPEC §13.2)', () => {
  it('reports not-installed as a normal, well-formed outcome (never throws, never an error shape)', () => {
    expect(normalizeUpdaterStatus({ installed: false })).toEqual({ installed: false, status: null });
    expect(normalizeUpdaterStatus(undefined)).toEqual({ installed: false, status: null });
    expect(normalizeUpdaterStatus(null)).toEqual({ installed: false, status: null });
    expect(normalizeUpdaterStatus('garbage')).toEqual({ installed: false, status: null });
    expect(normalizeUpdaterStatus({})).toEqual({ installed: false, status: null });
  });

  it('normalizes a full, well-formed snapshot verbatim into the camelCase model', () => {
    const raw = {
      installed: true,
      status: {
        schema: 1,
        version: '0.6.0',
        channel: 'alpha',
        paused: false,
        paused_until: null,
        last_check: 1730990000,
        last_check_kind: 'run',
        last_outcome: 'applied',
        last_reason: null,
        last_detail: null,
        components: [
          { component: 'dig-node', action: 'update', result: 'installed', detail: '0.25.0 -> 0.26.0' },
        ],
        next_wake: 1731076400,
        trust_state: { root_version: 1, sequence: 42, generated: 1730990000, rollback_floor_build: 20 },
      },
    };

    expect(normalizeUpdaterStatus(raw)).toEqual({
      installed: true,
      status: {
        version: '0.6.0',
        channel: 'alpha',
        paused: false,
        lastCheckUnixSec: 1730990000,
        lastCheckKind: 'run',
        lastOutcome: 'applied',
        lastReason: null,
        lastDetail: null,
        nextWakeUnixSec: 1731076400,
        components: [{ component: 'dig-node', action: 'update', result: 'installed', detail: '0.25.0 -> 0.26.0' }],
      },
    });
  });

  it('reports a fresh, never-checked install as a well-formed all-null snapshot, not an error', () => {
    const raw = {
      installed: true,
      status: { schema: 1, version: '0.6.0', channel: 'alpha', paused: false, paused_until: null, components: [] },
    };
    const result = normalizeUpdaterStatus(raw);
    expect(result.installed).toBe(true);
    expect(result.status?.lastCheckUnixSec).toBeNull();
    expect(result.status?.lastOutcome).toBeNull();
    expect(result.status?.components).toEqual([]);
  });

  it('tolerates a malformed components entry rather than throwing (forward-compat, §13.2 opaque JSON)', () => {
    const raw = { installed: true, status: { components: [null, 42, 'nope', { component: 'digstore' }] } };
    const result = normalizeUpdaterStatus(raw);
    expect(result.status?.components).toEqual([
      { component: 'unknown', action: null, result: null, detail: null },
      { component: 'unknown', action: null, result: null, detail: null },
      { component: 'unknown', action: null, result: null, detail: null },
      { component: 'digstore', action: null, result: null, detail: null },
    ]);
  });

  it('only accepts the documented last_check_kind values, else null (forward-compat)', () => {
    expect(normalizeUpdaterStatus({ installed: true, status: { last_check_kind: 'dry' } }).status?.lastCheckKind).toBe('dry');
    expect(normalizeUpdaterStatus({ installed: true, status: { last_check_kind: 'run' } }).status?.lastCheckKind).toBe('run');
    expect(normalizeUpdaterStatus({ installed: true, status: { last_check_kind: 'bogus' } }).status?.lastCheckKind).toBeNull();
  });
});

describe('updaterActionLabelId — forward-compat mapping of a component plan action', () => {
  it('maps every documented action (dig-updater SPEC §13.2)', () => {
    expect(updaterActionLabelId('install')).toBe('updates.action.install');
    expect(updaterActionLabelId('update')).toBe('updates.action.update');
    expect(updaterActionLabelId('skip')).toBe('updates.action.skip');
    expect(updaterActionLabelId('would_fetch')).toBe('updates.action.wouldFetch');
  });

  it('falls back to the generic id for an unrecognized/absent action (a future beacon field must never break the tab)', () => {
    expect(updaterActionLabelId(null)).toBe('updates.action.unknown');
    expect(updaterActionLabelId('some_future_action')).toBe('updates.action.unknown');
  });
});

describe('updaterOutcomeLabelId — forward-compat mapping of the overall last_outcome', () => {
  it('maps every documented outcome (dig-updater SPEC §13.2)', () => {
    expect(updaterOutcomeLabelId('verified')).toBe('updates.outcome.verified');
    expect(updaterOutcomeLabelId('rejected')).toBe('updates.outcome.rejected');
    expect(updaterOutcomeLabelId('applied')).toBe('updates.outcome.applied');
    expect(updaterOutcomeLabelId('nothing_applied')).toBe('updates.outcome.nothingApplied');
  });

  it('falls back to the generic id for an unrecognized/absent outcome', () => {
    expect(updaterOutcomeLabelId(null)).toBe('updates.outcome.unknown');
    expect(updaterOutcomeLabelId('some_future_outcome')).toBe('updates.outcome.unknown');
  });
});

describe('updaterResultTone — never meaning-by-color-alone (paired with the action/result text)', () => {
  it('tones the documented per-component results', () => {
    expect(updaterResultTone('installed')).toBe('good');
    expect(updaterResultTone('staged')).toBe('good');
    expect(updaterResultTone('skipped')).toBe('neutral');
    expect(updaterResultTone('deferred')).toBe('warn');
    expect(updaterResultTone('rolled_back')).toBe('warn');
  });

  it('falls back to neutral for an unrecognized result', () => {
    expect(updaterResultTone(null)).toBe('neutral');
    expect(updaterResultTone('some_future_result')).toBe('neutral');
  });
});

describe('updaterPausedTone', () => {
  it('warns when paused, reads good when active', () => {
    expect(updaterPausedTone(true)).toBe('warn');
    expect(updaterPausedTone(false)).toBe('good');
  });
});
