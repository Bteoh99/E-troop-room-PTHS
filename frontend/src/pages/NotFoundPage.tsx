import { Link } from 'react-router-dom';
import { EmptyState } from '../components/StatusViews';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function NotFoundPage() {
  useDocumentTitle('Page not found');
  return (
    <div className="page">
      <EmptyState title="This page doesn't exist" icon="🧭">
        <p>Looks like this trail is a dead end.</p>
        <Link to="/" className="btn btn--primary">
          Go to search
        </Link>
      </EmptyState>
    </div>
  );
}
