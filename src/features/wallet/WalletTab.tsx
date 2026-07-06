import { CustodyGate } from '@/features/wallet/custody/CustodyGate';
import { CustodyWallet } from '@/features/wallet/custody/CustodyWallet';

/**
 * The Wallet tab. The extension IS the wallet — self-custody is the ONLY path. The {@link CustodyGate}
 * lands first (reads the SW's authoritative lock state): no wallet → onboarding/CTA, locked → unlock,
 * unlocked → the custody-backed {@link CustodyWallet} (balances from the offscreen HD scan). There is
 * no WalletConnect/Sage broker fallback — dApp `window.chia` requests are served by the offscreen
 * vault + the SW approval window (see src/background/index.ts), not a paired external wallet.
 */
export function WalletTab() {
  return (
    <CustodyGate>
      <CustodyWallet />
    </CustodyGate>
  );
}
