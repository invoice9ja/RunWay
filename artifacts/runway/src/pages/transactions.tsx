import { Link } from 'wouter';

import { EmptyState, PageFooter, PageHeader } from '@/components/app-shell';
import { Section } from '@/components/section';
import { useChainStatus, shortAddress } from '@/lib/chain-status';

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});

/** "14:32" for today, "12 Oct 14:32" otherwise, always UTC. */
function formatStamp(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const sameDay = date.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
  return DATE_FORMAT.format(date);
}

function fullStamp(iso: string | null, block: number): string {
  if (!iso) return 'timestamp unavailable';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'timestamp unavailable';
  return `${date.toUTCString().replace('GMT', 'UTC')} · block ${block.toLocaleString()}`;
}

type ActivityRow = {
  key: string;
  hash: string;
  explorer: string;
  block: number;
  /** ISO 8601 from the block's own timestamp. Null when the read failed. */
  timestamp: string | null;
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
          timestamp: row.timestamp ?? null,
          kind: 'Receipt' as const,
          detail: `x402 receipt of ${row.amount.formatted} USDC`,
          counterparty: shortAddress(row.from),
        })),
        ...data.settlements.map((row) => ({
          key: `s-${row.transaction}`,
          hash: row.transaction,
          explorer: row.explorer,
          block: row.block,
          timestamp: row.timestamp ?? null,
          kind: 'Settlement' as const,
          detail: `split ${row.revenue.formatted} USDC into ${row.lenderShare.formatted} lender / ${row.agentShare.formatted} agent`,
          counterparty: 'RevenueSplitter',
        })),
        ...data.loansOpened.map((row) => ({
          key: `l-${row.transaction}`,
          hash: row.transaction,
          explorer: row.explorer,
          block: row.block,
          timestamp: row.timestamp ?? null,
          kind: 'Advance' as const,
          detail: `issued ${row.principal.formatted} USDC`,
          counterparty: `Loan #${row.loanId}`,
        })),
        ...data.repayments.map((row) => ({
          key: `p-${row.transaction}-${row.loanId}`,
          hash: row.transaction,
          explorer: row.explorer,
          block: row.block,
          timestamp: row.timestamp ?? null,
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

      <Section
        title="Activity"
        subtitle="Receipts, settlements, advances and repayments"
        kicker={`${rows.length} events`}
        testId="section-transactions"
      >

        {rows.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col">Detail</th>
                  <th scope="col">Counterparty</th>
                  <th scope="col">When (UTC)</th>
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
                    <td className="when" title={fullStamp(row.timestamp, row.block)}>
                      {formatStamp(row.timestamp)}
                    </td>
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
      </Section>

      <PageFooter />
    </main>
  );
}
