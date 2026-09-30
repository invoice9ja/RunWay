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

### Dashboard (Next.js + Vercel)

- Agent list & detail pages (revenue over time, repayment progress, terms, watcher status, underwriter rationale)
- Explorer transaction links
- Public read-only; operator actions (request advance) post-submission

### Data Layer

- **Indexer**: Reads contract logs directly (no separate indexing service needed for MVP)
- **Supabase (Postgres)**: Stores underwriting rationale reports (hashed on-chain)

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
| Reentrancy / accounting bugs | `ReentrancyGuard`, invariant tests, tiny mainnet amounts | **Unaudited — prototype only** |
| Regulatory | Own funds only, no external depositors, labeled prototype | Real lending would need licensing analysis |

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
- **Dashboard**: Next.js, React, Tailwind CSS, shadcn/ui
- **Database**: Supabase (Postgres)
- **AI**: Claude API (underwriter)
- **Deployment**: Vercel (dashboard), Arc mainnet (contracts)

---

## Repository Structure

```
RunWay/
├── artifacts/runway/      # Next.js dashboard (UI scaffold)
│   ├── src/
│   │   ├── components/ui/     # shadcn/ui components (50+)
│   │   ├── hooks/             # use-toast, use-mobile
│   │   ├── lib/               # utils
│   │   ├── pages/             # not-found
│   │   ├── App.tsx            # Main app
│   │   └── main.tsx           # Entry
│   ├── package.json
│   ├── vite.config.ts
│   └── tsconfig.json
├── contracts/             # Solidity contracts (to be created)
│   ├── src/
│   │   ├── RevenueSplitter.sol
│   │   ├── RunwayVault.sol
│   │   └── RunwayFactory.sol
│   ├── test/              # Unit, integration, invariant tests
│   ├── script/            # Deploy scripts
│   ├── foundry.toml
│   └── package.json
├── services/              # TypeScript services (to be created)
│   ├── keeper/            # settle() caller
│   ├── watcher/           # payee monitor
│   ├── underwriter/       # AI credit limits
│   ├── demo-seller/       # x402 endpoint
│   └── demo-buyer/        # traffic generator
├── scripts/               # Deployment & utility scripts
│   ├── deploy.ts
│   ├── verify.ts
│   └── seed-demo.ts
├── lib/                   # OpenZeppelin contracts (submodule)
├── docs/                  # Additional documentation
├── runway-prd.md          # Product Requirements Document
└── README.md              # This file
```

---

## Roadmap & Status

### Current Stage: **Pre-contracts (Day 0)**

The PRD is complete (`runway-prd.md`). No contracts, services, or dashboard code exists yet beyond a UI component scaffold in `artifacts/runway/`.

### Submission Target: **Oct 7–8, 2026** (hard deadline Oct 14, 23:59 ET = Oct 15, 04:59 Lagos)

### Timeline (from PRD)

| Date | Work |
|------|------|
| **Oct 1** | Recon: Arc docs, USDC on Arc mainnet, repo scaffold |
| **Oct 2–3** | Contracts & tests (splitter, vault, factory), invariant tests |
| **Oct 4** | Testnet → mainnet deploy, explorer verification |
| **Oct 5** | Demo seller/buyer with x402 on Arc; keeper |
| **Oct 6** | Real loan cycle on mainnet (3 advances repaid); status page |
| **Oct 7** | README, threat model, submission description; **submit** |
| **Oct 8–13** | Watcher, underwriter, richer dashboard, second agent |

### Submission-Ready Criteria
- [ ] Contracts verified on Arc explorer; addresses in README
- [ ] ≥ 1 splitter, ≥ 3 loans opened and repaid on mainnet (all linkable)
- [ ] Test suite passes, including invariant tests
- [ ] Live URL opens; public repo; public builder profile linked

### Post-Submission (Same Repo)
- [ ] Watcher service
- [ ] Underwriter service
- [ ] Richer dashboard
- [ ] Second demo agent

### Future Grant Milestones
1. Independent contract review
2. Self-serve onboarding for third-party agents
3. Pooled liquidity with external lenders (after legal review)
4. Circle Agent Marketplace listing integration

---

## Getting Started

> **Coming Oct 1–4**: Contract deployment addresses, deployment scripts, and service setup instructions.

### Prerequisites (when ready)
- Node.js 20+
- pnpm 9+
- Foundry (for contracts)
- Arc mainnet RPC endpoint
- USDC on Arc mainnet (for gas + demo payments)
- Supabase project (for underwriting reports)
- Anthropic API key (for underwriter)

### Environment Variables (`.env.example`)
```bash
# Contracts
ARC_RPC_URL=
ARC_CHAIN_ID=
PRIVATE_KEY=
USDC_ADDRESS=
EXPLORER_API_KEY=

# Services
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
ANTHROPIC_API_KEY=

# Keeper
KEEPER_INTERVAL_MS=300000
SETTLE_THRESHOLD_USDC=10

# Watcher
WATCHER_INTERVAL_MS=300000

# Underwriter
UNDERWRITER_SCHEDULE_CRON="0 2 * * *"
GLOBAL_MAX_USDC=10000
STARTER_CAP_USDC=500
```

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

### Dashboard (Next.js)
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
| Static Analysis | Slither | 0 high/medium |

### Key Invariants
1. `totalVaultBalance == sum(loan.principal + loan.fee - loan.repaid)`
2. `agentClaimable <= splitter.balance - lenderShare`
3. `settle()` is idempotent
4. No reentrancy possible
5. Loan caps enforced: `principal <= min(GLOBAL_MAX, STARTER_CAP + 2 * lifetimeRevenue)`

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