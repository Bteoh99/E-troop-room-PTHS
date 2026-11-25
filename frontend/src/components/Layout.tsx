import { useEffect, useState, type ComponentType, type SVGProps } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { MapIcon, PlusIcon, SearchIcon, TentIcon, UploadIcon } from './Icons';

interface NavEntry {
  to: string;
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  isActive: (path: string) => boolean;
}

const NAV: NavEntry[] = [
  { to: '/', label: 'Search', Icon: SearchIcon, isActive: (p) => p === '/' || /^\/items\/\d+$/.test(p) },
  { to: '/map', label: 'Map', Icon: MapIcon, isActive: (p) => p.startsWith('/map') || p.startsWith('/racks') },
  { to: '/items/new', label: 'Add', Icon: PlusIcon, isActive: (p) => p === '/items/new' },
  { to: '/import', label: 'Import', Icon: UploadIcon, isActive: (p) => p.startsWith('/import') },
];

export interface FlashState {
  flash?: string;
}

export function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [flash, setFlash] = useState<string | null>(null);

  // Pick up one-off messages passed via navigation state (e.g. "Item saved"),
  // then clear them from history so they don't reappear on back/forward.
  const incoming = (location.state as FlashState | null)?.flash;
  useEffect(() => {
    if (!incoming) return;
    setFlash(incoming);
    navigate(location.pathname + location.search, { replace: true, state: null });
  }, [incoming, location.pathname, location.search, navigate]);

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

      <main id="main" className="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
