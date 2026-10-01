import { Link } from 'wouter';
import { ArrowDownRight, Landmark, Layers3, Wallet } from 'lucide-react';

import { ChainNotice, PageFooter, PageHeader } from '@/components/app-shell';
import { Section } from '@/components/section';
import { useChainStatus, shortAddress } from '@/lib/chain-status';

export function OverviewPage() {
  const { data } = useChainStatus();

  return (
    <main className="content">
      <PageHeader
        eyebrow="WORKING CAPITAL / CONTROL ROOM"
        title="Operations overview"
        subtitle="x402 revenue routing and advance repayment on Arc testnet."
      />
      <ChainNotice />

      <div className="metric-grid" aria-label="Protocol summary">
        {[
          {
            label: 'Active splitters',
            icon: Layers3,
            value: data ? String(data.summary.splitters) : null,
            helper: data
              ? data.splitters[0]
                ? shortAddress(data.splitters[0].address)
                : 'none registered'
              : 'Awaiting onchain reads',
            to: '/splitters',
          },
          {
            label: 'Open advances',
            icon: Landmark,
            value: data ? String(data.summary.openLoans) : null,
            helper: data
              ? `${data.protocol.totalOutstanding.formatted} USDC outstanding`
              : 'Awaiting onchain reads',
            to: '/advances',
          },
          {
            label: 'Repaid to date',
            icon: ArrowDownRight,
            value: data ? data.protocol.vaultBalance.formatted : null,
            helper: data
              ? `vault holds ${data.protocol.vaultBalance.formatted} USDC`
              : 'Awaiting onchain reads',
            to: '/repayments',
          },
          {
            label: 'Seller receipts',
            icon: Wallet,
            value: data ? data.summary.lifetimeRevenue.formatted : null,
            helper: data
              ? `${data.summary.sellerReceipts.formatted} USDC via x402`
              : 'Awaiting onchain reads',
            to: '/transactions',
          },
        ].map(({ label, icon: Icon, value, helper, to }) => (
          <Link key={label} href={to} className="metric metric-link">
            <div className="metric-top">
              <span>{label}</span>
              <Icon className="metric-icon" size={15} strokeWidth={1.7} aria-hidden />
            </div>
            <div className="metric-value">{value ?? '—'}</div>
            <div className="metric-helper">{helper}</div>
          </Link>
        ))}
      </div>

      <Section
        title="Protocol parameters"
        subtitle="Read from the vault on chain"
        actions={
          <Link className="row-link" href="/contracts">
            Contracts
          </Link>
        }
        testId="section-snapshot"
      >
        <div className="param-grid">
          {data ? (
            [
              { label: 'Global cap per agent', value: `${data.protocol.globalMax.formatted} USDC` },
              { label: 'Starter cap', value: `${data.protocol.starterCap.formatted} USDC` },
              { label: 'Flat fee', value: `${data.protocol.feeBpsDefault / 100}%` },
              { label: 'Lender share', value: `${data.protocol.lenderShareBpsDefault / 100}%` },
              { label: 'Settle threshold', value: `${data.protocol.settleThreshold.formatted} USDC` },
              { label: 'Vault outstanding', value: `${data.protocol.totalOutstanding.formatted} USDC` },
            ].map((item) => (
              <div className="param" key={item.label}>
                <div className="param-label">{item.label}</div>
                <div className="param-value">{item.value}</div>
              </div>
            ))
          ) : (
            <p className="empty-copy">Awaiting onchain reads…</p>
          )}
        </div>
      </Section>

      <Section title="Receipt path" subtitle="How a payment becomes repayment">
        <div className="flow-body">
          <ol className="flow-track">
            <li className="flow-node">
              <div className="flow-node-label">01 / Incoming</div>
              <div className="flow-node-title">x402 receipt</div>
            </li>
            <li className="flow-node">
              <div className="flow-node-label">02 / Route</div>
              <div className="flow-node-title">Splitter</div>
            </li>
            <li className="flow-node">
              <div className="flow-node-label">03 / Distribute</div>
              <div className="flow-node-title">Advance + seller</div>
            </li>
          </ol>
          <p className="flow-caption">
            New receipts repay the advance first; any remainder returns to the
            seller. Try it on the x402 page.
          </p>
          <Link className="primary-button" href="/x402">
            Run the hosted flow
          </Link>
        </div>
      </Section>

      <PageFooter />
    </main>
  );
}
