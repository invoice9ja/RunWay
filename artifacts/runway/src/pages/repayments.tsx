import { EmptyState, PageFooter, PageHeader } from '@/components/app-shell';
import { Section } from '@/components/section';
import { useChainStatus, shortAddress } from '@/lib/chain-status';

export function RepaymentsPage() {
  const { data } = useChainStatus();
  const repayments = data?.repayments ?? [];
  const total = repayments.reduce(
    (sum, row) => sum + BigInt(row.amount.raw),
    0n,
  );

  return (
    <main className="content">
      <PageHeader
        eyebrow="ADVANCES / REPAYMENT"
        title="Repayments"
        subtitle="Lender share routed from settled receipts back into the vault."
      />

      <div className="metric-grid metric-grid-3">
        <div className="metric">
          <div className="metric-top">
            <span>Vault balance</span>
          </div>
          <div className="metric-value">
            {data ? data.protocol.vaultBalance.formatted : '—'}
          </div>
          <div className="metric-helper">USDC currently held</div>
        </div>
        <div className="metric">
          <div className="metric-top">
            <span>Still owed</span>
          </div>
          <div className="metric-value">
            {data ? data.protocol.totalOutstanding.formatted : '—'}
          </div>
          <div className="metric-helper">USDC outstanding</div>
        </div>
        <div className="metric">
          <div className="metric-top">
            <span>Repaid (window)</span>
          </div>
          <div className="metric-value">
            {(Number(total) / 1e6).toFixed(2)}
          </div>
          <div className="metric-helper">
            {repayments.length} repayment events
          </div>
        </div>
      </div>

      <Section title="Repayment history" subtitle="Repaid events emitted by the vault" testId="section-repayments">

        {repayments.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Transaction</th>
                  <th scope="col">Loan</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Block</th>
                  <th scope="col">Explorer</th>
                </tr>
              </thead>
              <tbody>
                {repayments.map((row) => (
                  <tr
                    key={`${row.transaction}-${row.loanId}`}
                    data-testid={`row-repayment-${row.transaction}`}
                  >
                    <td className="mono" title={row.transaction}>
                      {shortAddress(row.transaction)}
                    </td>
                    <td className="mono">#{row.loanId}</td>
                    <td>{row.amount.formatted} USDC</td>
                    <td>{row.block.toLocaleString()}</td>
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
            id="repayments"
            label="No repayments read"
            detail="Repayment events appear once an advance is opened and receipts settle."
          />
        )}
      </Section>

      <PageFooter />
    </main>
  );
}
