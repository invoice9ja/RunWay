import { PageFooter, PageHeader } from '@/components/app-shell';
import { useDemoPayment } from '@/lib/chain-status';

export function X402Page() {
  const demo = useDemoPayment();

  return (
    <main className="content">
      <PageHeader
        eyebrow="PAYMENTS / HOSTED"
        title="x402 loop"
        subtitle="Run a real EIP-3009 payment and watch it route through the splitter."
      />

      <section className="section-card" data-testid="section-x402">
        <div className="section-heading">
          <div className="section-title-wrap">
            <div className="section-title">Buyer → 402 → signature → settlement</div>
            <div className="section-subtitle">
              Every step executes on Vercel against Arc testnet
            </div>
          </div>
          <span className="section-kicker">SERVERLESS</span>
        </div>

        <div className="x402-body">
          <div className="x402-actions">
            <button
              className="primary-button"
              type="button"
              onClick={() => demo.run('100000')}
              disabled={demo.running}
              data-testid="button-run-x402"
            >
              {demo.running ? 'Running x402 flow…' : 'Run x402 payment (0.1 USDC)'}
            </button>
            <a
              className="secondary-button"
              href="/api/x402/resource"
              target="_blank"
              rel="noreferrer noopener"
            >
              Open the 402 challenge
            </a>
            <a
              className="secondary-button"
              href="/api/status"
              target="_blank"
              rel="noreferrer noopener"
            >
              Raw status JSON
            </a>
          </div>

          {demo.error && (
            <p className="x402-error" role="alert" data-testid="x402-error">
              {demo.error}
            </p>
          )}

          {demo.result && (
            <ul className="x402-steps" data-testid="x402-steps">
              {demo.result.steps.map((step, index) => (
                <li className="x402-step" key={`${step.step}-${index}`}>
                  <span
                    className={`x402-dot${step.ok ? '' : ' fail'}`}
                    aria-hidden
                  />
                  <span className="x402-step-name">{step.step}</span>
                  <span className="x402-step-detail">{step.detail}</span>
                </li>
              ))}
            </ul>
          )}

          {demo.result?.treasury && (
            <div className="param-grid">
              <div className="param">
                <div className="param-label">Vault balance</div>
                <div className="param-value">
                  {demo.result.treasury.vaultBalanceFormatted} USDC
                </div>
              </div>
              <div className="param">
                <div className="param-label">Agent claimable</div>
                <div className="param-value">
                  {demo.result.treasury.agentClaimableFormatted} USDC
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="section-card">
        <div className="section-heading">
          <div className="section-title-wrap">
            <div className="section-title">How it works</div>
            <div className="section-subtitle">The x402 exact scheme on Arc testnet</div>
          </div>
        </div>
        <ol className="explainer">
          <li>
            <strong>402 challenge.</strong> <code>GET /api/x402/resource</code>{' '}
            returns HTTP 402 with a base64 <code>X-PAYMENT</code> header describing
            the price, asset and payee.
          </li>
          <li>
            <strong>Approval.</strong> The buyer grants the seller an allowance so
            the signed authorization can be pulled.
          </li>
          <li>
            <strong>Signature.</strong> The buyer signs an EIP-712{' '}
            <code>TransferWithAuthorization</code> over the USDC domain{' '}
            (<code>name: "USDC"</code>, <code>version: "2"</code>).
          </li>
          <li>
            <strong>Verification.</strong> The seller recovers the signer, checks
            the amount, validity window, allowance and nonce, then pulls the USDC
            with <code>transferWithAuthorization</code>.
          </li>
          <li>
            <strong>Routing.</strong> The seller forwards the receipt to the agent's{' '}
            <code>RevenueSplitter</code>, so it cannot be diverted elsewhere.
          </li>
          <li>
            <strong>Settlement.</strong> The keeper calls <code>settle()</code>,
            which sends the lender share to the vault first and the rest to the
            agent.
          </li>
        </ol>
      </section>

      <p className="page-note">
        Dashboard payments are capped at 0.1 USDC, throttled to one per 30 seconds,
        and stop when the operational wallet would drop below its floor. Pass the{' '}
        <code>x-keeper-secret</code> header for a larger authorised run.
      </p>

      <PageFooter />
    </main>
  );
}
