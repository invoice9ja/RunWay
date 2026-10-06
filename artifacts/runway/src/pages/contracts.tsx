import { useState, type FormEvent } from 'react';
import { Check, RotateCcw, Save } from 'lucide-react';

import { PageFooter, PageHeader } from '@/components/app-shell';
import { Section } from '@/components/section';
import { useChainStatus } from '@/lib/chain-status';

type Config = { vault: string; factory: string };

/**
 * The local override is browser-only and must never masquerade as the real
 * deployment, so it starts empty and only ever reads back what this browser
 * saved. There are no built-in defaults here: the deployed addresses come from
 * /api/status, which reads the same config the API and services use. Hardcoding
 * them in this file is what let the page advertise a splitter implementation
 * from a retired deployment while the rest of the app talked to the current one.
 */
function readConfig(): Config {
  try {
    const saved = localStorage.getItem('runway-contract-config');
    if (saved) return JSON.parse(saved) as Config;
  } catch {
    /* fall through to no override */
  }
  return { vault: '', factory: '' };
}

export function ContractsPage() {
  const { data, loading } = useChainStatus();
  const deployed = data?.contracts;
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
    setSaved({ vault: '', factory: '' });
    setDraft({ vault: '', factory: '' });
    setErrors({});
    setFeedback('Reset to the deployed addresses.');
  };

  const deployedRows = [
    { key: 'vault', label: 'RunwayVault', role: 'Holds lender funds, issues and repays advances' },
    { key: 'factory', label: 'RunwayFactory', role: 'Registers and discovers splitters' },
    { key: 'splitter', label: 'RevenueSplitter', role: 'Live agent routing contract' },
    { key: 'splitterImpl', label: 'Splitter implementation', role: 'Clone implementation used by the factory' },
    { key: 'usdc', label: 'USDC', role: 'FiatTokenV2 with EIP-3009 support' },
  ]
    .map((row) => ({ ...row, ...(deployed?.[row.key as keyof typeof deployed] ?? {}) }))
    .filter((row): row is typeof row & { address: string; explorer: string } => Boolean(row.address));

  return (
    <main className="content">
      <PageHeader
        eyebrow="CONFIGURATION / DEPLOYMENTS"
        title="Contracts"
        subtitle="Addresses served by the API for the configured network, plus a browser-local override."
      />

      <Section
        title="Deployed contracts"
        subtitle={
          loading
            ? 'Reading the deployment from the API…'
            : `${data?.network ?? 'unknown'}, chain ${data?.chainId ?? '—'} — addresses served by /api/status`
        }
        testId="section-deployed"
      >
        <div className="contract-list">
          {deployedRows.map((row) => (
            <div className="contract-row" key={row.address}>
              <div className="contract-main">
                <div className="contract-name">{row.label}</div>
                <a
                  className="contract-address mono"
                  href={row.explorer}
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
                href={row.explorer}
                target="_blank"
                rel="noreferrer noopener"
              >
                Explorer
              </a>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Local override"
        subtitle="Stored in this browser only. Reads above still come from the API; this never changes them."
        kicker="LOCAL"
        testId="section-configuration"
      >
        <div className="config-body">
          <form onSubmit={save} noValidate data-testid="form-contract-config">
            <div className="config-grid">
              {(['vault', 'factory'] as const).map((field) => (
                <label key={field}>
                  <span className="field-label">
                    {field === 'vault' ? 'Vault contract' : 'Factory contract'}{' '}
                    <span className="field-hint">{data?.network ?? 'chain unknown'}</span>
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
            {(['vault', 'factory'] as const).map((field) => (
              <div className="saved-address" key={field}>
                <div className="saved-address-label">
                  Override {field === 'vault' ? 'vault' : 'factory'}
                </div>
                <div
                  className="saved-address-value mono"
                  title={saved[field] || undefined}
                >
                  {saved[field] || 'not set — using the API deployment'}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <PageFooter />
    </main>
  );
}
