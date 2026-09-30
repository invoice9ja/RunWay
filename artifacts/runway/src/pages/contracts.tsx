import { useState, type FormEvent } from 'react';
import { Check, RotateCcw, Save } from 'lucide-react';

import { PageFooter, PageHeader } from '@/components/app-shell';

const DEPLOYED = {
  vault: '0x50521815D832eb80BabBA0f888c686Fb224f2Dd4',
  factory: '0xC278850c7194a8ecD8b81A223847F995Ad56fCdf',
  splitter: '0x96030e714e14b848445b40dfc327d828a3f474f6',
  vaultImpl: '0xb220f46e18166F5e4DAe0B8EB826ab27c8305110',
  usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  explorer: 'https://sepolia.basescan.org',
};

type Config = { vault: string; factory: string };

function readConfig(): Config {
  try {
    const saved = localStorage.getItem('runway-contract-config');
    if (saved) return JSON.parse(saved) as Config;
  } catch {
    /* fall through to the deployed defaults */
  }
  return { vault: DEPLOYED.vault, factory: DEPLOYED.factory };
}

export function ContractsPage() {
  const [saved, setSaved] = useState<Config>(readConfig);
  const [draft, setDraft] = useState<Config>(readConfig);
  const [errors, setErrors] = useState<Partial<Record<keyof Config, string>>>({});
  const [feedback, setFeedback] = useState('');

  const update = (field: keyof Config, value: string) => {
    setDraft((current) => ({ ...current, [field]: value.trim() }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setFeedback('');
  };

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: Partial<Record<keyof Config, string>> = {};
    (['vault', 'factory'] as const).forEach((field) => {
      if (draft[field] && !/^0x[a-fA-F0-9]{40}$/.test(draft[field])) {
        next[field] = 'Enter a valid 0x address (42 characters).';
      }
    });
    setErrors(next);
    if (Object.keys(next).length) return;
    localStorage.setItem('runway-contract-config', JSON.stringify(draft));
    setSaved(draft);
    setFeedback('Saved in this browser.');
  };

  const reset = () => {
    localStorage.removeItem('runway-contract-config');
    setSaved({ vault: DEPLOYED.vault, factory: DEPLOYED.factory });
    setDraft({ vault: DEPLOYED.vault, factory: DEPLOYED.factory });
    setErrors({});
    setFeedback('Reset to the deployed addresses.');
  };

  const deployedRows = [
    { label: 'RunwayVault', address: DEPLOYED.vault, role: 'Holds lender funds, issues and repays advances' },
    { label: 'RunwayFactory', address: DEPLOYED.factory, role: 'Registers and discovers splitters' },
    { label: 'RevenueSplitter', address: DEPLOYED.splitter, role: 'Live agent routing contract' },
    { label: 'Splitter deployment', address: DEPLOYED.vaultImpl, role: 'First splitter deployed by the factory' },
    { label: 'USDC', address: DEPLOYED.usdc, role: 'FiatTokenV2 with EIP-3009 support' },
  ];

  return (
    <main className="content">
      <PageHeader
        eyebrow="CONFIGURATION / DEPLOYMENTS"
        title="Contracts"
        subtitle="Addresses deployed on Base Sepolia, plus a local override."
      />

      <section className="section-card" data-testid="section-deployed">
        <div className="section-heading">
          <div className="section-title-wrap">
            <div className="section-title">Deployed contracts</div>
            <div className="section-subtitle">
              Base Sepolia, chain 84532 — not yet verified on the explorer
            </div>
          </div>
        </div>
        <div className="contract-list">
          {deployedRows.map((row) => (
            <div className="contract-row" key={row.address}>
              <div className="contract-main">
                <div className="contract-name">{row.label}</div>
                <a
                  className="contract-address mono"
                  href={`${DEPLOYED.explorer}/address/${row.address}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={row.address}
                >
                  {row.address}
                </a>
                <div className="contract-role">{row.role}</div>
              </div>
              <a
                className="row-link"
                href={`${DEPLOYED.explorer}/address/${row.address}`}
                target="_blank"
                rel="noreferrer noopener"
              >
                Explorer
              </a>
            </div>
          ))}
        </div>
      </section>

      <section className="section-card" data-testid="section-configuration">
        <div className="section-heading">
          <div className="section-title-wrap">
            <div className="section-title">Local override</div>
            <div className="section-subtitle">
              Stored in this browser only; does not change chain reads
            </div>
          </div>
          <span className="section-kicker">LOCAL</span>
        </div>
        <div className="config-body">
          <form onSubmit={save} noValidate data-testid="form-contract-config">
            <div className="config-grid">
              {(['vault', 'factory'] as const).map((field) => (
                <label key={field}>
                  <span className="field-label">
                    {field === 'vault' ? 'Vault contract' : 'Factory contract'}{' '}
                    <span className="field-hint">BASE SEPOLIA</span>
                  </span>
                  <input
                    className="address-input"
                    value={draft[field]}
                    onChange={(event) => update(field, event.target.value)}
                    placeholder="0x…"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={Boolean(errors[field])}
                    aria-describedby={errors[field] ? `${field}-error` : undefined}
                    data-testid={`input-${field}-address`}
                  />
                  {errors[field] && (
                    <div className="field-error" id={`${field}-error`}>
                      {errors[field]}
                    </div>
                  )}
                </label>
              ))}
            </div>
            <div className="config-actions">
              <button className="primary-button" type="submit" data-testid="button-save-config">
                <Save size={14} aria-hidden /> Save configuration
              </button>
              <button className="secondary-button" type="button" onClick={reset} data-testid="button-clear-config">
                <RotateCcw size={13} aria-hidden /> Reset to deployed
              </button>
              {feedback && (
                <span className="save-feedback" role="status">
                  <Check size={12} aria-hidden /> {feedback}
                </span>
              )}
            </div>
          </form>

          <div className="saved-addresses">
            <div className="saved-address">
              <div className="saved-address-label">Active vault</div>
              <div className="saved-address-value mono" title={saved.vault}>
                {saved.vault}
              </div>
            </div>
            <div className="saved-address">
              <div className="saved-address-label">Active factory</div>
              <div className="saved-address-value mono" title={saved.factory}>
                {saved.factory}
              </div>
            </div>
          </div>
        </div>
      </section>

      <PageFooter />
    </main>
  );
}
