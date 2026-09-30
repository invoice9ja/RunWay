import { EmptyState, PageFooter, PageHeader } from '@/components/app-shell';
import { useChainStatus, shortAddress } from '@/lib/chain-status';

const statusOf = (loan: {
  flagged: boolean;
  delinquent: boolean;
  active: boolean;
}) => {
  if (loan.flagged) return { label: 'Flagged', tone: 'pill-bad' } as const;
  if (loan.delinquent) return { label: 'Delinquent', tone: 'pill-bad' } as const;
  if (loan.active) return { label: 'Active', tone: 'pill-active' } as const;
  return { label: 'Repaid', tone: 'pill-done' } as const;
};

export function AdvancesPage() {
  const { data } = useChainStatus();
  const loans = data?.loans ?? [];

  return (
    <main className="content">
      <PageHeader
        eyebrow="ADVANCES / POSITIONS"
        title="Advances"
        subtitle="Working capital issued against expected x402 revenue."
      />

      <section className="section-card" data-testid="section-loans">
        <div className="section-heading">
          <div className="section-title-wrap">
            <div className="section-title">Outstanding positions</div>
            <div className="section-subtitle">
              Repaid automatically as receipts settle
            </div>
          </div>
          <span className="section-kicker">
            {data ? `${data.summary.openLoans} open` : '—'}
          </span>
        </div>

        {loans.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">Borrower</th>
                  <th scope="col">Principal</th>
                  <th scope="col">Repaid</th>
                  <th scope="col">Remaining</th>
                  <th scope="col">Progress</th>
                  <th scope="col">Status</th>
                  <th scope="col">Explorer</th>
                </tr>
              </thead>
              <tbody>
                {loans.map((loan) => {
                  const status = statusOf(loan);
                  return (
                    <tr key={loan.loanId} data-testid={`row-loan-${loan.loanId}`}>
                      <td className="mono">#{loan.loanId}</td>
                      <td className="mono" title={loan.splitter}>
                        {shortAddress(loan.splitter)}
                      </td>
                      <td>{loan.principal.formatted} USDC</td>
                      <td>{loan.repaid.formatted} USDC</td>
                      <td>{loan.outstanding.formatted} USDC</td>
                      <td className="progress-cell">
                        <span
                          className="progress-track"
                          role="progressbar"
                          aria-valuenow={Math.round(loan.progressBps / 100)}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-label={`Loan ${loan.loanId} repayment`}
                        >
                          <span
                            className="progress-fill"
                            style={{ width: `${Math.min(100, loan.progressBps / 100)}%` }}
                          />
                        </span>
                        <span className="progress-label">
                          {Math.round(loan.progressBps / 100)}%
                        </span>
                      </td>
                      <td>
                        <span className={`pill ${status.tone}`}>{status.label}</span>
                      </td>
                      <td>
                        <a
                          className="row-link"
                          href={loan.splitterExplorer}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          View
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            id="loans"
            label="No advances read"
            detail="No working capital has been issued on Base Sepolia yet."
          />
        )}
      </section>

      <PageFooter />
    </main>
  );
}
