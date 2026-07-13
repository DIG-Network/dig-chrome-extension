import { useCallback, useRef, useState } from 'react';
import { signPromptNeeded, DEFAULT_AUTH_STATUS, type AuthCredential } from '@/lib/node-auth';
import { useGetSignAuthorityQuery, useGetAuthStatusQuery, useSignUnlockMutation } from '@/features/security/securityApi';
import type { SignUnlockModalProps } from '@/features/security/SignUnlockModal';

/** What {@link useSignGate} returns: the guard entry point + the props for the per-tx unlock modal. */
export interface SignGate {
  /**
   * Wrap a signing operation. Runs `sign` immediately when NO fresh unlock is required — the node
   * is not the signer (local-vault custody, #374 off), or the session already covers signing
   * (`session_unlock_all` + unlocked). Otherwise it opens the per-transaction unlock prompt and runs
   * `sign` ONLY after `auth.sign_unlock` arms exactly one signature.
   */
  guard: (sign: () => void | Promise<void>) => void;
  /** Props to spread onto {@link SignUnlockModal} (render it once wherever the gate is used). */
  modal: SignUnlockModalProps;
}

/**
 * The per-transaction sign gate (SPEC §18.24, #431/#433). It is the SINGLE seam a signing UI uses so
 * that, when the dig-node is the custodian+signer, the unencrypted key never lingers: the DEFAULT
 * `per_transaction` mode re-prompts before EVERY signature (a fresh `auth.sign_unlock` arms exactly
 * one op, then the node re-zeroizes). `session_unlock_all` (opt-out) skips the prompt for the session.
 *
 * SAFE + INERT BY DEFAULT: when the node is NOT the signer (`getSignAuthority.nodeIsSigner` false —
 * the current default, local-vault custody), the gate is a pure passthrough and never prompts. It
 * becomes active only once the thin-client custody cutover (#374) makes the node the signer. Fail
 * secure: while the node's `auth.status` is unknown, the gate assumes the secure default
 * (per_transaction, locked ⇒ prompt required) rather than letting a signature through ungated.
 */
export function useSignGate(): SignGate {
  const { data: authority } = useGetSignAuthorityQuery();
  const nodeIsSigner = authority?.nodeIsSigner === true;
  const { data: status } = useGetAuthStatusQuery(undefined, { skip: !nodeIsSigner });
  const [signUnlock] = useSignUnlockMutation();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<null | (() => void | Promise<void>)>(null);

  // Fail-secure: an unknown status resolves to the SECURE default (per_transaction + locked), which
  // signPromptNeeded() treats as "prompt required".
  const effective = status ?? DEFAULT_AUTH_STATUS;

  const guard = useCallback(
    (sign: () => void | Promise<void>) => {
      if (!nodeIsSigner || !signPromptNeeded(effective)) {
        void sign();
        return;
      }
      pending.current = sign;
      setError(null);
      setBusy(false);
      setOpen(true);
    },
    [nodeIsSigner, effective],
  );

  const onSubmit = useCallback(
    async (cred: AuthCredential) => {
      setBusy(true);
      setError(null);
      const res = await signUnlock(cred);
      if ('data' in res) {
        // The node armed EXACTLY ONE signature — run the stashed op now (it consumes the grant).
        const run = pending.current;
        pending.current = null;
        setOpen(false);
        setBusy(false);
        if (run) void run();
      } else {
        // Wrong/expired/replayed credential (node 401) — recoverable: keep the prompt open, surface
        // the error, DON'T run the op or clear the pairing (see the SW `authRpc` dispatcher).
        setBusy(false);
        setError((res.error as { code?: string | number })?.code?.toString() ?? 'AUTH_FAILED');
      }
    },
    [signUnlock],
  );

  const onCancel = useCallback(() => {
    pending.current = null;
    setOpen(false);
    setBusy(false);
    setError(null);
  }, []);

  return {
    guard,
    modal: { open, method: effective.method, busy, error, onSubmit, onCancel },
  };
}
