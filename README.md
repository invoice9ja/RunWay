# Runway

> **Revenue-routed working capital for AI agents on Arc.**

Runway is a financial primitive that enables AI agents to access working capital without collateral, credit history, or legal identity. By routing x402 payment revenue through a smart contract splitter, lenders receive a senior claim on every incoming payment — repayment is enforced by how money flows, not by trust.

---

## The Problem

AI agents that sell services (data, inference, tools) over x402 face a fundamental bootstrapping problem:

| Challenge | Why It Matters |
|-----------|----------------|
| **Cash-flow negative at start** | Agents pay for inference, data, or API access *before* revenue arrives |
| **No traditional credit** | No credit score, no legal entity, no recourse for lenders |
| **Over-collateralized DeFi doesn't help** | Agents have no capital to post as collateral |
| **Enforcement is the blocker** | You can't sue software — the only credible enforcement is controlling where money lands |

---

## How It Works

```
Buyer Agent ──x402 pay──▶ Seller Endpoint (payTo = RevenueSplitter)
                               │ USDC (EIP-3009)
                               ▼
                         RevenueSplitter ◀── settle() ── Keeper
                          │ repay share          │ agentClaimable
                          ▼                      ▼
                     RunwayVault             Agent withdraw()
                          ▲
         Underwriter (LLM + rules) ── openLoan ─┘      Watcher ── flagLoan
```

### Core Mechanism

1. **Register** — Operator registers an agent; factory deploys a `RevenueSplitter` (minimal clone) bound to the agent
2. **Route** — Operator sets the endpoint's x402 `payTo` to the splitter address
3. **Earn** — Buyers pay the endpoint; USDC (EIP-3009 `transferWithAuthorization`, per x402 "exact") lands in the splitter
4. **Settle** — Anyone (keeper) calls `settle()` on schedule. The splitter sends `shareBps` of new revenue to the vault until the loan is repaid; the rest becomes claimable by the agent
5. **Withdraw** — Agent can only reach its money through `withdraw()`, so it can't bypass the lender's share
6. **Underwrite** — AI underwriter proposes a limit from on-chain revenue history; hard caps in the contract bound what it can do
7. **Watch** — Watcher polls the endpoint, verifies the payee still equals the splitter; on mismatch, flags the loan (blocks further advances)

### Why `settle()`?

ERC-20 transfers to a contract don't execute receiver code. Because the agent can only withdraw through the splitter, deferring the split to `settle()` still preserves the guarantee — the agent *cannot* access funds without the lender's share being paid first.

---

## Architecture

### Smart Contracts (Solidity + Foundry)

| Contract | Responsibility |
|----------|----------------|
| `RunwayFactory` | Deploys `RevenueSplitter` clones, registers them in the vault |
| `RevenueSplitter` | Receives revenue, splits on `settle()`, manages agent claimable balance |
| `RunwayVault` | Holds lender funds, opens loans with capped terms, manages repayment |

**Key Libraries:** OpenZeppelin `AccessControl`, `ReentrancyGuard`, `SafeERC20`, `Clones`

### Off-Chain Services (TypeScript + viem)

| Service | Purpose |
|---------|---------|
| **Keeper** | Calls `settle()` on splitters with balance above threshold |
| **Watcher** | Polls borrower endpoints, parses x402 requirements, verifies payee = splitter |
| **Underwriter** | Computes features from logs, queries LLM for limit + rationale, clamps to caps, submits `openLoan` |
| **Demo Seller** | Paid endpoint using x402 with Arc USDC |
| **Demo Buyer** | Generates paid traffic with real, small payments |

### Dashboard (Vite + React + Vercel)

Nine routes: overview, splitters, advances, repayments, transactions, x402,
contracts, threat model. Reads chain state directly through serverless endpoints
(`/api/status`, `/api/keeper`, `/api/x402/resource`, `/api/demo/buy`), with
explorer links throughout. Public read-only; operator actions post-submission.

### Data Layer

- **Indexer**: Reads contract logs directly. No separate indexing service for the MVP.
- **Database**: `lib/db` exists as a Drizzle scaffold and is imported by
  `artifacts/api-server`. Neither is used by the dashboard or services, which read
  the chain directly. There is no Supabase project wired up, despite what an
  earlier draft of this README said.

