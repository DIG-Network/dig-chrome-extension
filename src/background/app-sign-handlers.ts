// -----------------------------------------------------------------------------------------------
// APP-SIGN (SIGN-4, #950) — the dig-app paired identity/signing relay, extracted from the frozen
// service-worker monolith (`src/background/index.ts`) into this SEPARATE, FULLY-TYPED module (#1464).
//
// The SW monolith carries a justified file-level `// @ts-nocheck` + an eslint carve-out because it
// is behaviour-frozen chrome.* glue relocated verbatim in #68. That carve-out was, however, also
// swallowing NEW feature handlers added to the file since the freeze — this APP-SIGN block among
// them — letting them ship without tsc/eslint. This module lifts the APP-SIGN wiring + message
// dispatch OUT of the frozen surface so it is type-checked and strict-linted like the rest of the
// React/TS codebase (§6.4). The SW simply imports {@link createAppSignHandler} and forwards its
// APP-SIGN messages to the returned dispatcher; behaviour is byte-for-byte the pre-extraction path.
//
// The extension is the trusted-once MEDIATOR that pairs with dig-app and relays dapp connect/sign
// over `ws://127.0.0.1:9779` (dig-app SPEC §5.6), supplying the browser-COMMITTED tab origin.
// dig-app holds the key + raises the native confirm; the extension can request but never approve.
// -----------------------------------------------------------------------------------------------

import { ACTIONS } from '@/lib/messages';
import { createAppSignController, type AppSignController } from '@/lib/app-sign/app-sign-ws';
import { AppSignRelay, type ConnectParams, type SignParams } from '@/lib/app-sign/relay';
import { PairingStore, type KvStore } from '@/lib/app-sign/pairing-store';
import { AppSignError } from '@/lib/app-sign/errors';

/** The APP-SIGN action strings this module owns (a page-message `action` may match one of these). */
const APP_SIGN_ACTIONS: readonly string[] = [
  ACTIONS.appSignStatus,
  ACTIONS.appSignPair,
  ACTIONS.appSignUnpair,
  ACTIONS.appSignConnect,
  ACTIONS.appSignSign,
];

/** A dependency-injected broadcast of a runtime message to every extension surface (popup, tabs). */
export type BroadcastRuntime = (message: { action: string; [key: string]: unknown }) => void;

/** The subset of an inbound runtime message the APP-SIGN dispatcher reads. */
interface AppSignMessage {
  action?: string;
  params?: ConnectParams & SignParams;
}

/** The APP-SIGN dispatcher the SW wires into its `chrome.runtime.onMessage` listener. */
export interface AppSignHandler {
  /** True when `action` is one this dispatcher handles — the SW gate before delegating. */
  handles(action: string | undefined): boolean;
  /**
   * Dispatch one APP-SIGN message. Returns `true` (the async-`sendResponse` contract) when it took
   * the message, `false` when `action` is not an APP-SIGN action and the SW should keep matching.
   */
  handle(
    message: AppSignMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean;
}

/** A thin `chrome.storage.local` adapter satisfying the chrome-free {@link KvStore}. */
const appSignKv: KvStore = {
  get: async (key) => (await chrome.storage.local.get(key))[key],
  set: async (key, value) => chrome.storage.local.set({ [key]: value }),
  remove: async (key) => chrome.storage.local.remove(key),
};

/**
 * Build the APP-SIGN relay + connection controller and return the SW-facing message dispatcher.
 * Starts the WS controller's connect/reconnect loop (guarded — some test contexts have no
 * `WebSocket`). `broadcastRuntime` is injected so the frozen SW keeps ownership of its own
 * cross-surface broadcast helper.
 */
export function createAppSignHandler(deps: { broadcastRuntime: BroadcastRuntime }): AppSignHandler {
  const { broadcastRuntime } = deps;

  const controller: AppSignController = createAppSignController({
    onConnStateChange: (connState) => broadcastRuntime({ action: 'appSignConnStateChanged', connState }),
  });
  const relay = new AppSignRelay({
    controller,
    pairingStore: new PairingStore(appSignKv),
    // The Origin header the browser sends on the WS handshake is `chrome-extension://<this id>`;
    // dig-app pins it, so `pair.begin` must vouch the same value (SPEC §5.6.2/§5.6.3).
    extId: `chrome-extension://${chrome.runtime.id}`,
    extLabel: 'DIG Browser Extension',
  });
  try {
    controller.start();
  } catch {
    /* no WebSocket in some test contexts */
  }

  const handles = (action: string | undefined): boolean =>
    typeof action === 'string' && APP_SIGN_ACTIONS.includes(action);

  const handle: AppSignHandler['handle'] = (message, sender, sendResponse) => {
    if (!handles(message.action)) return false;
    // A uniform `{ ok, data?, code? }` envelope; on failure `code` is the §5.6.7 (or transport)
    // AppSignError code the UI keys its messaging off (§6.2). The connect/sign handlers derive the
    // dapp origin from `sender.origin` — the browser-COMMITTED, page-unspoofable origin — NEVER from
    // the message payload: the true-origin passthrough that closes the "loopback cannot authenticate
    // the caller" gap (SPEC §7.1 "Origin spoof").
    void (async () => {
      const committedOrigin = sender && sender.origin ? sender.origin : null;
      try {
        if (message.action === ACTIONS.appSignStatus) {
          sendResponse({ ok: true, data: { paired: await relay.isPaired(), connState: controller.getConnState() } });
        } else if (message.action === ACTIONS.appSignPair) {
          await relay.pair();
          sendResponse({ ok: true });
        } else if (message.action === ACTIONS.appSignUnpair) {
          await relay.unpair();
          sendResponse({ ok: true });
        } else if (message.action === ACTIONS.appSignConnect) {
          if (!committedOrigin) throw new AppSignError('CONNECT_REQUIRED', 'no committed sender origin');
          sendResponse({ ok: true, data: await relay.connect(committedOrigin, message.params ?? {}) });
        } else if (message.action === ACTIONS.appSignSign) {
          if (!committedOrigin) throw new AppSignError('CONNECT_REQUIRED', 'no committed sender origin');
          sendResponse({ ok: true, data: await relay.sign(committedOrigin, (message.params ?? {}) as SignParams) });
        }
      } catch (e) {
        const code = e instanceof AppSignError ? e.code : 'BAD_RESPONSE';
        // `success:false` lets the RTK chromeBaseQuery surface this as an `isError` state keyed on
        // `code`; `ok:false` is the parallel shape the raw (non-RTK) callers + e2e branch on.
        try {
          sendResponse({ ok: false, success: false, code, message: (e instanceof Error ? e.message : String(e)) });
        } catch {
          /* port closed */
        }
      }
    })();
    return true; // async
  };

  return { handles, handle };
}
