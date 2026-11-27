import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type SVGProps } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useLeader } from '../leader/LeaderContext';
import { takeFlash } from '../lib/flash';
import { focusIsFree, isRouteFocusPending, markRouteChange, setAnnouncer } from '../lib/routeFocus';
import { CameraIcon, MapIcon, PlusIcon, SearchIcon, TentIcon, UploadIcon } from './Icons';

interface NavEntry {
  to: string;
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  isActive: (path: string) => boolean;
  /** Needs leader mode: when locked, tapping asks for the PIN first, then continues. */
  leaderOnly?: boolean;
}

const NAV: NavEntry[] = [
  {
    to: '/',
    label: 'Search',
    Icon: SearchIcon,
    isActive: (p) => p === '/' || (/^\/items\/[^/]+(\/edit)?$/.test(p) && p !== '/items/new'),
  },
  { to: '/scan', label: 'Scan', Icon: CameraIcon, isActive: (p) => p.startsWith('/scan') },
  {
    to: '/map',
    label: 'Map',
    Icon: MapIcon,
    isActive: (p) => p.startsWith('/map') || p.startsWith('/racks') || p.startsWith('/locate'),
  },
  { to: '/items/new', label: 'Add', Icon: PlusIcon, isActive: (p) => p === '/items/new', leaderOnly: true },
  { to: '/import', label: 'Import', Icon: UploadIcon, isActive: (p) => p.startsWith('/import'), leaderOnly: true },
];

export function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { leader, requireLeader, unlock, lock, pinNotice, dismissPinNotice } = useLeader();
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
              {NAV.map(({ to, label, Icon, isActive, leaderOnly }) => {
                const active = isActive(location.pathname);
                return (
                  <li key={to}>
                    <Link
                      to={to}
                      className={`tabbar__link${active ? ' is-active' : ''}`}
                      aria-current={active ? 'page' : undefined}
                      onClick={
                        leaderOnly && !leader
                          ? (e) => {
                              e.preventDefault();
                              void requireLeader().then((ok) => ok && navigate(to));
                            }
                          : undefined
                      }
                    >
                      <Icon className="tabbar__icon" />
                      <span>{label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          <button
            type="button"
            className={`leader-btn${leader ? ' is-on' : ''}`}
            onClick={leader ? lock : unlock}
            aria-label={leader ? 'Leader mode on. Lock' : 'Leader mode off. Unlock with PIN'}
            data-testid="leader-button"
          >
            <span aria-hidden="true">{leader ? '🔓' : '🔒'}</span>
            {/* Visible words are part of the accessible name (WCAG 2.5.3): "Leader mode on. Lock" / "Leader mode off. …". */}
            <span className="leader-btn__text">
              {leader ? (
                <>
                  <span className="leader-btn__long">Leader mode </span>on · Lock
                </>
              ) : (
                'Leader'
              )}
            </span>
          </button>
        </div>
      </header>

      {pinNotice && (
        <div className="flash-region">
          <div className="flash flash--warn" data-testid="pin-notice">
            <span>
              <span aria-hidden="true">⚠ </span>
              {pinNotice}
            </span>
            <button type="button" className="flash__close" onClick={dismissPinNotice} aria-label="Dismiss PIN notice">
              ×
            </button>
          </div>
        </div>
      )}

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