---

## Contract Specification (from PRD)

### RevenueSplitter

```solidity
// Minimal clone via Clones
contract RevenueSplitter {
    address immutable vault;
    address immutable agent;
    address payout; // mutable via setPayout (blocked while loan active)
    uint256 shareBps; // lender share in basis points (e.g., 3000 = 30%)
    uint256 agentClaimable; // accrued agent share
    uint256 lastSettledBalance; // USDC balance at last settle()

    function settle() external; // permissionless, idempotent
    function withdraw() external; // pull-based, only agent
    function setPayout(address) external; // blocked while loan outstanding
}
```

**Events:**
- `Settled(uint256 revenue, uint256 lenderShare, uint256 agentShare)`
- `Withdrawn(address indexed agent, uint256 amount)`
- `PayoutChanged(address indexed oldPayout, address indexed newPayout)`

### RunwayVault

```solidity
contract RunwayVault {
    struct Loan {
        address splitter;
        uint256 principal;
        uint256 feeBps; // 800 = 8%
        uint256 shareBps; // 3000 = 30%
        uint256 dueDate; // block.timestamp + 30 days
        uint256 repaid;
        bool delinquent;
        bytes32 rationaleHash;
    }

    function openLoan(address splitter, uint256 principal, bytes32 rationaleHash) external; // underwriter role only
    function markDelinquent(uint256 loanId) external; // permissionless
    function pause() / unpause() external; // owner only
}
```

**Events:**
- `LoanOpened(uint256 indexed loanId, address indexed splitter, uint256 principal, uint256 feeBps, uint256 shareBps, uint256 dueDate, bytes32 rationaleHash)`
- `Repaid(uint256 indexed loanId, uint256 amount)`
- `Delinquent(uint256 indexed loanId)`
- `Flagged(uint256 indexed loanId, bytes32 reasonHash)`
- `Paused(bool paused)`

### RunwayFactory

```solidity
contract RunwayFactory {
    function createSplitter(address agent, address payout) external returns (address splitter);
}
```

**Events:**
- `SplitterCreated(address indexed splitter, address indexed agent, address payout)`

---

## Underwriting

### Features (from on-chain logs)
- 7-day & 30-day revenue
- Active days
- Revenue trend (linear regression slope)
- Distinct payers
- Top-payer concentration (HHI or top-1 % share)
- Wash-trading flag (payers funded by agent/operator wallet within 2 hops, last 30 days)

### Output Schema
```json
{
  "limit_usdc": 500,
  "confidence": 0.78,
  "reasons": ["steady 30d revenue", "diverse payer base"],
  "risks": ["single large payer 40%"],
  "wash_flag": false
}
```

### Control
- Model **never** has authority
- Final limit = `min(model_limit, rule_limit, on_chain_cap)`
- Rationale JSON is hashed; hash emitted in `LoanOpened` event for verification

### What is actually built

`services/underwriter/` scores a splitter and commits the decision to the loan's
`rationaleHash`, which the vault stores and never reads. That is the design: the
hash makes the rationale auditable after the fact and keeps the policy out of the
contract.

Two scoring modes. An optional LLM pass sees only on-chain metrics and returns a
score plus reasons; it cannot return an amount or an address, so it cannot widen a
position. A deterministic rules engine is always available as the fallback and as
the thing to reason against. Every threshold is named and the output is
reproducible from the same chain state.

When the two modes **disagree on approve or decline**, the service declines and
asks for a human. A disagreement means the metrics are wrong or the policy has
drifted, and neither should open a position.

`UNDERWRITER_DRY_RUN` defaults to `true`, so nothing is opened unless opted in.

Verified against the live testnet deployment: a splitter with 36 USDC lifetime
revenue and two prior advances scored 75 (threshold 60) and was approved without
calling `openLoan`.

### Watcher

`services/watcher/` holds `WATCHER_ROLE` and decides which splitters to flag.
`flagLoan` is the only way to mark an agent unborrowable, so what the service adds
is the decision. Three rules, each derived from on-chain state and each carrying
its evidence:

