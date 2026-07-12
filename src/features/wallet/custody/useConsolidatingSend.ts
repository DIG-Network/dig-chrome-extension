import { useCallback, useRef, useState } from 'react';
import {
  usePrepareSendMutation,
  usePrepareConsolidationMutation,
  useConfirmSendMutation,
  useLazySendStatusQuery,
  type PreparedSend,
} from '@/features/wallet/custodyApi';
import { runWithConsolidation, ConsolidationTimeoutError, type ConsolidateQuote } from './consolidateLoop';
import type { ConsolidateModalState } from './ConsolidateModal';

/**
 * The React glue for the #417 auto-consolidate loop: it wraps `prepareSend` so a coin-fragmented
 * wallet transparently combines coins (with an honest, dismissible modal) and retries, instead of
 * failing. It owns the modal state + the pending-prompt resolver, and maps the loop's terminal
 * errors to stable codes the send screen turns into localized messages. The orchestration logic
 * lives in the pure {@link runWithConsolidation}; this hook only wires the RTK mutations to it.
 *
 * The spend path stays vault→coinset (self-custody, #399/#407/#217) — this hook never touches the
 * node wallet-source.
 */

/** The send arguments forwarded to `prepareSend` (mirrors its mutation arg). */
export interface SendRequest {
  recipient: string;
  amount: string;
  fee?: string;
  assetId?: string;
  coinIds?: string[];
  clawbackSeconds?: string;
  memo?: string;
}

/** The result of a consolidating prepare: the prepared send, or a stable failure code. */
export type PrepareOutcome = { ok: true; prepared: PreparedSend } | { ok: false; code: string };

/** Map any thrown value to a stable failure code the send screen branches on. */
export function errorCode(e: unknown): string {
  if (e instanceof ConsolidationTimeoutError) return 'CONSOLIDATION_TIMEOUT';
  if (e && typeof e === 'object' && 'code' in e && typeof (e as { code?: unknown }).code === 'string') {
    return (e as { code: string }).code;
  }
  return 'BUILD';
}

export function useConsolidatingSend({ pollMs = 8000, maxPolls = 15 }: { pollMs?: number; maxPolls?: number } = {}) {
  const [prepareSend] = usePrepareSendMutation();
  const [prepareConsolidation] = usePrepareConsolidationMutation();
  const [confirmSend] = useConfirmSendMutation();
  const [pollStatus] = useLazySendStatusQuery();
  const [modal, setModal] = useState<ConsolidateModalState>({ open: false, phase: 'idle', quote: null });
  const [running, setRunning] = useState(false);
  const resolveRef = useRef<((ok: boolean) => void) | null>(null);

  /** The modal's Combine (true) / Not-now (false) buttons settle the pending consent here. */
  const resolvePrompt = useCallback((ok: boolean) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    resolve?.(ok);
  }, []);

  const prepare = useCallback(
    async (req: SendRequest): Promise<PrepareOutcome> => {
      setRunning(true);
      try {
        const prepared = await runWithConsolidation<PreparedSend>({
          attempt: () => prepareSend(req).unwrap(),
          isNeedsConsolidation: (e) => errorCode(e) === 'NEEDS_CONSOLIDATION',
          buildConsolidation: async () => {
            try {
              const r = await prepareConsolidation(req.assetId ? { assetId: req.assetId } : {}).unwrap();
              return {
                pendingId: r.pendingId,
                quote: { asset: r.coinOpSummary.asset, coinsMerged: r.coinOpSummary.inputCoinCount, fee: r.coinOpSummary.fee },
              };
            } catch {
              return null; // nothing combinable → surface the original signal honestly
            }
          },
          prompt: (quote: ConsolidateQuote) =>
            new Promise<boolean>((resolve) => {
              resolveRef.current = resolve;
              setModal({ open: true, phase: 'prompting', quote });
            }),
          confirm: async (pendingId) => (await confirmSend({ pendingId }).unwrap()).spentCoinId,
          awaitConfirmation: async (coinId) => {
            for (let i = 0; i < maxPolls; i++) {
              const res = await pollStatus({ coinId });
              if ('data' in res && res.data?.confirmed) return true;
              await new Promise((r) => setTimeout(r, pollMs));
            }
            return false;
          },
          onPhase: (phase) =>
            setModal((m) => (phase === 'idle' ? { open: false, phase, quote: null } : { open: true, phase, quote: m.quote })),
        });
        return { ok: true, prepared };
      } catch (e) {
        return { ok: false, code: errorCode(e) };
      } finally {
        setRunning(false);
        setModal({ open: false, phase: 'idle', quote: null });
      }
    },
    [prepareSend, prepareConsolidation, confirmSend, pollStatus, pollMs, maxPolls],
  );

  return { prepare, modal, resolvePrompt, running };
}
