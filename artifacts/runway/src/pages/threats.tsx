import { Link } from 'wouter';

import { PageFooter, PageHeader } from '@/components/app-shell';
import { Section } from '@/components/section';
import { useChainStatus } from '@/lib/chain-status';
import { NETWORK_LABEL } from '@/lib/chain';

export function ThreatsPage() {
  const { data } = useChainStatus();

  const resolved = [
    {
      title: 'Agent claim exceeded custody',
      body: 'setLoanActive credited the loan principal to agentClaimable, so the agent was owed USDC the contract no longer held. agentClaimable is now separate from advanceHeld, and withdraw() is bounded by tokens actually held.',
    },
    {
      title: 'Flat fee was never charged',
      body: 'feeBps was stored on the loan but repay() only ever collected the supplied principal. repay() now applies against totalDue and returns the amount applied. A 10.0 USDC advance repays 10.8.',
    },
    {
      title: 'Excess lender share was stranded',
      body: 'repay() caps at the debt and returns what it applied, so the splitter credits the remainder to the agent instead of leaving it unowned. surplus() is zero after every settle.',
    },
    {
      title: 'settle() could underflow',
      body: 'lastSettledBalance is now decremented by the full amount withdrawn, not just the advance portion, so a withdrawal no longer leaves a stale baseline that under-counts the next settlement.',
    },
    {
      title: 'withdraw() ignored outstanding debt',
      body: 'availableToWithdraw() excludes advances still owed to lenders, and withdraw() is bounded by it.',
    },
    {
      title: 'Factory did not use clones',
      body: 'The factory now deploys minimal proxies via Clones.clone plus initialize(). Clone runtime is 45 bytes.',
    },
  ];

  const findings = [
    {
      severity: 'critical' as const,
      title: 'Operational key was exposed and is not rotated',
      body: 'The deployer key appeared in an earlier session and in git history. It must be replaced with a dedicated low-value key before any public demo.',
    },
    {
      severity: 'high' as const,
      title: 'Payee swap is only partly mitigated',
      body: 'setPayout is blocked while an advance is outstanding, and flagLoan marks the agent to block future borrowing. Revenue that landed before the swap is already in the splitter, so the window is narrow rather than closed.',
    },
    {
      severity: 'medium' as const,
      title: 'Wash trading inflates the cap',
      body: 'The advance cap grows with lifetime revenue, so a self-paying agent can raise its own limit. Only the hard global cap bounds exposure.',
    },
    {
      severity: 'medium' as const,
      title: 'No independent review',
      body: 'No third-party audit and no formal verification. The regression tests were written alongside the fix, so they grade the authors own model of the defect rather than an independent one.',
    },
  ];

  const order = { critical: 0, high: 1, medium: 2 } as const;

  return (
    <main className="content">
      <PageHeader
        eyebrow="REVIEW / RISK"
        title="Threat model"
        subtitle="Open risks in the current design, and what was fixed."
      />

      <Section
        title="Findings"
        subtitle="Sorted by severity — these block real funds"
        kicker={
          <>
            {findings.length} open &middot; {resolved.length} fixed
          </>
        }
        testId="section-threats"
      >
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
          {resolved.map((item) => (
            <article className="finding" key={item.title}>
              <div className="finding-head">
                <span className="sev sev-resolved">fixed</span>
                <h2 className="finding-title">{item.title}</h2>
              </div>
              <p className="finding-body">{item.body}</p>
            </article>
          ))}
        </div>
      </Section>

      <Section title="Deployment posture" subtitle="What is and is not proven">
        <div className="risk-body">
          <div className="risk-level">
            <span className="risk-badge">Prototype</span> Not audited
          </div>
          <ul className="check-list">
            <li className="ok">
              Loan lifecycle works end to end on {NETWORK_LABEL}: one advance was
              opened, driven to zero outstanding with the fee collected, and
              closed. The agent then withdrew its full balance with no surplus.
            </li>
            <li className="ok">
              Vault, Factory and RevenueSplitter are source verified on the Arc
              testnet explorer.
            </li>
            <li className="ok">
              29 unit tests and 8 invariants pass, including one regression test
              per fixed defect.
            </li>
            <li className="bad">
              The contracts have had no independent review. The tests were
              written alongside the fix, so they do not count as one.
            </li>
            <li className="bad">
              The operational deployer key is still the exposed one and has not
              been rotated.
            </li>
          </ul>
          {data && (
            <p className="page-note">
              Global cap {data.protocol.globalMax.formatted} USDC &middot; starter
              cap {data.protocol.starterCap.formatted} USDC &middot; lender share{' '}
              {data.protocol.lenderShareBpsDefault / 100}% &middot; stated fee{' '}
              {data.protocol.feeBpsDefault / 100}% (charged on repayment).
            </p>
          )}
          <Link className="secondary-button" href="/contracts">
            View deployed addresses
          </Link>
        </div>
      </Section>

      <PageFooter />
    </main>
  );
}