| Rule | Trigger |
|---|---|
| `missed-repayment` | Advance past its due date with debt outstanding |
| `payout-swap` | `PayoutChanged` while an advance is active |
| `cap-inflation` | Outstanding debt ≥ 90% of lifetime revenue |

`WATCHER_ALLOW` is empty by default, so the service reports and calls
`markDelinquent` (which is permissionless) but never flags. A flag is permanent
for the loan, so it should be hard to enable by accident. The watcher key is kept
separate from the underwriter key so a compromised scorer cannot flag at will.

---

## Loan Terms (MVP Defaults)

| Parameter | Default | Notes |
|-----------|---------|-------|
| Flat fee | 8% | One-time, added to principal |
| Revenue share | 30% | Per `settle()` until repaid |
| Soft due date | 30 days | Past due + outstanding → `markDelinquent()` blocks new advances |
| Global max per agent | Configurable | Hard cap in vault |
| Starter cap | Configurable | Base allowance before revenue history |

**No liquidation. No collateral. No legal enforcement.**

---

## Threat Model

| Threat | Mitigation | Residual Risk |
|--------|------------|---------------|
| Agent changes endpoint `payTo` to own address | Watcher flags within one polling interval; advances small; further advances blocked | Revenue between swap and flag is lost |
| Wash trading to inflate revenue | Cap grows only 2× lifetime revenue; wash heuristic; hard global cap | Sophisticated multi-wallet loops (bounded by cap) |
| Borrower stops selling | Flat fee + revenue share: no revenue = no repayment | Lender loses principal (bounded by cap) |
| Underwriter key compromised | Role can only open loans within on-chain caps; pause switch | Loss bounded by `GLOBAL_MAX` per agent |
| USDC blacklist blocks agent payout | Pull-based `withdraw()`; repayment leg never touches agent address | Agent can't withdraw its own share |
| Reentrancy / accounting bugs | `ReentrancyGuard`, invariant tests, one regression test per fixed defect | **Unaudited — the tests were written alongside the fix, so they are not an independent check** |
| Regulatory | Own funds only, no external depositors, labeled prototype | Real lending would need licensing analysis |

### Defects found and fixed

Six accounting defects were found by audit and are fixed. Each has a named
regression test. The full list is tracked on the dashboard's `/threats` route,
which separates open risks from resolved items.

| Defect | Fix |
|---|---|
| Flat fee never charged | `repay()` applies against `totalDue` and returns the amount applied |
| Agent claim exceeded custody | `agentClaimable` split from `advanceHeld`; `withdraw()` bounded by tokens held |
| Excess lender share stranded | `repay()` returns what it applied; splitter caps first, remainder to the agent |
| `settle()` could underflow | `lastSettledBalance` drops by the full amount withdrawn |
| `withdraw()` ignored outstanding debt | `availableToWithdraw()` excludes advances; `withdraw()` is bounded by it |
| Factory did not use clones | `Clones.clone` plus `initialize()`; 45-byte runtime |

Debt was also tracked in two places (vault and splitter) and the copies drifted.
The vault is now the single source of truth.

---

## Non-Goals (MVP)

- ❌ No external lenders, no pooled deposits, no yield promises
- ❌ No liquidation engine, no collateral, no legal enforcement
- ❌ No claim of security audit — this is a prototype
- ❌ No dependence on Arc privacy features or Circle Payments Network (planned/upcoming)
- ❌ No fiat on/off-ramp

---

## Stack

- **Contracts**: Solidity, Foundry, OpenZeppelin
- **Services**: TypeScript, viem
- **AI**: optional LLM pass in the underwriter, with a deterministic fallback
- **Dashboard**: React + Tailwind on Vercel, reading chain state directly
- **Deployment**: Vercel (dashboard), Arc testnet (contracts); mainnet pending

---

## Repository Structure

