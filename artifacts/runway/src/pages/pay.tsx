import { useCallback, useEffect, useState } from 'react';

import { PageFooter, PageHeader } from '@/components/app-shell';
import { shortAddress, useChainStatus } from '@/lib/chain-status';
import { Section } from '@/components/section';
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
  // Only the explorer base comes from here. Addresses and the token deliberately
  // do not: the seller's challenge is authoritative for those, so the page can
  // never approve one splitter while paying another.
  const { data } = useChainStatus();
  const explorerBase =
    data?.contracts?.vault?.explorer?.replace(/\/address\/.*$/, '') ?? 'https://explorer.testnet.arc.io';
  const [wallets, setWallets] = useState<{ uuid: string; name: string }[]>([]);
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [usdc, setUsdc] = useState<bigint | null>(null);
  const [native, setNative] = useState<bigint | null>(null);
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [price, setPrice] = useState<bigint | null>(null);
  // Both come from the seller's own x402 challenge, which is authoritative.
  const [payTo, setPayTo] = useState<`0x${string}` | null>(null);
  const [asset, setAsset] = useState<`0x${string}` | null>(null);
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

  // The seller advertises its price and its payTo without payment, so both can
  // be shown before a wallet is connected.
  //
  // payTo comes from the challenge rather than a constant in this file. It used
  // to be hardcoded, which meant the allowance was granted to one address while
  // the payment went to whatever the challenge said. Those agreed only by luck:
  // repoint the deployment and the page would approve the old splitter and pay
  // the new one, or approve an allowance nothing could use.
  useEffect(() => {
    fetch('/api/demo/sell-x402', { cache: 'no-store' })
      .then((response) => response.json())
      .then(
        (challenge: { accepts?: { maxAmountRequired: string; payTo?: string; asset?: string }[] }) => {
          const first = challenge.accepts?.[0];
          if (first?.maxAmountRequired) setPrice(BigInt(first.maxAmountRequired));
          if (first?.payTo) setPayTo(first.payTo as `0x${string}`);
          if (first?.asset) setAsset(first.asset as `0x${string}`);
        },
      )
      .catch(() => undefined);
  }, []);

  // Keeps the page honest about the session: MetaMask revoking the site's
  // connection or switching accounts does not ask us anything, it just fires
  // events. Without these listeners the flow kept showing a "connected" state
  // long after the wallet was gone, so a fresh connect or the wrong account
  // went unnoticed. On disconnect (or active-account change) we drop the
  // session and surface the connect prompt again.
  useEffect(() => {
    if (!wallet) return;
    const provider = wallet.provider;

    const drop = () => {
      setWallet(null);
      setUsdc(null);
      setNative(null);
      setAllowance(null);
      setResource(null);
      setStages(STAGES.map((s) => ({ ...s, state: 'pending' })));
      setError('Wallet disconnected. Connect again to continue.');
    };

    const onAccountsChanged = (accounts: unknown) => {
      const list = accounts as string[];
      if (!list || list.length === 0) return drop();
      // A different account is now active; require a deliberate reconnect so the
      // balances and allowances shown always belong to the connected address.
      if (list[0].toLowerCase() !== wallet.address.toLowerCase()) return drop();
    };

    const onChainChanged = (chain: unknown) => {
      const parsed = Number.parseInt(String(chain), 16);
      setWallet((current) => (current ? { ...current, chainId: parsed } : current));
    };

    const onDisconnect = () => drop();

    provider.on('accountsChanged', onAccountsChanged);
    provider.on('chainChanged', onChainChanged);
    provider.on('disconnect', onDisconnect);
    return () => {
      provider.removeListener('accountsChanged', onAccountsChanged);
      provider.removeListener('chainChanged', onChainChanged);
      provider.removeListener('disconnect', onDisconnect);
    };
  }, [wallet]);

  // Plain function, deliberately not memoized: it reads `payTo` and `asset`,
  // which arrive asynchronously from the challenge after the first render. A
  // useCallback with empty deps froze those references from the first render,
  // so every allowance read hit the sentinel zero address instead of the
  // splitter - the approval looked like it never landed and the flow deadlocked
  // on approving over and over.
  async function readBalances(target: ConnectedWallet) {
    const [token, gas, allowed] = await Promise.all([
      getUsdcBalance(target, asset ?? undefined),
      getNativeBalance(target),
      getAllowance(target, payTo ?? PAY_TO_UNAVAILABLE, asset ?? undefined),
    ]);
    setUsdc(token);
    setNative(gas);
    setAllowance(allowed);
  }

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
      if (!payTo) {
        setError('The seller did not advertise a payment address. Reload and try again.');
        mark('approve', { state: 'failed', detail: 'no payTo in the challenge' });
        return;
      }
      const hash = await approveUsdc(wallet, payTo, price * 1000n, asset ?? undefined);
      mark('approve', {
        state: 'done',
        detail: `${formatUsd(price * 1000n)} USDC allowance`,
        explorer: `${explorerBase}/tx/${hash}`,
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
        // The signed domain must match the token and chain being paid on.
        token: asset ?? undefined,
        chainId: data?.chainId,
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

      <Section
        title="Flow"
        subtitle={`EIP-3009 exact scheme on ${ARC_TESTNET.name}, chain ${ARC_TESTNET.id}`}
        kicker={price ? `${formatUsd(price)} USDC` : 'LOADING'}
        testId="pay-flow"
      >
        <div className="section-body">
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
        </div>
      </Section>

      <Section
        title="Wallet"
        subtitle={wallet ? wallet.address : 'No wallet connected'}
        kicker={wallet ? (onWrongChain ? `WRONG CHAIN · ${wallet.chainId}` : 'ARC TESTNET') : undefined}
        testId="pay-wallet"
      >

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
      </Section>

      {resource !== null && (
        <Section
          title={resource.description ?? 'Resource delivered'}
          subtitle="Paid on chain. The receipt is already in the agent's splitter, so the lender's share settles from this payment without anyone chasing it."
          kicker={resource.settled ? 'SETTLED' : 'PENDING'}
          testId="pay-resource"
        >

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
        </Section>
      )}

      <Section
        title="Why approval is separate"
        subtitle="The one step worth reading before you click it"
        testId="pay-approval-note"
      >
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
      </Section>

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

/**
 * Sentinel used only to read an allowance before the challenge has resolved.
 * Never approved or paid; the pay flow refuses to run until payTo is known.
 */
const PAY_TO_UNAVAILABLE = '0x0000000000000000000000000000000000000000' as `0x${string}`;