# Runway — hosted operations guide

Everything below runs on Vercel. You do not need a terminal, a local keeper, or
any background process to test the protocol.

- **App:** https://runwaay-ivory.vercel.app
- **Network:** Base Sepolia (chain `84532`)

## 1. Open the app

Visit the URL above. The page is not a mock: every figure is a direct contract
read served by `/api/status`, polled every 15 seconds.

| Panel | What it shows |
| --- | --- |
| Operations overview | Active splitters, open advances, vault balance, lifetime revenue |
| Hosted x402 loop | Button that runs the whole payment flow end to end |
| Splitters / Advances / Repayments / Recent transactions | Live event history from the chain |
| Threat model | The failure modes this design still has |

## 2. Run a real x402 payment

Click **Run x402 payment (0.1 USDC)** in the "Hosted x402 loop" panel. Five steps
appear as they confirm on-chain:

1. **402 challenge received** — `GET /api/x402/resource` returns HTTP 402 with a
   base64 `X-PAYMENT` header and a `WWW-Authenticate: X-PAYMENT` challenge.
2. **USDC approval** — the buyer grants the seller an EIP-3009 allowance.
3. **EIP-3009 authorization signed** — an EIP-712 `TransferWithAuthorization`
   over the USDC domain (`name: "USDC"`, `version: "2"`, chain 84532).
4. **Resource delivered and receipt routed** — the seller recovers the signer,
   checks the allowance and the nonce, pulls the USDC with
   `transferWithAuthorization`, then forwards it to the `RevenueSplitter`.
5. **Keeper settled receipt** — `settle()` splits the receipt 30% lender / 70%
   agent, repaying the vault first.

The flow took about 8 seconds end to end in testing.

## 3. Inspect the raw endpoints

| Endpoint | Purpose | Auth |
| --- | --- | --- |
| `GET /api/status` | Full protocol snapshot as JSON | none |
| `GET /api/x402/resource` | Returns 402 + payment challenge | none |
| `POST /api/demo/buy?amount=100000` | Runs the full x402 flow | throttled |
| `GET /api/keeper?auto=1` | Settles any revenue above the threshold | rate limited |
| `GET /api/keeper` | Keeper with force/override | `x-keeper-secret` header |

Try the 402 challenge by hand:

```bash
curl -i https://runwaay-ivory.vercel.app/api/x402/resource
```

## 4. How the keeper runs without a local process

Vercel's Hobby plan only permits **daily** cron jobs, so a 5-minute cron is not
available. Runway handles this two ways:

- The dashboard pings `/api/keeper?auto=1` every 45 seconds while a browser tab
  is open. That path can only settle revenue already above the threshold, and
  the endpoint ignores repeat calls within 15 seconds.
- A daily cron (`0 12 * * *`) runs as a backstop.

Every `/api/demo/buy` call also settles inline, so a payment is never left
unrouted even if nobody has the dashboard open.

## 5. Deployed contracts (Base Sepolia)

| Contract | Address |
| --- | --- |
| `RunwayVault` | `0x50521815D832eb80BabBA0f888c686Fb224f2Dd4` |
| `RevenueSplitter` (impl) | `0xb220f46e18166F5e4DAe0B8EB826ab27c8305110` |
| `RunwayFactory` | `0xC278850c7194a8ecD8b81A223847F995Ad56fCdf` |
| Agent `RevenueSplitter` | `0x96030e714e14b848445b40dfc327d828a3f474f6` |
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

Contracts are **not** verified on BaseScan. No explorer API key was available.

## 6. Verified end-to-end result

Loan `0` was opened for 1 USDC and driven to zero outstanding through the hosted
x402 route:

| Metric | Value |
| --- | --- |
| Loan principal | 1.00 USDC |
| Loan repaid | 1.00 USDC |
| Vault outstanding | 0 USDC |
| Loan status | `active = false` |
| Lender share routed to vault | 30% of every settled receipt |
| Agent share credited | 70% of every settled receipt |

## 7. Known issues — read before using real funds

These are real defects in the current contracts, not display problems:

1. **Agent claim can exceed custody.** `setLoanActive` credits the loan
   principal to `agentClaimable`, so the agent is owed tokens the contract no
   longer holds. `withdraw()` will revert if the balance is short. Observed
   `agentClaimable` of 9.48 USDC against 8.78 USDC actually held.
2. **Flat fee is never charged.** `feeBps` is stored but `repay()` only ever
   collects the supplied principal, so the 8% fee in the PRD is not applied.
3. **Excess lender share is stranded.** When the lender share exceeds the
   outstanding balance, `RunwayVault.repay` caps the repayment and the remainder
   stays in the splitter, credited to nobody.
4. **`settle()` can underflow.** `lastSettledBalance` is set to the principal at
   loan open, so if the agent withdraws before the next settlement the
   subtraction reverts.
5. **The factory does not use clones.** It deploys full `RevenueSplitter`
   contracts while `splitterImplementation` and the `Clones` import go unused.
6. **`withdraw()` ignores outstanding debt.** An admin can drain vault funds that
   are still owed to lenders.
7. **No watcher or underwriter service exists.** Both are referenced in the PRD
   and in the threat model but are not implemented.
8. **The operational key is in the Vercel environment.** It is a testnet key
   that was already exposed in an earlier session, so it must be rotated before
   any public demo or non-testnet use.

## 8. Operating the hosted stack

```bash
cd artifacts/runway

npm run typecheck          # covers src/ and api/
npm run build

npx vercel --prod --yes    # deploy

# run the handlers locally against Base Sepolia
pnpm exec tsx ../../scripts/test-api.ts /api/status
pnpm exec tsx ../../scripts/test-api.ts "/api/demo/buy?amount=100000" --auth
```

Secrets live in Vercel as encrypted environment variables:

| Variable | Purpose |
| --- | --- |
| `RUNWAY_PRIVATE_KEY` | Signs authorizations and keeper settlements |
| `RUNWAY_KEEPER_SECRET` | Authorises `/api/keeper` overrides |
| `CRON_SECRET` | Authenticates the scheduled keeper run |

Public configuration lives in `vercel.json` (`RUNWAY_RPC_URL`, contract
addresses, settle threshold).

## 9. Demo safety limits

The buyer and seller share one operational account, so each dashboard click
moves USDC out of that wallet and into the splitter, where bug 1 and bug 3 above
strand part of it. The endpoint therefore refuses to run rather than draining the
wallet unattended:

| Limit | Value |
| --- | --- |
| Max amount per dashboard click | 0.1 USDC |
| Cooldown between dashboard clicks | 30 s |
| Cap per UTC day | 1 USDC |
| Wallet floor | 0.5 USDC remaining, otherwise the demo returns 429 |

Authenticated calls (with `x-keeper-secret`) bypass these limits. The current
wallet holds roughly 2.1 USDC, so the public demo has a limited runway before it
starts returning 429. Fund it, or pass the secret.
