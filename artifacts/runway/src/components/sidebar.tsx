import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { ChevronLeft, Command, Menu, X } from 'lucide-react';

import { NAV_ITEMS } from '@/lib/nav';
import { useChainStatus } from '@/lib/chain-status';
import { NETWORK_LABEL } from '@/lib/chain';

/** Desktop collapses to an icon rail; below this the sidebar becomes a drawer. */
const MOBILE_BREAKPOINT = 900;
const COLLAPSE_KEY = 'runway-sidebar-collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

export function Sidebar({
  collapsed,
  onToggleCollapse,
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const [location] = useLocation();
  const { data } = useChainStatus();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT,
  );
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`);
    const apply = () => setIsMobile(query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  // Close the drawer whenever the route changes.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location]);

  // Lock body scroll and trap focus while the drawer is open.
  useEffect(() => {
    if (!drawerOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    drawerRef.current?.querySelector<HTMLAnchorElement>('a')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKey);
    };
  }, [drawerOpen]);

  const isActive = (path: string) =>
    path === '/' ? location === '/' : location.startsWith(path);

  const links = (
    <nav className="side-nav" aria-label="Primary">
      {NAV_ITEMS.map(({ path, label, icon: Icon, count }) => {
        const value = count?.(data);
        const active = isActive(path);
        return (
          <a
            key={path}
            href={path}
            className={`nav-link ${active ? 'active' : ''}`}
            aria-current={active ? 'page' : undefined}
            data-testid={`nav-${label.toLowerCase()}`}
            title={collapsed && !isMobile ? label : undefined}
          >
            <Icon size={16} strokeWidth={1.7} aria-hidden />
            <span className="nav-label-text">{label}</span>
            {value !== null && value !== undefined && (
              <span className="nav-count">{value}</span>
            )}
          </a>
        );
      })}
    </nav>
  );

  const brand = (
    <a className="brand" href="/" data-testid="brand-runway">
      <span className="brand-mark" aria-hidden>
        <Command size={18} strokeWidth={2.1} />
      </span>
      <span className="brand-text">
        <span className="brand-name">runway</span>
        <span className="brand-caption">protocol operations</span>
      </span>
    </a>
  );

  const networkCard = (
    <div className="sidebar-bottom">
      <div className="nav-label">Network</div>
      <div className="chain-card" data-testid="status-network">
        <div className="chain-card-title">
          <span className="chain-dot" aria-hidden />{NETWORK_LABEL}
        </div>
        <p className="chain-caption">
          {data ? (
            <>
              Live &middot; block {data.block.toLocaleString()}
              <br />
              {data.summary.splitters} splitter &middot; {data.summary.openLoans} open
            </>
          ) : (
            <>Reading chain state&hellip;</>
          )}
        </p>
      </div>
      <p className="prototype-note">
        Prototype only. Not audited. Read from chain, never from configuration.
      </p>
    </div>
  );

  if (isMobile) {
    return (
      <>
        <header className="mobile-bar">
          <button
            type="button"
            className="icon-button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            aria-controls="runway-drawer"
            data-testid="button-open-nav"
          >
            <Menu size={18} />
          </button>
          {brand}
          <span className="testnet-pill mobile-pill">
            <span className="tiny-dot" aria-hidden />
            {NETWORK_LABEL}
          </span>
        </header>

        {drawerOpen && (
          <div className="drawer-overlay" onClick={() => setDrawerOpen(false)}>
            <div
              className="sidebar drawer"
              id="runway-drawer"
              ref={drawerRef}
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="drawer-head">
                {brand}
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => setDrawerOpen(false)}
                  aria-label="Close navigation"
                  data-testid="button-close-nav"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="nav-label">Workspace</div>
              {links}
              {networkCard}
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <aside
      className={`sidebar ${collapsed ? 'collapsed' : ''}`}
      aria-label="Primary navigation"
    >
      <div className="sidebar-head">
        {brand}
        <button
          type="button"
          className="icon-button sidebar-toggle"
          onClick={onToggleCollapse}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          data-testid="button-toggle-sidebar"
        >
          <ChevronLeft size={16} className={collapsed ? 'flip' : ''} />
        </button>
      </div>
      {!collapsed && <div className="nav-label">Workspace</div>}
      {links}
      {networkCard}
    </aside>
  );
}
