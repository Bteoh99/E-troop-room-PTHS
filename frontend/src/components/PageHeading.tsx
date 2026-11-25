import { useEffect, useRef, type ReactNode } from 'react';
import { announce, consumeRouteFocus, focusIsFree } from '../lib/routeFocus';

/**
 * The page's <h1>. After an in-app route change it receives focus so keyboard and
 * screen-reader users start at the new page's title (and hear it).
 */
export function PageHeading({ children, className = 'page__title' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!consumeRouteFocus()) return;
    const h1 = ref.current;
    if (!h1) return;
    if (focusIsFree(document.getElementById('main'))) {
      h1.focus({ preventScroll: false });
    } else {
      announce(h1.textContent ?? '');
    }
  }, []);

  return (
    <h1 ref={ref} className={className} tabIndex={-1}>
      {children}
    </h1>
  );
}
