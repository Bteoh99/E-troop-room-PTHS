import type { ReactNode } from 'react';
import { ApiError } from '../api/client';
import { PageHeading } from './PageHeading';

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

export function EmptyState({
  title,
  children,
  icon = '🏕️',
  pageHeading = false,
}: {
  title: string;
  children?: ReactNode;
  icon?: string;
  /** Render the title as the page's <h1> (for whole-page states such as "not found"). */
  pageHeading?: boolean;
}) {
  return (
    <div className="status status--empty">
      <span className="status__icon" aria-hidden="true">
        {icon}
      </span>
      {pageHeading ? (
        <PageHeading className="status__title">{title}</PageHeading>
      ) : (
        <p className="status__title">{title}</p>
      )}
      {children}
    </div>
  );
}

/**
 * True for "this thing doesn't exist" answers when loading a page's main record:
 * 404, or 400 (the backend's answer for an id/rack that isn't valid at all, e.g. /items/abc).
 */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 400);
}

/** Rejects like the API would for a URL parameter that can never exist (saves a pointless request). */
export function notFoundError(message = 'Not found'): ApiError {
  return new ApiError(message, 404);
}
