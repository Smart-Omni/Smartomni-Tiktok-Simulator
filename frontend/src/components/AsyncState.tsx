import type { ReactNode } from 'react';
import { CircleAlert, Inbox, LoaderCircle } from 'lucide-react';
import { ApiError } from '../lib/api';

interface Props<T> {
  data: T | undefined;
  loading: boolean;
  error: Error | undefined;
  /** Return true when the loaded data should render the empty state. */
  isEmpty?: (data: T) => boolean;
  emptyText?: string;
  onRetry?: () => void;
  children: (data: T) => ReactNode;
}

/** One consistent loading / error / empty treatment for every list and panel. */
export function AsyncState<T>({ data, loading, error, isEmpty, emptyText = 'Nothing here yet.', onRetry, children }: Props<T>) {
  if (loading && data === undefined) return (
    <div className="state state-loading" role="status">
      <LoaderCircle className="state-icon state-spinner" aria-hidden="true" />
      <span>Loading...</span>
    </div>
  );
  if (error && data === undefined) {
    return (
      <div className="state state-error" role="alert">
        <CircleAlert className="state-icon" aria-hidden="true" />
        <div className="state-copy">
          <strong>Something went wrong.</strong>
          <div>{error.message}</div>
          {error instanceof ApiError && error.requestId ? <div className="muted">request id: {error.requestId}</div> : null}
        </div>
        {onRetry ? <button type="button" onClick={onRetry}>Retry</button> : null}
      </div>
    );
  }
  if (data === undefined) return null;
  if (isEmpty?.(data)) return (
    <div className="state state-empty" role="status">
      <Inbox className="state-icon" aria-hidden="true" />
      <span>{emptyText}</span>
    </div>
  );
  return <>{children(data)}</>;
}
