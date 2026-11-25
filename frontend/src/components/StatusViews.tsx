import type { ReactNode } from 'react';
import { ApiError } from '../api/client';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="status status--loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({
  error,
  title = 'Something went wrong',
  onRetry,
}: {
  error: Error;
  title?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="status status--error" role="alert">
      <p className="status__title">{title}</p>
      <p>{error.message}</p>
      {onRetry && (
        <button type="button" className="btn btn--secondary" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, children, icon = '🏕️' }: { title: string; children?: ReactNode; icon?: string }) {
  return (
    <div className="status status--empty">
      <span className="status__icon" aria-hidden="true">
        {icon}
      </span>
      <p className="status__title">{title}</p>
      {children}
    </div>
  );
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}
