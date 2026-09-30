import { useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import Status from '@/pages/status';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  Blocks,
  Check,
  ChevronRight,
  CircleDot,
  Command,
  FileCode2,
  Landmark,
  Layers3,
  ListFilter,
  RotateCcw,
  Save,
  ShieldAlert,
  Wallet,
} from 'lucide-react';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient();

function Home() {
  const sections = [
    { id: 'overview', label: 'Overview', icon: Activity },
    { id: 'configuration', label: 'Contracts', icon: FileCode2 },
    { id: 'splitters', label: 'Splitters', icon: Layers3, count: '—' },
    { id: 'loans', label: 'Loans', icon: Landmark, count: '—' },
    { id: 'repayments', label: 'Repayments', icon: ArrowDownRight, count: '—' },
    { id: 'transactions', label: 'Transactions', icon: Blocks },
  ];
  const getSaved = () => {
    try {
      const saved = localStorage.getItem('runway-contract-config');
      return saved ? JSON.parse(saved) as { vault: string; factory: string } : { vault: '', factory: '' };
    } catch {
      return { vault: '', factory: '' };
    }
  };
  const [activeSection, setActiveSection] = useState('overview');
  const [saved, setSaved] = useState(getSaved);
  const [draft, setDraft] = useState(getSaved);
  const [errors, setErrors] = useState<{ vault?: string; factory?: string }>({});
  const [feedback, setFeedback] = useState('');
  const [toast, setToast] = useState('');
  const configComplete = Boolean(saved.vault && saved.factory);
  const jumpTo = (id: string) => {
    setActiveSection(id);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const updateDraft = (field: 'vault' | 'factory', value: string) => {
    setDraft((current) => ({ ...current, [field]: value.trim() }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setFeedback('');
  };
  const saveConfig = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors: { vault?: string; factory?: string } = {};
    (['vault', 'factory'] as const).forEach((field) => {
      const address = draft[field];
      if (address && !/^0x[a-fA-F0-9]{40}$/.test(address)) nextErrors[field] = 'Enter a valid 0x address (42 characters).';
    });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    localStorage.setItem('runway-contract-config', JSON.stringify(draft));
    setSaved(draft);
    setFeedback('Configuration saved in this browser.');
    setToast('Contract configuration saved locally.');
    window.setTimeout(() => setToast(''), 3000);
  };
  const clearConfig = () => {
    localStorage.removeItem('runway-contract-config');
    setSaved({ vault: '', factory: '' });
    setDraft({ vault: '', factory: '' });
    setErrors({});
    setFeedback('Local contract configuration cleared.');
    setToast('Local contract configuration cleared.');
    window.setTimeout(() => setToast(''), 3000);
  };

  const nav = (mobile = false) => sections.map(({ id, label, icon: Icon, count }) => (
    <button
      key={id}
      type="button"
      onClick={() => jumpTo(id)}
      className={`nav-link ${activeSection === id ? 'active' : ''}`}
      data-testid={`nav-${id}`}
      aria-current={activeSection === id ? 'location' : undefined}
    >
      <Icon size={15} strokeWidth={1.7} />
      <span>{label}</span>
      {count && <span className="nav-count">{count}</span>}
      {mobile && activeSection === id && <span className="sr-only">Current section</span>}
    </button>
  ));

  const EmptyState = ({ label, detail, id }: { label: string; detail: string; id: string }) => (
    <div className="table-empty" data-testid={`empty-${id}`}>
      <div className="empty-mark"><ListFilter size={14} strokeWidth={1.7} /></div>
      <div className="empty-title">{label}</div>
      <div className="empty-copy">{detail}</div>
    </div>
  );

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand" data-testid="brand-runway">
          <div className="brand-mark"><Command size={18} strokeWidth={2.1} /></div>
          <div><div className="brand-name">runway</div><div className="brand-caption">protocol operations</div></div>
        </div>
        <div className="nav-label">Workspace</div>
        <nav className="side-nav">{nav()}</nav>
        <div className="sidebar-bottom">
          <div className="nav-label">Network</div>
          <div className="chain-card" data-testid="status-network">
            <div className="chain-card-title"><span className="chain-dot" />Arc Testnet</div>
            <div className="chain-caption">Reads not connected<br />Chain data unavailable</div>
          </div>
          <p className="prototype-note">Prototype only. Not audited. Values shown here are never inferred from configuration.</p>
        </div>
      </aside>
      <div className="main-area">
        <div className="mobile-header">
          <div className="brand">
            <div className="brand-mark"><Command size={16} /></div>
            <div><div className="brand-name">runway</div><div className="brand-caption">protocol operations</div></div>
          </div>
          <span className="topbar-proto">PROTOTYPE</span>
        </div>
        <nav className="mobile-nav" aria-label="Section navigation">{nav(true)}</nav>
        <header className="topbar">
          <div className="breadcrumb"><span>RUNWAY</span><ChevronRight size={13} /><strong>Operations</strong></div>
          <div className="topbar-right">
            <span className="topbar-proto">PROTOTYPE / NOT AUDITED</span>
            <span className="testnet-pill"><span className="tiny-dot" />Arc Testnet</span>
          </div>
        </header>
        <main className="content" id="overview">
          <div className="page-heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" />WORKING CAPITAL / CONTROL ROOM</div>
              <h1>Operations overview</h1>
              <p className="page-subtitle">x402 revenue routing and advance repayment on Arc Testnet.</p>
            </div>
            <div className="last-read" data-testid="status-live-data">LIVE CHAIN DATA&nbsp; / &nbsp;NOT CONNECTED</div>
          </div>
          <div className="notice-strip" role="status" data-testid="notice-chain-data">
            <div className="notice-icon"><CircleDot size={17} /></div>
            <div className="notice-copy"><strong>No chain data loaded.</strong> Contract reads are not connected in this prototype view. The ledgers below remain empty until values are read directly from Arc Testnet; contract addresses are configuration only.</div>
            <div className="notice-meta">CHAIN STATE: UNAVAILABLE</div>
          </div>
          <div className="metric-grid" aria-label="Protocol summary">
            {[
              { label: 'Active splitters', icon: Layers3, helper: 'Awaiting onchain reads' },
              { label: 'Open advances', icon: Landmark, helper: 'Awaiting onchain reads' },
              { label: 'Repaid to date', icon: ArrowDownRight, helper: 'Awaiting onchain reads' },
              { label: 'Seller receipts', icon: Wallet, helper: 'Awaiting onchain reads' },
            ].map(({ label, icon: Icon, helper }) => (
              <div className="metric" key={label} data-testid={`metric-${label.toLowerCase().replaceAll(' ', '-')}`}>
                <div className="metric-top"><span>{label}</span><Icon className="metric-icon" size={15} strokeWidth={1.7} /></div>
                <div className="metric-value">—</div><div className="metric-helper">{helper}</div>
              </div>
            ))}
          </div>

          <section className="section-card" id="configuration" data-testid="section-configuration">
            <div className="section-heading">
              <div className="section-title-wrap"><div className="section-icon"><FileCode2 size={16} /></div><div><div className="section-title">Contract configuration</div><div className="section-subtitle">Addresses saved locally; not chain state</div></div></div>
              <span className="section-kicker">LOCAL CONFIG</span>
            </div>
            <div className="config-body">
              {configComplete ? (
                <div className="saved-addresses" data-testid="saved-contract-addresses">
                  <div className="saved-address"><div className="saved-address-label">Vault</div><div className="saved-address-value" title={saved.vault}>{saved.vault}</div></div>
                  <div className="saved-address"><div className="saved-address-label">Factory</div><div className="saved-address-value" title={saved.factory}>{saved.factory}</div></div>
                </div>
              ) : null}
              <div className="config-intro">
                <p className="config-description">Add deployed vault and factory addresses to prepare the operations view. Saving only stores these values in this browser; it does not connect a wallet, validate a deployment, or trigger chain reads.</p>
                <div className="config-status"><span className="config-status-dot" />{configComplete ? 'ADDRESSES SAVED LOCALLY' : 'NOT CONFIGURED'}</div>
              </div>
              <form onSubmit={saveConfig} noValidate data-testid="form-contract-config">
                <div className="config-grid">
                  <label>
                    <span className="field-label">Vault contract <span className="field-hint">ARC TESTNET</span></span>
                    <input
                      className="address-input"
                      value={draft.vault}
                      onChange={(event) => updateDraft('vault', event.target.value)}
                      placeholder="0x…"
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={Boolean(errors.vault)}
                      aria-describedby={errors.vault ? 'vault-error' : undefined}
                      data-testid="input-vault-address"
                    />
                    {errors.vault && <div className="field-error" id="vault-error" data-testid="error-vault-address">{errors.vault}</div>}
                  </label>
                  <label>
                    <span className="field-label">Factory contract <span className="field-hint">ARC TESTNET</span></span>
                    <input
                      className="address-input"
                      value={draft.factory}
                      onChange={(event) => updateDraft('factory', event.target.value)}
                      placeholder="0x…"
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={Boolean(errors.factory)}
                      aria-describedby={errors.factory ? 'factory-error' : undefined}
                      data-testid="input-factory-address"
                    />
                    {errors.factory && <div className="field-error" id="factory-error" data-testid="error-factory-address">{errors.factory}</div>}
                  </label>
                </div>
                <div className="config-actions">
                  <button className="primary-button" type="submit" data-testid="button-save-config"><Save size={14} />Save configuration</button>
                  {configComplete && <button className="secondary-button" type="button" onClick={clearConfig} data-testid="button-clear-config"><RotateCcw size={13} />Clear saved addresses</button>}
                  {feedback && <span className="save-feedback" role="status" data-testid="status-config-feedback"><Check size={12} style={{ display: 'inline', marginRight: 4 }} />{feedback}</span>}
                </div>
              </form>
              <div className="deployment-row"><ShieldAlert size={15} /><span>Configuration and chain observations are separate. A saved address is not evidence of a deployed or verified contract.</span></div>
            </div>
          </section>

          <section className="section-card" id="splitters" data-testid="section-splitters">
            <div className="section-heading"><div className="section-title-wrap"><div className="section-icon"><Layers3 size={16} /></div><div><div className="section-title">Splitters</div><div className="section-subtitle">Seller routing contracts discovered from the factory</div></div></div><span className="section-kicker">CHAIN READ</span></div>
            <div className="table-head splitter-table"><span>Seller</span><span>Splitter</span><span>Advance</span><span>Receipts</span><span>Explorer</span></div>
            <EmptyState id="splitters" label="No splitters read" detail="Factory contract reads will populate this list after deployment." />
          </section>

          <section className="section-card" id="loans" data-testid="section-loans">
            <div className="section-heading"><div className="section-title-wrap"><div className="section-icon"><Landmark size={16} /></div><div><div className="section-title">Advances</div><div className="section-subtitle">Outstanding working-capital positions</div></div></div><span className="section-kicker">CHAIN READ</span></div>
            <div className="table-head loans-table"><span>Borrower</span><span>Principal</span><span>Remaining</span><span>Status</span><span>Explorer</span></div>
            <EmptyState id="loans" label="No advances read" detail="No borrower or loan data has been loaded from Arc Testnet." />
          </section>

          <section className="section-card" id="repayments" data-testid="section-repayments">
            <div className="section-heading"><div className="section-title-wrap"><div className="section-icon"><ArrowDownRight size={16} /></div><div><div className="section-title">Repayments</div><div className="section-subtitle">Receipts routed toward outstanding advances</div></div></div><span className="section-kicker">CHAIN READ</span></div>
            <div className="table-head repay-table"><span>Transaction</span><span>Borrower</span><span>Amount</span><span>Block</span><span>Explorer</span></div>
            <EmptyState id="repayments" label="No repayments read" detail="Repayment events will appear here when direct chain reads are connected." />
          </section>

          <section className="section-card" id="transactions" data-testid="section-transactions">
            <div className="section-heading"><div className="section-title-wrap"><div className="section-icon"><Activity size={16} /></div><div><div className="section-title">Recent transactions</div><div className="section-subtitle">Protocol activity and explorer references</div></div></div><span className="section-kicker">CHAIN READ</span></div>
            <div className="table-head transactions-table"><span>Transaction</span><span>Action</span><span>Address</span><span>Block</span><span>Explorer</span></div>
            <EmptyState id="transactions" label="No transactions read" detail="Explorer links appear alongside transactions observed on Arc Testnet." />
          </section>

          <div className="bottom-grid">
            <section className="section-card" aria-labelledby="flow-title">
              <div className="section-heading"><div className="section-title-wrap"><div className="section-icon"><ArrowRight size={16} /></div><div><div className="section-title" id="flow-title">Receipt path</div><div className="section-subtitle">Protocol flow reference</div></div></div><span className="section-kicker">MODEL</span></div>
              <div className="flow-body">
                <div className="flow-track">
                  <div className="flow-node"><div className="flow-node-label">01 / Incoming</div><div className="flow-node-title">x402 receipt</div></div><ArrowRight className="flow-arrow" size={15} />
                  <div className="flow-node"><div className="flow-node-label">02 / Route</div><div className="flow-node-title">Splitter</div></div><ArrowRight className="flow-arrow" size={15} />
                  <div className="flow-node"><div className="flow-node-label">03 / Distribute</div><div className="flow-node-title">Advance + seller</div></div>
                </div>
                <p className="flow-caption">New receipts repay the advance first; any remainder returns to the seller. This is a protocol model, not an observed transaction.</p>
              </div>
            </section>
            <section className="section-card" aria-labelledby="risk-title">
              <div className="section-heading"><div className="section-title-wrap"><div className="section-icon"><AlertTriangle size={16} /></div><div><div className="section-title" id="risk-title">Deployment posture</div><div className="section-subtitle">Operational readiness</div></div></div></div>
              <div className="risk-body">
                <div className="risk-level"><span className="risk-badge">Prototype</span>Not audited</div>
                <p>Addresses are user-supplied configuration. No chain state has been verified in this view. Confirm deployed bytecode and protocol behavior independently before relying on this interface.</p>
              </div>
            </section>
          </div>
          <footer className="footer-line"><span><strong>RUNWAY</strong> / Arc Testnet operations desk</span><span>Configuration ≠ chain state</span></footer>
        </main>
      </div>
      {toast && <div className="toast-message" role="status" data-testid="toast-config">{toast}</div>}
    </div>
  );
}

function Router() {
  return (
    // Keep a shared shell (sidebar, navbar) outside the boundary so it
    // survives a page crash.
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/status" component={Status} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
