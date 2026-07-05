import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import '@/styles/fonts';
import '@/styles/theme.css';
import { store } from '@/app/store';
import { publishVersionGlobal } from '@/lib/version';
import { ApprovalRoot } from '@/features/wallet/custody/ApprovalWindow';

/**
 * The dApp approval window entry (#56 §5.5) — a dedicated, trusted popup the service worker summons
 * via `chrome.windows.create` when a webpage's `window.chia` asks the custody wallet to sign. Thin
 * glue: the Redux store provider around {@link ApprovalRoot} (which binds the locale + renders the
 * window); coverage-excluded (src/entries/**).
 */
publishVersionGlobal();
const el = document.getElementById('root');
if (el) {
  createRoot(el).render(
    <StrictMode>
      <Provider store={store}>
        <ApprovalRoot />
      </Provider>
    </StrictMode>,
  );
}
