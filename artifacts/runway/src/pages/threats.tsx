import { Link } from 'wouter';

import { PageFooter, PageHeader } from '@/components/app-shell';
import { useChainStatus } from '@/lib/chain-status';

export function ThreatsPage() {
  const { data } = useChainStatus();

  const findings = [
    {
      severity: 'critical' as const,
      title: 'Agent claim exceeds custody',
      body: 'setLoanActive credits the loan principal to agentClaimable, so the agent is owed USDC the contract no longer holds. withdraw() reverts when the balance is short.',
    },
    {
      severity: 'critical' as const,
      title: 'Flat fee is never charged',
      body: 'feeBps is stored on the loan but repay() only ever collects the supplied principal, so the 8% fee in the PRD is not applied.',
    },
    {
      severity: 'high' as const,
      title: 'Excess lender share is stranded',
      body: 'When the lender share exceeds the outstanding balance, repay() caps the repayment and the remainder stays in the splitter credited to nobody.',
    },
    {
      severity: 'high' as const,
      title: 'settle() can underflow',
      body: 'lastSettledBalance is set to the principal when a loan opens, so if the agent withdraws before the next settlement the subtraction reverts and revenue stalls.',
    },
    {
      severity: 'high' as const,
      title: 'withdraw() ignores outstanding debt',
      body: 'An admin can drain vault funds that are still owed to lenders, because the withdrawal check only compares against the raw balance.',
    },
    {
      severity: 'medium' as const,
      title: 'Factory does not use clones',
      body: 'It deploys full RevenueSplitter contracts while splitterImplementation and the Clones import sit unused, so gas does not scale as designed.',
    },
    {
      severity: 'high' as const,
      title: 'Payee swap is unmitigated',
      body: 'A watcher flag would block future settlement, but revenue landing between the swap and the flag is already in the splitter. No watcher service is implemented.',
    },
    {
      severity: 'medium' as const,
      title: 'Wash trading inflates the cap',
      body: 'The advance cap grows with lifetime revenue, so a self-paying agent can raise its own limit. Only the hard global cap bounds exposure.',
    },
    {
      severity: 'medium' as const,
      title: 'No underwriter or rating',
      body: 'The PRD describes an LLM underwriter and rationale hashes. Loans are issued without any scoring step, so the rationale field is always empty.',
    },
    {
      severity: 'critical' as const,
      title: 'Unaudited and unverified',
      body: 'No third-party audit, no formal verification, and the deployed bytecode is not verified on BaseScan. The operational key was exposed in an earlier session and must be rotated.',
    },
  ];

  const order = { critical: 0, high: 1, medium: 2 } as const;

  return (
    <main className="content">
      <PageHeader
        eyebrow="REVIEW / RISK"
        title="Threat model"
        subtitle="Known failure modes in the current contract design."
      />

      <section className="section-card" data-testid="section-threats">
        <div className="section-heading">
          <div className="section-title-wrap">
            <div className="section-title">Findings</div>
            <div className="section-subtitle">
              Sorted by severity — these block real funds
            </div>
          </div>
          <span className="section-kicker">{findings.length} findings</span>
        </div>
        <div className="finding-list">
          {[...findings]
            .sort((a, b) => order[a.severity] - order[b.severity])
            .map((finding) => (
              <article className="finding" key={finding.title}>
                <div className="finding-head">
                  <span className={`sev sev-${finding.severity}`}>{finding.severity}</span>
                  <h2 className="finding-title">{finding.title}</h2>
                </div>
                <p className="finding-body">{finding.body}</p>
              </article>
            ))}
        </div>
      </section>

      <section className="section-card">
        <div className="section-heading">
          <div className="section-title-wrap">
            <div className="section-title">Deployment posture</div>
            <div className="section-subtitle">What is and is not proven</div>
          </div>
        </div>
        <div className="risk-body">
          <div className="risk-level">
            <span className="risk-badge">Prototype</span> Not audited
          </div>
          <ul className="check-list">
            <li className="ok">
              Loan lifecycle works end to end on Base Sepolia: one advance was
              opened, driven to zero outstanding, and closed.
            </li>
            <li className="ok">
              The x402 exact-scheme payment path runs on Vercel with real
              EIP-3009 signatures verified against the USDC domain.
            </li>
            <li className="bad">
              Contract accounting does not balance, so the agent claim is not
              withdrawable.
            </li>
            <li className="bad">
              Contracts are not verified on the explorer, so deployed bytecode is
              unproven against this source.
            </li>
          </ul>
          {data && (
            <p className="page-note">
              Global cap {data.protocol.globalMax.formatted} USDC &middot; starter
              cap {data.protocol.starterCap.formatted} USDC &middot; lender share{' '}
              {data.protocol.lenderShareBpsDefault / 100}% &middot; stated fee{' '}
              {data.protocol.feeBpsDefault / 100}% (not enforced).
            </p>
          )}
          <Link className="secondary-button" href="/contracts">
            View deployed addresses
          </Link>
        </div>
      </section>

      <PageFooter />
    </main>
  );
}
