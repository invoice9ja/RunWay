import { useState } from 'react';

import { PageFooter, PageHeader } from '@/components/app-shell';
import { Section } from '@/components/section';

type TestMeta = {
  id: string;
  title: string;
  description: string;
  costly: boolean;
  expect: string;
};

type TestResult = {
  id: string;
  title: string;
  expect?: string;
  pass: boolean;
  /** The reason. Endpoints return `detail` on a completed check and `error` on a refusal. */
  detail?: string;
  error?: string;
  data?: unknown;
  ms?: number;
  status?: number;
};

export function TestsPage() {
  const [tests, setTests] = useState<TestMeta[] | null>(null);
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [authed, setAuthed] = useState(false);
  const [secret, setSecret] = useState('');

  const load = async () => {
    const response = await fetch('/api/tests/run');
    const payload = (await response.json()) as { tests?: TestMeta[]; authenticated?: boolean };
    setTests(payload.tests ?? []);
    setAuthed(payload.authenticated === true);
  };

  const runOne = async (id: string) => {
    setRunning(id);
    try {
      const response = await fetch(`/api/tests/run?id=${id}`, {
        headers: secret ? { 'x-keeper-secret': secret } : {},
      });
      const payload = (await response.json()) as TestResult;
      setResults((prev) => ({ ...prev, [id]: { ...payload, status: response.status } }));
    } catch (error) {
      setResults((prev) => ({
        ...prev,
        [id]: {
          id,
          title: id,
          expect: '',
          pass: false,
          detail: error instanceof Error ? error.message : String(error),
        },
      }));
    } finally {
      setRunning(null);
    }
  };

  const runAll = async () => {
    if (!tests) return;
    for (const test of tests) {
      await runOne(test.id);
    }
  };

  const passed = Object.values(results).filter((r) => r.pass).length;
  const gated = Object.values(results).filter((r) => r.status === 401).length;
  const failed = Object.values(results).filter((r) => !r.pass && r.status !== 401).length;

  return (
    <main className="content">
      <PageHeader
        eyebrow="VERIFY / PROTOCOL"
        title="Test suite"
        subtitle="Each check reads the live Arc deployment. Nothing here is mocked."
      />

      <Section title="Protocol checks" subtitle="Reads are free. Anything sending a transaction needs the keeper secret." kicker={Object.keys(results).length === 0 ? 'NOT RUN' : `${passed} PASS · ${failed} FAIL${gated ? ` · ${gated} GATED` : ''}`}>

        <div className="param-grid">
          <div className="param">
            <div className="param-label">Load suite</div>
            <div className="param-value">
              <button className="secondary-button" type="button" onClick={load}>
                {tests ? 'Reload' : 'Load tests'}
              </button>
            </div>
          </div>
          <div className="param">
            <div className="param-label">Run all</div>
            <div className="param-value">
              <button
                className="secondary-button"
                type="button"
                disabled={!tests || running !== null}
                onClick={runAll}
              >
                {running ? 'Running…' : 'Run every check'}
              </button>
            </div>
          </div>
        </div>

        <div className="param" style={{ marginTop: 14 }}>
          <div className="param-label">Keeper secret (only needed for withdraw)</div>
          <div className="param-value">
            <input
              className="text-input"
              type="password"
              value={secret}
              placeholder="x-keeper-secret"
              onChange={(event) => setSecret(event.target.value)}
            />
          </div>
          <div className="section-subtitle" style={{ marginTop: 6 }}>
            {authed
              ? 'Authenticated. Costly checks are enabled.'
              : 'Not authenticated. Costly checks will return 401.'}
          </div>
        </div>
      </Section>

      {tests?.map((test) => {
        const result = results[test.id];
        return (
          <Section
            title={test.title}
            subtitle={test.description}
            kicker={
              result
                ? result.pass
                  ? 'PASS'
                  : result.status === 401
                    ? 'GATED'
                    : 'FAIL'
                : test.costly
                  ? 'COSTLY'
                  : 'READY'
            }
            actions={
              <button
                className="secondary-button"
                type="button"
                disabled={running !== null}
                onClick={() => runOne(test.id)}
              >
                {running === test.id ? 'Running…' : 'Run'}
              </button>
            }
            testId={`test-${test.id}`}
          >

            <div className="risk-body">
              <div className="check-list">
                <li className="ok">
                  Expects: <strong>{test.expect}</strong>
                  {test.costly && ' · sends a transaction and moves real testnet USDC'}
                </li>
              </div>
              {result && (
                <>
                  <p
                    className="page-note"
                    data-testid={`result-${test.id}`}
                    style={{ color: result.pass ? '#2f6b4a' : '#9c3a30' }}
                  >
                    {result.pass ? 'PASS' : result.status === 401 ? 'GATED' : 'FAIL'}
                    {' — '}
                    {result.detail ?? result.error ?? 'no reason returned'}
                    {result.ms !== undefined && ` (${result.ms}ms)`}
                  </p>
                  {result.data !== undefined && (
                    <pre className="code-block">{JSON.stringify(result.data, null, 2)}</pre>
                  )}
                </>
              )}
            </div>
          </Section>
        );
      })}

      <Section title="Paid endpoint" subtitle="The SDK seller hosted on Vercel. An unpaid request gets the 402; a paid one is verified against the USDC domain and settled on chain." kicker="SERVERLESS" testId="section-seller">
        <div className="risk-body">
          <div className="x402-actions">
            <a
              className="primary-button"
              href="/api/demo/sell"
              target="_blank"
              rel="noreferrer noopener"
              data-testid="seller-402"
            >
              Request without paying (expect 402)
            </a>
            <a
              className="secondary-button"
              href="/api/demo/sell-x402"
              target="_blank"
              rel="noreferrer noopener"
            >
              Payment requirements
            </a>
            <a className="secondary-button" href="/x402">
              Run the full loop
            </a>
          </div>
        </div>
      </Section>

      <PageFooter />
    </main>
  );
}