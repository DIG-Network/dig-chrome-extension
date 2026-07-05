import { useCallback, useRef, useState } from 'react';
import { api } from '@/api/api';
import { useAppDispatch } from '@/app/hooks';
import { useTransport } from '@/app/TransportContext';

type ConnectPhase = 'idle' | 'pairing' | 'error';

/**
 * Drive the WalletConnect pairing flow from the page: start pairing (surface the `wc:` URI as a QR
 * for the user to scan in Sage), await approval, then invalidate the connection/balances/activity
 * cache so the UI converges on the live session. Kept as a hook (not an RTK mutation) because
 * pairing is a two-phase flow that must render the URI while awaiting approval.
 */
export function useWalletConnect() {
  const transport = useTransport();
  const dispatch = useAppDispatch();
  const [phase, setPhase] = useState<ConnectPhase>('idle');
  const [uri, setUri] = useState<string>('');
  const [error, setError] = useState<string>('');
  const busy = useRef(false);

  const connect = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setPhase('pairing');
    setError('');
    setUri('');
    try {
      const { uri: pairUri, approval } = await transport.connect();
      setUri(pairUri);
      await approval();
      dispatch(api.util.invalidateTags(['Connection', 'Balances', 'Activity']));
      setPhase('idle');
      setUri('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    } finally {
      busy.current = false;
    }
  }, [transport, dispatch]);

  const reset = useCallback(() => {
    setPhase('idle');
    setUri('');
    setError('');
  }, []);

  return { phase, uri, error, connect, reset };
}
