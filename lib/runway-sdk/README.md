# Runway SDK

Revenue-routed working capital for AI agents on Arc. An agent's x402 payment
revenue is the collateral: a lender takes an automatic share of every incoming
payment, which is what makes an advance repayable without a credit check.

```bash
npm install @workspace/runway-sdk
```

Tested against Arc testnet (chain `5042002`) with real payments. Every number in
the examples below came off the chain.

## Seller: get paid and route the revenue

This is the whole integration. The SDK issues the 402, verifies the EIP-3009
signature, pulls the funds, and forwards them to your splitter.

```ts
import { createRunwayClient, createSeller, usdc } from '@workspace/runway-sdk';

const runway = createRunwayClient({
  chainId: 5042002,
  network: 'arc-testnet',
  rpcUrl: process.env.ARC_TESTNET_RPC,
  privateKey: process.env.PRIVATE_KEY,   // needed to pull and route
});

const seller = createSeller({
  runway,
  splitter: '0xYourSplitter',
  price: usdc(0.1),
  description: 'Document extraction',
  resource: 'https://api.example.com/extract',
});

// Unpaid request: return the challenge.
app.get('/extract', async (req, res) => {
  const result = await seller.verify(req.headers['x-payment'] as string | undefined);
  if (!result.ok) {
    if (result.status === 402) return res.status(402).json(seller.challenge());
    return res.status(result.status).json({ error: result.error });
  }
  res.setHeader('X-PAYMENT-RESPONSE', encodeHeader({ success: true, transaction: result.transactions.route }));
  res.json({ text: 'extracted…' });
});
```

`verify()` checks all of it before accepting money: the scheme and network, that
the recipient is you, that the amount is not short, the validity window against
chain time, the recovered signer against the claimed payer, the ERC-20
allowance, and the nonce. Failures come back as `{ ok: false, status, error }`
rather than throwing.

## Agent: read your position

```ts
import { getSplitterStatus, formatUsdc } from '@workspace/runway-sdk';

const status = await getSplitterStatus(runway, '0xYourSplitter');
console.log(formatUsdc(status.lifetimeRevenue), status.debtOwed, status.claimable);
```

Returns `balance`, `lifetimeRevenue`, `unsettled`, `claimable`, `advanceHeld`,
`agentOwed`, `debtOwed` and `loanActive`.

## Settle

`settle()` pays the lender their share of revenue that just arrived and credits
the rest to you. It is **permissionless**, so a keeper can call it for you, or
anyone can front the gas.

```ts
import { settle } from '@workspace/runway-sdk';
await settle(runway, '0xYourSplitter');
```

## Request an advance

```ts
import { requestAdvance, usdc } from '@workspace/runway-sdk';
await requestAdvance(runway, {
  splitter: '0xYourSplitter',
  principal: usdc(10),
  rationale: '18 days of revenue history, single payer at 40%',
});
```

Needs the vault's `UNDERWRITER_ROLE`. The cap is
`min(STARTER_CAP + 2 * lifetimeRevenue, GLOBAL_MAX)` and is enforced on-chain, so
an oversized request reverts rather than silently over-advancing. The rationale
is hashed into the loan, so it stays auditable.

## Deploy a splitter

```ts
import { createSplitter } from '@workspace/runway-sdk';
const splitter = await createSplitter(runway, { agent: myAddress });
```

Needs the factory's `DEFAULT_ADMIN_ROLE`.

## Verify it works

Two runnable checks. The first never talks to a seller; the second buys from a
running one.

```bash
# reads vault and splitter state, issues a 402, and settles a real payment
pnpm verify

# start services/demo-seller first, then buy from it over HTTP
pnpm buy
```

## Amounts

USDC has 6 decimals. `usdc(0.1)` is `100000n`. Always build amounts through
`usdc()`: `0.1 * 1e6` in floating point is `99999.99999999999`, and a price that
drifts by one base unit breaks signature comparison.

## Addresses

Defaults target Arc testnet. Override `usdc`, `factory` and `vault` for another
deployment:

```ts
createRunwayClient({ chainId, network, rpcUrl, usdc, factory, vault, privateKey });
```

`chainId` is part of the EIP-712 domain the payer signs, so it must match the
chain the payment settles on. Get it wrong and every payment is rejected.

## What the SDK does not do

- **It does not custody anything.** Funds move payer → splitter → lender share.
- **It does not credit-check.** The underwriter and the on-chain cap decide
  whether an advance is granted.
- **It is unaudited.** See the threat model in the repository README.

## Troubleshooting

**`Payer has not approved the seller`** — EIP-3009 is a pull. The payer must
`approve` the splitter before a signature is any use. Buyers do this once.

**`Authorization nonce has already been used`** — replay protection working. Use
a fresh nonce per request.

**`invalid signature 'v' value`** — you passed `v` as 0/1 to
`transferWithAuthorization`. `ecrecover` wants 27/28. Use `splitSignature()`.

**Reads return empty data** — check the address. viem omits `to` when the address
is `undefined`, and the RPC returns `0x` rather than an error.