```
RunWay/
├── artifacts/runway/      # Dashboard (Vite + React), 9 routes, Vercel-hosted
│   ├── api/               # Serverless: status, keeper, x402, demo buy
│   │   └── _lib/          # config, events, chain reads
│   ├── src/
│   │   ├── pages/         # overview, splitters, advances, repayments,
│   │   │                  # transactions, x402, contracts, threats
│   │   ├── components/    # app shell, sidebar, shared UI
│   │   └── lib/           # chain status, formatting
│   ├── vercel.json        # Arc testnet env + cron
│   └── package.json
├── contracts/             # Solidity contracts (Foundry)
│   ├── src/
│   │   ├── RevenueSplitter.sol   # agent revenue pot, settle(), withdraw()
│   │   ├── RunwayVault.sol       # lender deposits, advances, repayment
│   │   └── RunwayFactory.sol     # minimal proxy deployment
│   ├── test/              # 29 unit tests + 8 invariants
│   ├── script/            # Deploy, CreateSplitter, Deposit, OpenLoan
│   └── foundry.toml
├── lib/runway-sdk/        # Published SDK: x402 seller, splits, advances
├── services/              # TypeScript services
│   ├── keeper/            # settle() caller
│   ├── watcher/           # flags splitters that break the rules
│   ├── underwriter/       # scores splitters, writes rationaleHash
│   ├── demo-seller/       # x402 endpoint
│   └── demo-buyer/        # traffic generator
├── scripts/               # Deployment, verification, secret scanning
│   ├── scan-secrets.mjs   # audits tracked files and history blobs
│   └── pre-commit-secrets.sh
├── lib/                   # OpenZeppelin + forge-std (submodules)
├── .env.example           # every variable, no secrets
├── runway-prd.md          # Product Requirements Document
└── README.md              # This file
```

---

## Roadmap & Status

### Current Stage: **Testnet deployment live, three cycles repaid**

Contracts are written, tested, deployed and verified on Arc testnet (chain 5042002).
Three advances have been opened and driven to zero outstanding. The dashboard
reads that deployment, and the watcher and underwriter services run against it.

#### Deployed on Arc testnet

