import { useCallback, useEffect, useState } from 'react';

import { PageFooter, PageHeader } from '@/components/app-shell';
import { shortAddress } from '@/lib/chain-status';
import {
  ARC_TESTNET,
  approveUsdc,
  connect,
  discoverWallets,
  encodePaymentHeader,
  formatUsd,
  getAllowance,
  getNativeBalance,
  getUsdcBalance,
  injectedProvider,
  signAuthorization,
  switchToArc,
  type ConnectedWallet,
} from '@/lib/wallet';

/**
 * Pay a Runway seller from a browser wallet.
 *
 * The flow is the x402 exact scheme, end to end, with a wallet doing the signing:
 *
 *   1. connect, and switch to Arc testnet if the wallet is elsewhere
 *   2. read the 402 challenge the seller returns
 *   3. approve USDC once, because EIP-3009 is a pull
 *   4. sign the EIP-3009 authorization
 *   5. retry with X-PAYMENT and receive the resource
 *
 * Step 3 is separate rather than automatic because it is the one step a user
 * should consciously approve: it grants the seller standing permission to pull
 * that USDC, and that outlives the single request.
 */

/**
 * Read a response that may or may not be JSON.
 *
 * A serverless crash returns an HTML or plain-text error page, and calling
 * `.json()` on that throws "Unexpected token 'A'", which hides both the status
 * and the real cause. Every seller response goes through here.
 */
async function readBody(response: Response): Promise<{ status: number; body: Record<string, unknown> | null; text: string }> {
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, text };
  } catch {
    return { status: response.status, body: null, text };
  }
}

/** What the seller returns once a payment settles. */
type Receipt = {
  resource?: string;
  description?: string;
  paid?: { raw: string; formatted: string };
  payer?: string;
  seller?: string;
  routedTo?: string;
  revenueShareBps?: number;
  settled?: boolean;
  transactions?: {
    pull?: { hash?: string; explorer?: string };
    route?: { hash?: string; explorer?: string };
  };
};

type Stage = {
  id: string;
  label: string;
  state: 'pending' | 'active' | 'done' | 'failed';
  detail?: string;
  explorer?: string;
};

const STAGES: { id: string; label: string }[] = [
  { id: 'connect', label: 'Connect wallet' },
  { id: 'challenge', label: 'Read the 402 challenge' },
  { id: 'balance', label: 'Check USDC and gas' },
  { id: 'approve', label: 'Approve USDC (one-time)' },
  { id: 'sign', label: 'Sign the EIP-3009 authorization' },
  { id: 'pay', label: 'Pay and receive the resource' },
];

const SELLER = '/api/demo/sell';
const RESOURCE = '/api/demo/sell';

