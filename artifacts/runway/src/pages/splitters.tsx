import { Link } from 'wouter';

import { EmptyState, PageFooter, PageHeader } from '@/components/app-shell';
import { useChainStatus, shortAddress } from '@/lib/chain-status';

export function SplittersPage() {
  const { data } = useChainStatus();
  const rows = data?.splitters ?? [];

  return (
    <main className="content">
      <PageHeader
        eyebrow="ROUTING / AGENTS"
        title="Splitters"
        subtitle="Seller routing contracts registered on the Runway factory."
      />

      <section className="section-card" data-testid="section-splitters">
        <div className="section-heading">
          <div className="section-title-wrap">
            <div className="section-title">Registered splitters</div>
            <div className="section-subtitle">
              Every x402 receipt is forwarded to one of these contracts
            </div>
          </div>
          <Link className="row-link" href="/transactions">
            Transactions
          </Link>
        </div>

        {rows.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">Splitter</th>
                  <th scope="col">Lender share</th>
                  <th scope="col">Custody</th>
                  <th scope="col">Claimable</th>
                  <th scope="col">Unsettled</th>
                  <th scope="col">Lifetime</th>
                  <th scope="col">Status</th>
                  <th scope="col">Explorer</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.address} data-testid={`row-splitter-${row.address}`}>
                    <td className="mono" title={row.agent}>
                      {shortAddress(row.agent)}
                    </td>
                    <td className="mono" title={row.address}>
                      {shortAddress(row.address)}
                    </td>
                    <td>{row.lenderShareBps / 100}%</td>
                    <td>{row.tokenBalance.formatted} USDC</td>
                    <td>{row.agentClaimable.formatted} USDC</td>
                    <td>{row.unsettled.formatted} USDC</td>
                    <td>{row.lifetimeRevenue.formatted} USDC</td>
                    <td>
                      <span
                        className={`pill ${row.loanActive ? 'pill-active' : 'pill-done'}`}
                      >
                        {row.loanActive ? 'Advance open' : 'Settled'}
                      </span>
                    </td>
                    <td>
                      <a
                        className="row-link"
                        href={row.explorer}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        View
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            id="splitters"
            label="No splitters read"
            detail="The factory has not registered a routing contract yet."
          />
        )}
      </section>

      {rows.length > 0 && (
        <p className="page-note">
          <strong>Claimable can exceed custody.</strong> The splitter credits loan
          principal as an agent receivable, so <code>agentClaimable</code> may be
          larger than the USDC it actually holds. Treat it as unfunded.
        </p>
      )}

      <PageFooter />
    </main>
  );
}
