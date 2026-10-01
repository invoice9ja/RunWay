import { Link } from 'wouter';

import { EmptyState, PageFooter, PageHeader } from '@/components/app-shell';
import { useChainStatus, shortAddress } from '@/lib/chain-status';

type ActivityRow = {
  key: string;
  hash: string;
  explorer: string;
  block: number;
  kind: 'Receipt' | 'Settlement' | 'Advance' | 'Repayment';
  detail: string;
  counterparty: string;
};

export function TransactionsPage() {
  const { data } = useChainStatus();

  const rows: ActivityRow[] = data
    ? [
        ...data.receipts.map((row) => ({
          key: `r-${row.transaction}`,
          hash: row.transaction,
          explorer: row.explorer,
          block: row.block,
          kind: 'Receipt' as const,
          detail: `x402 receipt of ${row.amount.formatted} USDC`,
          counterparty: shortAddress(row.from),
        })),
        ...data.settlements.map((row) => ({
          key: `s-${row.transaction}`,
          hash: row.transaction,
          explorer: row.explorer,
          block: row.block,
          kind: 'Settlement' as const,
          detail: `split ${row.revenue.formatted} USDC into ${row.lenderShare.formatted} lender / ${row.agentShare.formatted} agent`,
          counterparty: 'RevenueSplitter',
        })),
        ...data.loansOpened.map((row) => ({
          key: `l-${row.transaction}`,
          hash: row.transaction,
          explorer: row.explorer,
          block: row.block,
          kind: 'Advance' as const,
          detail: `issued ${row.principal.formatted} USDC`,
          counterparty: `Loan #${row.loanId}`,
        })),
        ...data.repayments.map((row) => ({
          key: `p-${row.transaction}-${row.loanId}`,
          hash: row.transaction,
          explorer: row.explorer,
          block: row.block,
          kind: 'Repayment' as const,
          detail: `repaid ${row.amount.formatted} USDC to vault`,
          counterparty: `Loan #${row.loanId}`,
        })),
      ].sort((a, b) => b.block - a.block)
    : [];

  return (
    <main className="content">
      <PageHeader
        eyebrow="LEDGER / ACTIVITY"
        title="Transactions"
        subtitle="Every protocol event observed on Arc testnet, newest first."
        action={
          <Link className="secondary-button" href="/x402">
            Run a payment
          </Link>
        }
      />

      <section className="section-card" data-testid="section-transactions">
        <div className="section-heading">
          <div className="section-title-wrap">
            <div className="section-title">Activity</div>
            <div className="section-subtitle">Receipts, settlements, advances and repayments</div>
          </div>
          <span className="section-kicker">{rows.length} events</span>
        </div>

        {rows.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col">Detail</th>
                  <th scope="col">Counterparty</th>
                  <th scope="col">Transaction</th>
                  <th scope="col">Block</th>
                  <th scope="col">Explorer</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 60).map((row) => (
                  <tr key={row.key} data-testid={`row-tx-${row.hash}`}>
                    <td>
                      <span className={`pill pill-${row.kind.toLowerCase()}`}>
                        {row.kind}
                      </span>
                    </td>
                    <td>{row.detail}</td>
                    <td className="mono">{row.counterparty}</td>
                    <td className="mono" title={row.hash}>
                      {shortAddress(row.hash)}
                    </td>
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
            id="transactions"
            label="No transactions read"
            detail="Activity appears once receipts and settlements land on chain."
          />
        )}
      </section>

      <PageFooter />
    </main>
  );
}