export function PayPage() {
  const [wallets, setWallets] = useState<{ uuid: string; name: string }[]>([]);
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [usdc, setUsdc] = useState<bigint | null>(null);
  const [native, setNative] = useState<bigint | null>(null);
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [price, setPrice] = useState<bigint | null>(null);
  const [resource, setResource] = useState<Receipt | null>(null);
  const [stages, setStages] = useState<Stage[]>(STAGES.map((s) => ({ ...s, state: 'pending' })));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mark = useCallback((id: string, patch: Partial<Stage>) => {
    setStages((prev) =>
      prev.map((stage) => {
        if (stage.id === id) return { ...stage, ...patch };
        // Completing a stage retires the one before it.
        const index = STAGES.findIndex((s) => s.id === id);
        const own = STAGES.findIndex((s) => s.id === stage.id);
        if (own < index && patch.state === 'done' && stage.state !== 'done') {
          return { ...stage, state: 'done' };
        }
        return stage;
      }),
    );
  }, []);

  useEffect(() => {
    setWallets(discoverWallets());
  }, []);

  // The seller advertises its price without payment, so it can be shown before
  // a wallet is connected.
  useEffect(() => {
    fetch('/api/demo/sell-x402')
      .then((response) => response.json())
      .then((challenge: { accepts?: { maxAmountRequired: string }[] }) => {
        const value = challenge.accepts?.[0]?.maxAmountRequired;
        if (value) setPrice(BigInt(value));
      })
      .catch(() => undefined);
  }, []);

  const readBalances = useCallback(async (target: ConnectedWallet) => {
    const [token, gas, allowed] = await Promise.all([
      getUsdcBalance(target),
      getNativeBalance(target),
      getAllowance(target, SELLER_PAY_TO),
    ]);
    setUsdc(token);
    setNative(gas);
    setAllowance(allowed);
  }, []);

  const doConnect = async () => {
    setError(null);
    setBusy(true);
    mark('connect', { state: 'active' });
    try {
      const connected = await connect();
      setWallet(connected);
      mark('connect', { state: 'done', detail: connected.address });
      await readBalances(connected);
      mark('balance', { state: 'done' });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      mark('connect', { state: 'failed', detail: message });
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const doSwitch = async () => {
    if (!wallet) return;
    setBusy(true);
    setError(null);
    try {
      await switchToArc(wallet);
      const reconnected = await connect(wallet.provider);
      setWallet(reconnected);
      await readBalances(reconnected);
      mark('connect', { state: 'done', detail: `${reconnected.address} on Arc testnet` });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const doApprove = async () => {
    if (!wallet || !price) return;
    setBusy(true);
    setError(null);
    mark('approve', { state: 'active' });
    try {
      const hash = await approveUsdc(wallet, SELLER_PAY_TO, price * 1000n);
      mark('approve', {
        state: 'done',
        detail: `${formatUsd(price * 1000n)} USDC allowance`,
        explorer: `https://explorer.testnet.arc.io/tx/${hash}`,
      });
      await readBalances(wallet);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      mark('approve', { state: 'failed', detail: message });
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const doPay = async () => {
    if (!wallet || !price) return;
    setBusy(true);
    setError(null);
    setResource(null);

    try {
      mark('challenge', { state: 'active' });
      const challengeResponse = await fetch(SELLER);
      const challengeRead = await readBody(challengeResponse);
      if (challengeResponse.status !== 402) {
        throw new Error(
          `Expected a 402 challenge, got ${challengeRead.status}: ${challengeRead.text.slice(0, 200)}`,
        );
      }
      const accepts = challengeRead.body?.accepts as
        | { payTo: `0x${string}`; network: string; maxAmountRequired: string }[]
        | undefined;
      const requirement = accepts?.[0];
      if (!requirement) throw new Error('The seller returned no payment requirements');
      mark('challenge', {
        state: 'done',
        detail: `${formatUsd(BigInt(requirement.maxAmountRequired))} USDC to ${requirement.payTo.slice(0, 10)}… on ${requirement.network}`,
      });

      mark('sign', { state: 'active' });
      const signed = await signAuthorization(wallet, {
        to: requirement.payTo,
        value: BigInt(requirement.maxAmountRequired),
      });
      mark('sign', { state: 'done', detail: `nonce ${signed.authorization.nonce.slice(0, 12)}…` });

      mark('pay', { state: 'active' });
      const header = encodePaymentHeader(requirement.network, signed);
      const paid = await fetch(RESOURCE, { headers: { 'X-PAYMENT': header } });
      const settled = await readBody(paid);

      if (paid.status !== 200 || !settled.body) {
        // The seller's own error message is the useful part. A non-JSON body
        // means the function crashed, so say that rather than blaming the payment.
        throw new Error(
          (settled.body?.error as string | undefined) ??
            `Seller returned ${settled.status} without a JSON body: ${settled.text.slice(0, 160)}`,
        );
      }
      const body = settled.body as unknown as Receipt;
      setResource(body);
      const route = (body.transactions as { route?: { explorer?: string } } | undefined)?.route
        ?.explorer;
      mark('pay', {
        state: 'done',
        detail: `Paid ${formatUsd(BigInt(requirement.maxAmountRequired))} USDC, routed to the agent splitter`,
        explorer: route,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setStages((prev) => prev.map((stage) =>
        stage.state === 'active' ? { ...stage, state: 'failed', detail: message } : stage,
      ));
    } finally {
      setBusy(false);
      if (wallet) await readBalances(wallet).catch(() => undefined);
    }
  };

  const onWrongChain = wallet !== null && wallet.chainId !== ARC_TESTNET.id;
  const needsApproval = allowance !== null && price !== null && allowance < price;
  const noGas = native !== null && native === 0n;
  const noUsdc = usdc !== null && price !== null && usdc < price;

  return (
    <main className="content">
      <PageHeader
        eyebrow="PAYMENTS / WALLET"
        title="Buy from a Runway seller"
        subtitle="Connect a wallet, sign one authorization, and the revenue routes to the agent automatically."
      />

      <section className="section-card">
        <div className="section-heading">
          <div className="section-title-wrap">
            <div className="section-title">Flow</div>
            <div className="section-subtitle">
              EIP-3009 exact scheme on {ARC_TESTNET.name}, chain {ARC_TESTNET.id}
            </div>
          </div>
          <span className="section-kicker">{price ? `${formatUsd(price)} USDC` : 'LOADING'}</span>
        </div>

        <ol className="x402-steps" data-testid="pay-stages">
          {stages.map((stage) => (
            <li className={`x402-step progress-${stage.state}`} key={stage.id}>
              <span
                className={`x402-dot${stage.state === 'done' ? '' : stage.state === 'active' ? ' active' : stage.state === 'failed' ? ' fail' : ' pending'}`}
                aria-hidden
              />
              <span className="x402-step-name">{stage.label}</span>
              <span className="x402-step-detail">
                {stage.detail ?? (stage.state === 'pending' ? '' : stage.state)}
              </span>
              {stage.explorer && (
                <a href={stage.explorer} target="_blank" rel="noreferrer noopener" className="step-link">
                  tx
                </a>
              )}
            </li>
          ))}
        </ol>

        {error && (
          <p className="x402-error" role="alert" data-testid="pay-error">
            {error}
          </p>
        )}
      </section>

      <section className="section-card">
        <div className="section-heading">
          <div className="section-title-wrap">
            <div className="section-title">Wallet</div>
            <div className="section-subtitle">
              {wallet ? wallet.address : 'No wallet connected'}
            </div>
          </div>
          {wallet && (
            <span className="section-kicker">
              {onWrongChain ? `WRONG CHAIN · ${wallet.chainId}` : 'ARC TESTNET'}
            </span>
          )}
        </div>

        {!wallet ? (
          <div className="risk-body">
            {wallets.length === 0 ? (
              <>
                <p className="page-note">
                  No browser wallet detected. Install MetaMask or Rabby, add Arc Testnet, and
                  reload. Or use the hosted buyer, which pays with the operator key.
                </p>
                <a className="primary-button" href="/x402">
                  Use the hosted buyer instead
                </a>
              </>
            ) : (
              <div className="x402-actions">
                {wallets.map((option) => (
                  <button
                    className="primary-button"
                    type="button"
                    key={option.uuid}
                    disabled={busy}
                    onClick={doConnect}
                    data-testid="btn-connect"
                  >
                    {busy ? 'Waiting for approval…' : `Connect ${option.name}`}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="risk-body">
            <div className="param-grid">
              <div className="param">
                <div className="param-label">USDC balance</div>
                <div className="param-value" data-testid="usdc-balance">
                  {usdc === null ? '—' : `${formatUsd(usdc)} USDC`}
                </div>
              </div>
              <div className="param">
                <div className="param-label">Gas balance</div>
                <div className="param-value">
                  {native === null ? '—' : `${native.toString()} wei`}
                </div>
              </div>
              <div className="param">
                <div className="param-label">Allowance</div>
                <div className="param-value">
                  {allowance === null ? '—' : `${formatUsd(allowance)} USDC`}
                </div>
              </div>
              <div className="param">
                <div className="param-label">Price</div>
                <div className="param-value">{price === null ? '—' : `${formatUsd(price)} USDC`}</div>
              </div>
            </div>

            <div className="x402-actions" style={{ marginTop: 14 }}>
              {onWrongChain && (
                <button className="primary-button" type="button" disabled={busy} onClick={doSwitch} data-testid="btn-switch">
                  Switch to Arc testnet
                </button>
              )}
              {needsApproval && (
                <button className="primary-button" type="button" disabled={busy} onClick={doApprove} data-testid="btn-approve">
                  Approve {price !== null ? formatUsd(price * 1000n) : ''} USDC
                </button>
              )}
              <button
                className="primary-button"
                type="button"
                disabled={busy || onWrongChain || needsApproval || noGas || noUsdc}
                onClick={doPay}
                data-testid="btn-pay"
              >
                {busy ? 'Working…' : `Pay ${price === null ? '' : formatUsd(price)} USDC`}
              </button>
            </div>

            {noUsdc && (
              <p className="page-note">
                This wallet holds less than the price. Fund it with Arc testnet USDC, or use the
                hosted buyer.
              </p>
            )}
            {noGas && (
              <p className="page-note">
                This wallet holds no native token, so it cannot send a transaction. The seller
                settles the payment, so only gas matters for approvals.
              </p>
            )}
          </div>
        )}
      </section>

      {resource !== null && (
        <section className="section-card" data-testid="pay-resource">
          <div className="section-heading">
            <div className="section-title-wrap">
              <div className="section-title">
                {resource.description ?? 'Resource delivered'}
              </div>
              <div className="section-subtitle">
                Paid on chain. The receipt is already in the agent&apos;s splitter, so the
                lender&apos;s share settles from this payment without anyone chasing it.
              </div>
            </div>
            <span className="section-kicker">{resource.settled ? 'SETTLED' : 'PENDING'}</span>
          </div>

          <div className="risk-body">
            <div className="param-grid">
              <div className="param">
                <div className="param-label">Paid</div>
                <div className="param-value">{resource.paid?.formatted ?? '—'} USDC</div>
              </div>
              <div className="param">
                <div className="param-label">Payer</div>
                <div className="param-value" title={resource.payer}>
                  {shortAddress(resource.payer ?? '')}
                </div>
              </div>
              <div className="param">
                <div className="param-label">Seller</div>
                <div className="param-value" title={resource.seller}>
                  {shortAddress(resource.seller ?? '')}
                </div>
              </div>
              <div className="param">
                <div className="param-label">Lender share</div>
                <div className="param-value">
                  {resource.revenueShareBps !== undefined
                    ? `${resource.revenueShareBps / 100}%`
                    : '—'}
                </div>
              </div>
            </div>

            <div className="tx-list" style={{ marginTop: 16 }}>
              <TxRow
                label="Pull from payer"
                detail="USDC moved under your EIP-3009 signature"
                hash={resource.transactions?.pull?.hash}
                explorer={resource.transactions?.pull?.explorer}
              />
              <TxRow
                label="Route to splitter"
                detail="Revenue attributed to the agent, lender share settles from it"
                hash={resource.transactions?.route?.hash}
                explorer={resource.transactions?.route?.explorer}
              />
            </div>

            <div className="x402-actions" style={{ marginTop: 16 }}>
              <a
                className="primary-button"
                href="/splitters"
              >
                See the agent&apos;s revenue
              </a>
              <a className="secondary-button" href="/tests">
                Run the protocol checks
              </a>
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  setResource(null);
                  setStages(STAGES.map((st) => ({ ...st, state: 'pending' })));
                }}
              >
                Pay again
              </button>
            </div>

            <details className="raw-details">
              <summary>Raw response</summary>
              <pre className="code-block">{JSON.stringify(resource, null, 2)}</pre>
            </details>
          </div>
        </section>
      )}

      <section className="section-card">
        <div className="section-heading">
          <div className="section-title-wrap">
            <div className="section-title">Why approval is separate</div>
            <div className="section-subtitle">The one step worth reading before you click it</div>
          </div>
        </div>
        <div className="risk-body">
          <div className="check-list">
            <li className="ok">
              EIP-3009 is a pull. The seller cannot move your USDC on signature alone, so it
              needs a standing allowance first.
            </li>
            <li className="bad">
              Approving grants permission that outlives this request. Approve the smallest amount
              you need, or revoke it afterwards.
            </li>
            <li className="ok">
              Each payment uses a fresh nonce, so a signature cannot be replayed.
            </li>
          </div>
        </div>
      </section>

      <PageFooter />
    </main>
  );
}

/** One transaction, linked to the explorer. */
function TxRow(props: { label: string; detail: string; hash?: string; explorer?: string }) {
  return (
    <div className="tx-row">
      <span className="tx-dot" aria-hidden />
      <span className="tx-body">
        <span className="tx-label">{props.label}</span>
        <span className="tx-detail">{props.detail}</span>
      </span>
      {props.explorer ? (
        <a
          className="secondary-button"
          href={props.explorer}
          target="_blank"
          rel="noreferrer noopener"
        >
          View on explorer
        </a>
      ) : (
        <span className="section-kicker">PENDING</span>
      )}
    </div>
  );
}

/** Must match the seller's payTo; the vault and dashboard both use this splitter. */
const SELLER_PAY_TO = '0x06cebc9403c00d972e014e452509d04c7c350880' as `0x${string}`;