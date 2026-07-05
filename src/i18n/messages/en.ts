/**
 * English (`en`) message catalog — the complete, authoritative copy set for the extension shell.
 * Every user-facing string is keyed here with a stable, namespaced id (§6.6); components reference
 * ids via `FormattedMessage`/`intl.formatMessage`, never inline English. Brand/scheme literals
 * ($DIG, XCH, chia://, DIGHUb, store/capsule) are preserved verbatim per SYSTEM.md.
 */
export const en: Record<string, string> = {
  // ── shell ──
  'shell.title': 'DIG Network',
  'shell.wallet.title': 'DIG Wallet',
  'shell.popout': 'Open in full window',
  'shell.settings': 'DIG settings',
  'shell.version': 'Version {version}',
  'shell.language': 'Language',

  // ── tabs ──
  'tab.resolver': 'Resolver',
  'tab.wallet': 'Wallet',
  'tab.shield': 'Shield',
  'tab.control': 'Control',
  'tab.apps': 'Apps',

  // ── generic four-state ──
  'state.loading': 'Loading…',
  'state.retry': 'Retry',
  'state.error.generic': 'Something went wrong.',
  'state.empty.generic': 'Nothing here yet.',

  // ── wallet: segmented + shared ──
  'wallet.view.home': 'Home',
  'wallet.view.activity': 'Activity',
  'wallet.view.trade': 'Trade',
  'wallet.connect.title': 'Connect your Chia wallet',
  'wallet.connect.body': 'Pair your Sage wallet to see balances, send, receive, and trade.',
  'wallet.connect.cta': 'Connect wallet',
  'wallet.connect.connecting': 'Connecting…',
  'wallet.disconnect': 'Disconnect',
  'wallet.connected.as': 'Connected as {address}',
  'wallet.portfolio.total': 'Total balance',
  'wallet.fiat.unavailable': 'Fiat value unavailable',
  'wallet.action.send': 'Send',
  'wallet.action.receive': 'Receive',
  'wallet.action.trade': 'Trade',
  'wallet.assets.title': 'Assets',
  'wallet.assets.loading': 'Loading balances…',
  'wallet.assets.error': "Couldn't load balances — retry",
  'wallet.assets.empty': 'No assets yet',
  'wallet.getdig': 'Get $DIG',
  'wallet.recent.title': 'Recent activity',
  'wallet.recent.seeall': 'See all',

  // ── wallet: activity ──
  'activity.title': 'Activity',
  'activity.loading': 'Loading recent activity…',
  'activity.error': "Couldn't load recent activity — retry",
  'activity.empty': 'No activity yet.',
  'activity.sent': 'Sent',
  'activity.received': 'Received',
  'activity.status.confirmed': 'Confirmed',
  'activity.status.pending': 'Pending',
  'activity.viewOnSpaceScan': 'View on SpaceScan',

  // ── wallet: send ──
  'send.title': 'Send',
  'send.asset': 'Asset',
  'send.amount': 'Amount',
  'send.max': 'Max',
  'send.recipient': 'Recipient address',
  'send.fee': 'Network fee (XCH, optional)',
  'send.submit': 'Review & send',
  'send.error.address': 'Enter a valid xch1… address',
  'send.error.amount': 'Enter a positive amount',
  'send.disabled': 'Connect a wallet to send.',

  // ── wallet: receive ──
  'receive.title': 'Receive',
  'receive.your.address': 'Your address',
  'receive.copy': 'Copy address',
  'receive.copied': 'Copied',
  'receive.empty': 'Connect a wallet to get your receive address.',

  // ── wallet: trade ──
  'trade.title': 'Trade',
  'trade.intro': 'Trades let you swap assets directly with anyone — no middleman.',
  'trade.give': 'You give',
  'trade.get': 'You get',
  'trade.make': 'Create trade',
  'trade.take.label': 'Paste a trade (offer1…)',
  'trade.take.inspect': 'Inspect',
  'trade.take.accept': 'Review & accept',
  'trade.error.invalid': 'This trade link is invalid or expired',
  'trade.disabled': 'Connect a wallet to trade.',

  // ── apps (#59) ──
  'apps.title': 'DIG dApp store',
  'apps.loading': 'Loading the DIG dApp store…',
  'apps.error': "Couldn't load the dApp store.",
  'apps.openTab': 'Open in a new tab',

  // ── resolver ──
  'resolver.title': 'chia:// resolver',
  'resolver.url.label': 'Open a chia:// address',
  'resolver.url.placeholder': 'chia://…',
  'resolver.go': 'Open',
  'resolver.toggle.label': 'chia:// resolution',
  'resolver.status.active': 'Active',
  'resolver.status.inactive': 'Inactive',
  'resolver.via.label': 'Resolving via',
  'resolver.via.loading': 'Checking node…',
  'resolver.node.label': 'Custom node',
  'resolver.node.placeholder': 'dig.local or host:port',
  'resolver.node.save': 'Save',

  // ── shield ──
  'shield.title': 'DIG Shields',
  'shield.loading': 'Checking verification…',
  'shield.empty': 'No verified content on this tab yet.',
  'shield.capsule': 'Capsule',
  'shield.verified': 'Verified ({count})',
  'shield.failed': 'Failed ({count})',
  'shield.allPassed': 'All resources verified against the on-chain root.',
  'shield.someFailed': 'Some resources failed verification.',

  // ── control ──
  'control.title': 'DIG Control Panel',
  'control.loading': 'Detecting your node…',
  'control.node.online': 'Your dig-node is running',
  'control.node.offline': 'No local dig-node detected',
  'control.install.cta': 'Download the dig-node',
  'control.openFull': 'Open the full Control Panel',
  'control.getBrowser': 'Get the DIG Browser',
};
