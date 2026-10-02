import { useState, type FormEvent } from 'react';
import { Check, RotateCcw, Save } from 'lucide-react';

import { PageFooter, PageHeader } from '@/components/app-shell';
import { Section } from '@/components/section';

const DEPLOYED = {
  vault: '0x0f1a59fcab0638a1f3525d5acaedc5cbef4d95b7',
  factory: '0x0ed2b25c82f8a701f81c5182c0a5f3faf6e53c76',
  splitter: '0x8C24a83a1103460a0845bE553fe070040f8c31D1',
  splitterImpl: '0xc880AF5d5aC3ea27c26C47D132661A710C245ea5',
  usdc: '0x3600000000000000000000000000000000000000',
  explorer: 'https://explorer.testnet.arc.io',
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
    { label: 'Splitter implementation', address: DEPLOYED.splitterImpl, role: 'Clone implementation used by the factory' },
    { label: 'USDC', address: DEPLOYED.usdc, role: 'FiatTokenV2 with EIP-3009 support' },
  ];

  return (
    <main className="content">
      <PageHeader
        eyebrow="CONFIGURATION / DEPLOYMENTS"
        title="Contracts"
        subtitle="Addresses deployed on Arc testnet, plus a local override."
      />

      <Section title="Deployed contracts" subtitle="Arc testnet, chain 5042002 — source verified on the explorer" testId="section-deployed">
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
      </Section>

      <Section title="Local override" subtitle="Stored in this browser only; does not change chain reads" kicker="LOCAL" testId="section-configuration">
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
      </Section>

      <PageFooter />
    </main>
  );
}