| Contract | Address |
|---|---|
| `RunwayVault` | [`0x30f5f5d45bbf94487fa3cae069d5bdaadb6744ab`](https://explorer.testnet.arc.io/address/0x30f5f5d45bbf94487fa3cae069d5bdaadb6744ab) |
| `RunwayFactory` | [`0xc8f5ae45cfbc7a9f17248fd610adc989f8d08106`](https://explorer.testnet.arc.io/address/0xc8f5ae45cfbc7a9f17248fd610adc989f8d08106) |
| `RevenueSplitter` (impl) | [`0xc880AF5d5aC3ea27c26C47D132661A710C245ea5`](https://explorer.testnet.arc.io/address/0xc880AF5d5aC3ea27c26C47D132661A710C245ea5) |
| `RevenueSplitter` (live clone) | [`0x96559D62bAD82F31853F3dd1b6C3c3ef9F434279`](https://explorer.testnet.arc.io/address/0x96559D62bAD82F31853F3dd1b6C3c3ef9F434279) |

USDC on Arc testnet is `0x3600000000000000000000000000000000000000`.

> The Arc testnet explorer runs **Blockscout**, not Etherscan. Verification uses
> `forge verify-contract --verifier blockscout --verifier-url https://explorer.testnet.arc.io/api`
> and needs no API key. See `contracts/foundry.toml`.

> **No mainnet deployment exists.** Everything in this document runs on Arc
> **testnet** (chain 5042002). The contracts have never been deployed to Arc
> mainnet (chain 5042): the testnet vault address returns no bytecode there, and
> the deployer held no mainnet funds. `deployed-mainnet.json` is a placeholder
> with `deployed: false`, and every script refuses to run against it rather than
> sending a transaction to an undefined address.
>
> Mainnet work is blocked on funding, not on code.

#### Loan cycles on Arc testnet

| Loan | Principal | Fee | Total due | Repaid | Outstanding |
|---|---|---|---|---|---|
| 0 | 10.00 | 8% | 10.80 | 10.80 | **0** |
| 1 | 10.00 | 8% | 10.80 | 10.80 | **0** |
| 2 | 12.00 | 8% | 12.96 | 12.96 | **0** |

117 USDC lifetime revenue routed through the splitter. Final vault debt 0,
splitter balance 0, `surplus()` 0. No loan delinquent or flagged.

Cycle 2 was run deliberately through the two failure cases that the first round
of fixes addressed: the agent withdrew its whole position *while debt was still
outstanding*, and the last settlement carried more revenue than the debt
remaining, so the lender share was capped and the remainder returned to the
agent rather than stranded.

**Caveat on this data:** the deployer was also the agent and the lender, and the
lending pool funded the demo revenue. That is fine for exercising the
accounting but it is not a demonstration of independent parties, and a reviewer
should read the cycles accordingly.

#### Tests

29 unit tests and 8 invariants, 128,000 invariant calls per run, all passing. One
regression test per fixed defect. The invariants assert the accounting identity
directly: no stranded tokens, claims never exceed custody, and vault balance
equals debt plus free balance.

### Submission Target: **Oct 7–8, 2026** (hard deadline Oct 14, 23:59 ET = Oct 15, 04:59 Lagos)

### Timeline (from PRD)

| Date | Work |
|------|------|
| **Oct 1** | Recon: Arc docs, USDC on Arc mainnet, repo scaffold |
| **Oct 2–3** | Contracts & tests (splitter, vault, factory), invariant tests |
| **Oct 4** | Testnet deploy and explorer verification (mainnet pending funding) |
| **Oct 5** | Demo seller/buyer with x402 on Arc; keeper |
| **Oct 6** | Loan cycles on testnet (3 advances repaid); status page. Mainnet cycles **not done** |
| **Oct 7** | README, threat model, submission description; **submit** |
| **Oct 8–13** | Watcher, underwriter, richer dashboard, second agent |

### Submission-Ready Criteria
- [x] Contracts verified on the Arc explorer; addresses in README (testnet)
- [x] ≥ 1 splitter, ≥ 3 loans opened and repaid (testnet; **mainnet still pending**)
- [x] Test suite passes, including invariant tests
- [ ] Live URL opens; public repo; public builder profile linked
- [ ] Fund the deployer on Arc mainnet, then deploy and run cycles there

### Post-Submission (Same Repo)
- [x] Watcher service
- [x] Underwriter service

- [ ] Richer dashboard
- [ ] Second demo agent

### Future Grant Milestones
1. Independent contract review
2. Self-serve onboarding for third-party agents
3. Pooled liquidity with external lenders (after legal review)
4. Circle Agent Marketplace listing integration

---

## Getting Started

### Prerequisites
- Node.js 20+
- pnpm 9+
- Foundry (`foundryup`)
- Arc testnet USDC. The public RPC needs no key. No faucet endpoint was reachable
  from the development environment, so funds were moved from an already-funded
  account.

### Testnet addresses
See [Current Stage](#current-stage-testnet-deployment-live-three-cycles-repaid).

### I run a paid AI endpoint. How do I get revenue into Runway?

The whole integration is the SDK. An agent's x402 payment revenue is the
collateral: the lender's share is taken automatically from what arrives, which is
what makes an advance repayable without a credit check.

**1. Install and point at Arc testnet.**

```bash
npm install @workspace/runway-sdk
```

```ts
import { createRunwayClient, createSeller, usdc } from '@workspace/runway-sdk';

const runway = createRunwayClient({
  chainId: 5042002,                       // must match the settling chain
  network: 'arc-testnet',
  rpcUrl: process.env.ARC_TESTNET_RPC,     // public: https://rpc.testnet.arc.network
  privateKey: process.env.PRIVATE_KEY,     // to pull and route the payment
});
```

**2. Wrap your endpoint.** The SDK issues the 402, recovers the EIP-3009
signature, checks amount, window, recipient, allowance and nonce, pulls the
funds, and forwards them to your splitter.

```ts
const seller = createSeller({
  runway,
  splitter: '0xYourSplitter',
  price: usdc(0.1),
  description: 'Document extraction',
  resource: 'https://api.example.com/extract',
});

app.get('/extract', async (req, res) => {
  const result = await seller.verify(req.headers['x-payment'] as string | undefined);
  if (!result.ok) {
    if (result.status === 402) return res.status(402).json(seller.challenge());
    return res.status(result.status).json({ error: result.error });
  }
  res.setHeader('X-PAYMENT-RESPONSE', encodeHeader({
    success: true,
    transaction: result.transactions.route,
  }));
  res.json({ text: 'extracted…' });
});
```

**3. Settle.** Permissionless, so a keeper can do it for you.

```ts
import { settle, getSplitterStatus } from '@workspace/runway-sdk';
await settle(runway, '0xYourSplitter');
console.log(await getSplitterStatus(runway, '0xYourSplitter'));
```

**4. Request an advance** when cash-flow constrained.

```ts
import { requestAdvance, usdc } from '@workspace/runway-sdk';
await requestAdvance(runway, { splitter, principal: usdc(10), rationale: '…' });
```

Full reference in [`lib/runway-sdk/README.md`](lib/runway-sdk/README.md). A
runnable end-to-end version is `services/demo-seller`, and `pnpm --filter
@workspace/runway-sdk run verify` settles a real payment and prints the result.

**Two things that bite.** Build amounts with `usdc()`, never `0.1 * 1e6`:
floating point gives `99999.99999999999` and a one-base-unit drift breaks
signature comparison. And `chainId` is part of the EIP-712 domain the payer
signs, so a wrong value means every payment is rejected.



### Environment Variables

`.env.example` is the authoritative list and carries no secrets. The names below
differ in places and `.env.example` wins.

```bash
# RPC
ARC_TESTNET_RPC=https://rpc.testnet.arc.network
ARC_MAINNET_RPC=

# Deployer. Testnet only, and MUST be rotated before any public demo.
PRIVATE_KEY=

# Dashboard (artifacts/runway) — see vercel.json for the deployed values
RUNWAY_NETWORK=arc-testnet
RUNWAY_CHAIN_ID=5042002
RUNWAY_VAULT_ADDRESS=0x30f5f5d45bbf94487fa3cae069d5bdaadb6744ab
RUNWAY_FACTORY_ADDRESS=0xc8f5ae45cfbc7a9f17248fd610adc989f8d08106
RUNWAY_SPLITTER_ADDRESS=0x96559D62bAD82F31853F3dd1b6C3c3ef9F434279
RUNWAY_PRIVATE_KEY=      # signs EIP-3009 auths; dedicated low-value key
RUNWAY_KEEPER_SECRET=

# Watcher — key holding the vault's WATCHER_ROLE
WATCHER_PRIVATE_KEY=
WATCHER_INTERVAL_MS=60000
WATCHER_INFLATION_RATIO=0.9
WATCHER_ALLOW=           # empty = report only, never flag

# Underwriter — key holding UNDERWRITER_ROLE
UNDERWRITER_PRIVATE_KEY=
UNDERWRITER_SPLITTER=
UNDERWRITER_PRINCIPAL=10000000
UNDERWRITER_MIN_SCORE=60
UNDERWRITER_DRY_RUN=true
UNDERWRITER_LLM_ENDPOINT=  # optional; falls back to the rules engine
```

### Key hygiene

The operational deployer key was exposed in an earlier session and is present in
git history. It has **not** been rotated. `scripts/scan-secrets.mjs` reports it on
every full scan, which is intentional: it should stay loud until it is fixed.

Rotate before making this repository public, and before any mainnet use.

---

## Development Commands

### Contracts (Foundry)
```bash
cd contracts
forge build                    # Compile
forge test                     # Unit tests
forge test --invariant         # Invariant tests
forge coverage                 # Coverage report
forge script script/Deploy.s.sol --rpc-url $ARC_RPC_URL --broadcast  # Deploy
```

### Services (TypeScript)
```bash
cd services/keeper
pnpm install
pnpm build
pnpm start                     # Run keeper

cd services/watcher
pnpm start                     # Run watcher

cd services/underwriter
pnpm start                     # Run underwriter
```

### Dashboard (Vite + React)
```bash
cd artifacts/runway
pnpm install
pnpm dev                       # Dev server
pnpm build                     # Production build
pnpm typecheck                 # Type check
```

---

## Testing Strategy

### Contracts
| Test Type | Tool | Coverage Target |
|-----------|------|-----------------|
| Unit | Forge | 100% public functions |
| Integration | Forge | Full loan lifecycle |
| Invariant | Echidna/Forge | Accounting invariants |
| Fuzz | Forge | Edge cases |
| Static Analysis | Slither | **not run** |

Current state: **29 unit tests and 8 invariants pass**, 128,000 invariant calls
per run, reproduced across four fuzz seed batches.

### Key Invariants

Implemented in `contracts/test/InvariantTest.t.sol`:

| Invariant | Asserts |
|---|---|
| `noStrandedTokens` | held USDC equals what the agent is owed plus revenue pending settlement |
| `settleClearsSurplus` | `settle()` is permissionless and leaves nothing unclaimed |
| `agentClaimBackedByTokens` | a claim never exceeds the tokens backing it |
| `vaultSolvent` | vault balance never falls below outstanding advances |
| `vaultConservation` | `vault balance == debt + free balance` |
| `debtIncludesFee` | `repaid + outstanding == principal + fee`, always |
| `loanCapsEnforced` | total due never exceeds `GLOBAL_MAX`; never over-repaid |
| `shareBpsValid` | share stays a valid percentage; a closed loan carries no debt |

One caveat that matters: `noStrandedTokens` originally asserted `surplus() == 0` at
all times, which is wrong. `surplus()` is legitimately non-zero between a payment
and the `settle()` that attributes it, so the assertion failed on the ordinary
pay-then-settle sequence. It now asserts the accounting identity instead, and
`settleClearsSurplus` covers the property the original was reaching for.

The regression tests were written by the same author as the fixes, so they encode
one model of the defects rather than an independent check. Slither has not been run.

---

## x402 Integration Details

### Payment Flow (x402 "exact" with EIP-3009)
1. Buyer calls seller endpoint → receives `402 Payment Required` with `WWW-Authenticate: Payment`
2. Buyer signs EIP-3009 `transferWithAuthorization` for USDC
3. Facilitator verifies signature, submits `transferWithAuthorization` to USDC contract
4. USDC transfers to `RevenueSplitter` (the `payTo` address)
5. Keeper calls `settle()` → splits revenue

### Arc Mainnet Parameters (TBD)
- USDC Address: `` (native USDC, not bridged)
- USDC Decimals: 6
- Gas Token: USDC
- RPC: ``
- Explorer: ``

---

## Security Considerations

### Access Control (OpenZeppelin `AccessControl`)
| Role | Permissions |
|------|-------------|
| `DEFAULT_ADMIN_ROLE` | Grant/revoke roles, pause/unpause |
| `UNDERWRITER_ROLE` | `openLoan` only |
| `WATCHER_ROLE` | `flagLoan` only |
| `KEEPER_ROLE` | None needed (settle is permissionless) |

### Emergency Procedures
- `pause()` — blocks new loans, **never** blocks repayment or withdrawal
- `markDelinquent()` — permissionless, blocks new advances for delinquent loans
- `flagLoan()` — watcher only, blocks new advances

---

## Monitoring & Observability

### Key Metrics to Track
- Loans originated (count, total USDC)
- Repayment rate (principal + fee repaid / principal + fee)
- Average days to repay
- Distinct agents served
- Settle events per day
- Payee-swap flags raised
- Delinquent loans

### Logging
All state changes emit events sufficient to rebuild dashboard from logs (FR-10).

---

## License

MIT — see [LICENSE](LICENSE) (to be added).

---

## Disclaimer

**This is an unaudited prototype.** It uses the builder's own funds only. No external depositors. No yield promises. No legal enforcement. Do not use with funds you cannot afford to lose.

---

## Links

- **PRD**: [`runway-prd.md`](runway-prd.md)
- **Arc Network**: https://arc.xyz
- **x402 Specification**: https://github.com/coinbase/x402
- **OpenZeppelin Contracts**: https://github.com/OpenZeppelin/openzeppelin-contracts
- **Foundry Book**: https://book.getfoundry.sh
- **viem Docs**: https://viem.sh
- **Next.js Docs**: https://nextjs.org/docs