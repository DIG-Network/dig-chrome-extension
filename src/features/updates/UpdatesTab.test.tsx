import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { UpdatesTab } from '@/features/updates/UpdatesTab';

interface Sent {
  action?: string;
  method?: string;
  params?: Record<string, unknown>;
}

const NODE_UP = { mode: 'manage', localNode: true, base: 'https://dig.local', controlEndpoint: 'https://dig.local/', readFallback: 'https://rpc.dig.net', status: {}, authRequired: false, controlMethods: [] };
const NODE_DOWN = { mode: 'install', localNode: false, base: null, controlEndpoint: null, readFallback: 'https://rpc.dig.net', status: null, authRequired: false, controlMethods: [] };

const NOT_INSTALLED = { installed: false };

/** A fresh install that has never run a check yet — every last-check/outcome field is null and
 *  `components` is empty (dig-updater SPEC §13.2's documented "never checked" snapshot). */
const INSTALLED_NEVER_CHECKED = {
  installed: true,
  status: { schema: 1, version: '0.6.0', channel: 'alpha', paused: false, paused_until: null, components: [] },
};

const INSTALLED_ACTIVE = {
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
      { component: 'digstore', action: 'skip', result: 'skipped', detail: 'already current' },
    ],
    next_wake: 1731076400,
  },
};

type BeaconState = typeof NOT_INSTALLED | typeof INSTALLED_NEVER_CHECKED | typeof INSTALLED_ACTIVE;

/** A mutable beacon state the stub mutates as pause/resume/checkNow drive it (mirrors the real
 *  dig-updater CLI's status.json refresh-after-every-mutation behavior, dig-updater SPEC §13.2).
 *  `checkNowFails` simulates the CLI declining (dig-node #515 `CliError::Declined`), so the panel's
 *  inline action-error path is exercisable. */
function mockSw({ node, phase, beacon, checkNowFails = false }: { node: typeof NODE_UP | typeof NODE_DOWN; phase: string; beacon: BeaconState; checkNowFails?: boolean }) {
  const state = JSON.parse(JSON.stringify(beacon));
  (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
    (msg: Sent | undefined, cb?: (r: unknown) => void) => {
      const m = msg ?? {};
      let r: unknown = { success: true };
      if (m.action === 'getControlStatus') r = node;
      else if (m.action === 'pairingState') r = { phase };
      else if (m.action === 'controlAuthed' && m.method === 'control.updater.status') r = state;
      else if (m.action === 'controlAuthed' && m.method === 'control.updater.pause') {
        if (state.installed) state.status.paused = true;
        r = { ok: true };
      } else if (m.action === 'controlAuthed' && m.method === 'control.updater.resume') {
        if (state.installed) state.status.paused = false;
        r = { ok: true };
      } else if (m.action === 'controlAuthed' && m.method === 'control.updater.checkNow') {
        r = checkNowFails ? { success: false, error: 'dig-updater declined the request' } : { ok: true };
      }
      if (cb) cb(r);
      return Promise.resolve(r);
    },
  );
}

afterEach(() => vi.restoreAllMocks());

describe('UpdatesTab (#504-K/#516)', () => {
  it('renders an honest node-down state when no local dig-node is reachable', async () => {
    mockSw({ node: NODE_DOWN, phase: 'unpaired', beacon: NOT_INSTALLED });
    renderWithProviders(<UpdatesTab />);
    expect(await screen.findByTestId('updates-nodedown')).toBeTruthy();
    expect(screen.queryByTestId('updates-panel')).toBeNull();
  });

  it('keeps the panel behind the pairing gate when the node is online but unpaired', async () => {
    mockSw({ node: NODE_UP, phase: 'unpaired', beacon: NOT_INSTALLED });
    renderWithProviders(<UpdatesTab />);
    expect(await screen.findByTestId('control-pairing')).toBeTruthy();
    expect(screen.queryByTestId('updates-panel')).toBeNull();
  });

  it('shows a graceful not-installed empty state (never an error) when the beacon is absent', async () => {
    mockSw({ node: NODE_UP, phase: 'paired', beacon: NOT_INSTALLED });
    renderWithProviders(<UpdatesTab />);
    expect(await screen.findByTestId('updates-status-empty')).toBeTruthy();
    expect(screen.queryByTestId('updates-status-error')).toBeNull();
    expect(screen.queryByTestId('updates-panel')).toBeNull();
  });

  it('renders the channel/last-check/components/controls once installed + paired', async () => {
    mockSw({ node: NODE_UP, phase: 'paired', beacon: INSTALLED_ACTIVE });
    renderWithProviders(<UpdatesTab />);
    expect(await screen.findByTestId('updates-panel')).toBeTruthy();
    expect(screen.getByTestId('updates-channel')).toHaveTextContent('alpha');
    expect(screen.getAllByTestId('updates-component-row')).toHaveLength(2);
    expect(screen.getByTestId('updates-pause')).toBeTruthy();
    expect(screen.getByTestId('updates-check-now')).toBeTruthy();
  });

  it('the pause control flips to a resume control once the node reports paused', async () => {
    mockSw({ node: NODE_UP, phase: 'paired', beacon: INSTALLED_ACTIVE });
    renderWithProviders(<UpdatesTab />);
    const pauseBtn = await screen.findByTestId('updates-pause');
    fireEvent.click(pauseBtn);
    expect(await screen.findByTestId('updates-resume')).toBeTruthy();
    expect(screen.queryByTestId('updates-pause')).toBeNull();
  });

  it('shows the fresh-install "never checked" snapshot with a real components empty-state', async () => {
    mockSw({ node: NODE_UP, phase: 'paired', beacon: INSTALLED_NEVER_CHECKED });
    renderWithProviders(<UpdatesTab />);
    expect(await screen.findByTestId('updates-panel')).toBeTruthy();
    expect(screen.getByTestId('updates-last-check')).toHaveTextContent('Never checked yet');
    expect(screen.getByTestId('updates-components-empty')).toBeTruthy();
    expect(screen.queryByTestId('updates-component-row')).toBeNull();
  });

  it('surfaces a recoverable inline error when a control (check-now) is declined', async () => {
    mockSw({ node: NODE_UP, phase: 'paired', beacon: INSTALLED_ACTIVE, checkNowFails: true });
    renderWithProviders(<UpdatesTab />);
    const checkNowBtn = await screen.findByTestId('updates-check-now');
    fireEvent.click(checkNowBtn);
    expect(await screen.findByTestId('updates-action-error')).toBeTruthy();
  });
});
