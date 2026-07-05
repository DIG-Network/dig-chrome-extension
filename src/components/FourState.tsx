import type { ReactNode } from 'react';
import { FormattedMessage } from 'react-intl';

interface FourStateProps {
  isLoading: boolean;
  isError: boolean;
  isEmpty: boolean;
  onRetry?: () => void;
  /** Message id for the loading label (defaults to the generic). */
  loadingId?: string;
  /** Message id for the error label (defaults to the generic). */
  errorId?: string;
  /** Message id for the empty label (defaults to the generic). */
  emptyId?: string;
  /** Optional custom skeleton to show while loading (defaults to shimmer rows). */
  skeleton?: ReactNode;
  /** Stable test hook prefix for the rendered state. */
  testid?: string;
  children: ReactNode;
}

/**
 * Render exactly one of the four async states (§6.4): loading → skeleton, error → recoverable
 * (retry + honest copy), empty → real empty-state, success → children. Copy flows through
 * react-intl; the current state is exposed as `data-state` so it's agent-driveable and screen-
 * readers get a polite live region for loading/error.
 */
export function FourState({
  isLoading,
  isError,
  isEmpty,
  onRetry,
  loadingId = 'state.loading',
  errorId = 'state.error.generic',
  emptyId = 'state.empty.generic',
  skeleton,
  testid,
  children,
}: FourStateProps) {
  if (isLoading) {
    return (
      <div className="dig-state" role="status" aria-live="polite" data-state="loading" data-testid={testid && `${testid}-loading`}>
        {skeleton ?? (
          <div style={{ width: '100%' }}>
            <div className="dig-skeleton" />
            <div className="dig-skeleton" />
            <div className="dig-skeleton" />
          </div>
        )}
        <span className="dig-muted">
          <FormattedMessage id={loadingId} />
        </span>
      </div>
    );
  }
  if (isError) {
    return (
      <div className="dig-state" role="alert" data-state="error" data-testid={testid && `${testid}-error`}>
        <p>
          <FormattedMessage id={errorId} />
        </p>
        {onRetry && (
          <button type="button" className="dig-btn" onClick={onRetry} data-testid={testid && `${testid}-retry`}>
            <FormattedMessage id="state.retry" />
          </button>
        )}
      </div>
    );
  }
  if (isEmpty) {
    return (
      <div className="dig-state" data-state="empty" data-testid={testid && `${testid}-empty`}>
        <FormattedMessage id={emptyId} />
      </div>
    );
  }
  return <>{children}</>;
}
