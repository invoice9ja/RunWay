import { useEffect, useState, type ReactNode } from 'react';

import { Sidebar } from '@/components/sidebar';
import { useChainStatus } from '@/lib/chain-status';

const COLLAPSE_KEY = 'runway-sidebar-collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  action,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  action?: ReactNode;
}) {
  const { data, error, loading } = useChainStatus();
  return (
    <div className="page-heading">
      <div className="page-heading-main">
        <div className="eyebrow">
          <span className="eyebrow-line" aria-hidden />
          {eyebrow}
        </div>
        <h1>{title}</h1>
        <p className="page-subtitle">{subtitle}</p>
      </div>
      <div className="page-heading-side">
        {action}
        <div className="last-read" data-testid="status-live-data">
          {data
            ? `LIVE CHAIN DATA / BLOCK ${data.block.toLocaleString()}`
            : error
              ? 'CHAIN READ FAILED'
              : loading
                ? 'READING CHAIN'
                : 'IDLE'}
        </div>
      </div>
    </div>
  );
}

export function ChainNotice() {
  const { data, error } = useChainStatus();
  return (
    <div className="notice-strip" role="status" data-testid="notice-chain-data">
      <div className="notice-copy">
        {data ? (
          <>
            <strong>Live Arc testnet state.</strong> Every figure on this page is a
            direct contract read served by <code>/api/status</code> at block{' '}
            {data.block.toLocaleString()}.
          </>
        ) : error ? (
          <>
            <strong>Chain read failed.</strong> {error}
          </>
        ) : (
          <>
            <strong>Reading chain state.</strong> Loading vault, splitter and
            advance data from Arc testnet.
          </>
        )}
      </div>
      <div className="notice-meta">
        {data ? 'CHAIN STATE: LIVE' : 'CHAIN STATE: LOADING'}
      </div>
    </div>
  );
}

export function EmptyState({
  label,
  detail,
  id,
}: {
  label: string;
  detail: string;
  id: string;
}) {
  return (
    <div className="table-empty" data-testid={`empty-${id}`}>
      <div className="empty-title">{label}</div>
      <p className="empty-copy">{detail}</p>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* storage unavailable; the toggle still works for this session */
    }
  }, [collapsed]);

  return (
    <div className={`app-shell ${collapsed ? 'nav-collapsed' : ''}`}>
      <Sidebar collapsed={collapsed} onToggleCollapse={() => setCollapsed((v) => !v)} />
      <div className="main-area">{children}</div>
    </div>
  );
}

export function PageFooter() {
  return (
    <footer className="footer-line">
      <span>
        <strong>RUNWAY</strong> / Arc testnet operations desk
      </span>
      <span>Live chain reads via /api/status</span>
    </footer>
  );
}
