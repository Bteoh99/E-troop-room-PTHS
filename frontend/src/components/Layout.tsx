import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type SVGProps } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { takeFlash } from '../lib/flash';
import { focusIsFree, isRouteFocusPending, markRouteChange, setAnnouncer } from '../lib/routeFocus';
import { MapIcon, PlusIcon, SearchIcon, TentIcon, UploadIcon } from './Icons';

interface NavEntry {
  to: string;
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  isActive: (path: string) => boolean;
}

const NAV: NavEntry[] = [
  {
    to: '/',
    label: 'Search',
    Icon: SearchIcon,
    isActive: (p) => p === '/' || (/^\/items\/[^/]+(\/edit)?$/.test(p) && p !== '/items/new'),
  },
  { to: '/map', label: 'Map', Icon: MapIcon, isActive: (p) => p.startsWith('/map') || p.startsWith('/racks') },
  { to: '/items/new', label: 'Add', Icon: PlusIcon, isActive: (p) => p === '/items/new' },
  { to: '/import', label: 'Import', Icon: UploadIcon, isActive: (p) => p.startsWith('/import') },
];

export function Layout() {
  const location = useLocation();
  const [flash, setFlash] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const mainRef = useRef<HTMLElement>(null);
  const lastPath = useRef(location.pathname);

  // One-off messages ("Changes saved.") queued by pages via showFlash() before navigating.
  useEffect(() => {
    const message = takeFlash();
    if (message) setFlash(message);
  }, [location.key]);

  // Route-change focus: mark the change before pages' effects run (layout effect),
  // so the new page's <PageHeading> can take focus when it mounts.
  useLayoutEffect(() => {
    if (lastPath.current === location.pathname) return;
    lastPath.current = location.pathname;
    markRouteChange();
  }, [location.pathname]);

  // Fallback while the page has no heading yet (e.g. still loading): park focus on <main>.
  useEffect(() => {
    if (isRouteFocusPending() && focusIsFree(mainRef.current)) mainRef.current?.focus({ preventScroll: true });
  }, [location.pathname]);

  useEffect(() => {
    setAnnouncer(setAnnouncement);
    return () => setAnnouncer(null);
  }, []);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 5000);
    return () => clearTimeout(t);
  }, [flash]);

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar__inner">
          <Link to="/" className="brand" aria-label="e-Troop Store Room, home">
            <span className="brand__mark">
              <TentIcon />
            </span>
            <span className="brand__text">
              e-Troop <span className="brand__sub">Store Room</span>
            </span>
          </Link>
          <nav className="tabbar" aria-label="Main">
            <ul>
              {NAV.map(({ to, label, Icon, isActive }) => {
                const active = isActive(location.pathname);
                return (
                  <li key={to}>
                    <Link
                      to={to}
                      className={`tabbar__link${active ? ' is-active' : ''}`}
                      aria-current={active ? 'page' : undefined}
                    >
                      <Icon className="tabbar__icon" />
                      <span>{label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>
      </header>

      <div className="flash-region" role="status" aria-live="polite">
        {flash && (
          <div className="flash">
            <span>{flash}</span>
            <button type="button" className="flash__close" onClick={() => setFlash(null)} aria-label="Dismiss message">
              ×
            </button>
          </div>
        )}
      </div>

      <p className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>

      <main id="main" ref={mainRef} className="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
