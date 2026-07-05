import { createContext, useContext, type ReactNode } from 'react';
import { wcTransport, type WalletTransport } from '@/features/wallet/transport';

const TransportContext = createContext<WalletTransport>(wcTransport);

/** Provide the wallet transport to the tree (the same instance the store uses). */
export function TransportProvider({
  transport,
  children,
}: {
  transport: WalletTransport;
  children: ReactNode;
}) {
  return <TransportContext.Provider value={transport}>{children}</TransportContext.Provider>;
}

/**
 * Access the wallet transport (pairing flow, direct calls).
 * (Co-located with its provider — HMR isn't used in the extension build, §3, so the react-refresh
 * "one component per file" hint doesn't apply.)
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useTransport(): WalletTransport {
  return useContext(TransportContext);
}
