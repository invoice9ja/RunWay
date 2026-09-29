# Runway — Development Prompt

Paste everything below the line into your coding agent (Claude Code or similar). Attach `runway-prd.md` to the repo as `docs/PRD.md` first so the agent can read it.

---

## Role and mission

You are a senior smart-contract and full-stack engineer. Build **Runway**, a revenue-routed working-capital system for AI agents on **Arc** (Circle's L1, USDC as gas). Read `docs/PRD.md` first; it is the source of truth for scope. This project is a prototype for the Arc Microgrants program. It must be **deployed and working on Arc mainnet** at submission, with a public repo and a live link. Testnet-only builds, mockups and slide decks are ineligible.

Deadline planning: submit by **Oct 7–8, 2026**. Hard deadline Oct 14, 23:59 ET.

## Ground rules (non-negotiable)

1. **Never trust your memory for chain facts.** Chain ID, RPC URLs, USDC address and decimals, explorer URL and verification method, faucet, and x402 support must all be read from the official docs (`https://docs.arc.io`, `https://developers.circle.com/llms.txt`, `https://docs.x402.org`). Write what you find, with source URLs, in `docs/RECON.md`. Sources disagree on chain IDs; use only the official docs.
2. **Decimals trap.** On Arc, USDC is the native gas token. Check how the native balance and the ERC-20 interface differ in decimals, and never mix them. Use the ERC-20 `balanceOf` for all accounting. Never use `address.balance`.
3. **Ask before spending real money.** Any mainnet transaction that moves more than 1 USDC needs my explicit approval. Keep all mainnet amounts tiny (cents to a few USDC).
4. **Secrets.** Never commit keys. Use `.env` with a committed `.env.example`. Use separate keys for deployer, underwriter, watcher, keeper and demo buyer. Assume any key in a chat log is compromised.
5. **No fake results.** Don't hardcode revenue or mock repayments in anything that is presented as live. If demo data is seeded, label it in code, UI and README.
6. **State limits honestly.** Include a threat model and a "not audited, prototype" notice. Do not claim features that aren't tested.
7. **Ship in phases** and stop for my review at each checkpoint marked ⛳.

## Product in one paragraph

An agent selling a paid endpoint over x402 sets a **RevenueSplitter** contract as its `payTo`. USDC revenue lands in the splitter. `settle()` (permissionless) sends a fixed share of new revenue to the **RunwayVault** until the advance plus fee is repaid; the rest becomes claimable by the agent via pull-based `withdraw()`. An off-chain **underwriter** (rules plus an LLM) proposes credit limits; the vault enforces hard on-chain caps. A **watcher** flags loans when the endpoint's advertised payee is no longer the splitter. A **keeper** calls `settle()`. A **dashboard** shows everything.

Important mechanics: an ERC-20 transfer does not execute receiver code, so the splitter cannot react to receipts. That is why the split happens in `settle()`; the agent can only reach funds through the splitter, so the guarantee holds.

## Repo layout

```
runway/
  contracts/            # Foundry project
    src/ RevenueSplitter.sol RunwayVault.sol RunwayFactory.sol interfaces/
    test/ *.t.sol invariant/*.t.sol
    script/ Deploy.s.sol OpenLoan.s.sol
  services/             # TypeScript (viem), one package, multiple entrypoints
    src/keeper.ts watcher.ts underwriter.ts demo-seller.ts demo-buyer.ts facilitator.ts
    src/lib/ chain.ts x402.ts features.ts
  web/                  # Next.js dashboard (App Router, Tailwind)
  docs/ PRD.md RECON.md THREAT_MODEL.md DEPLOYMENTS.md
  README.md .env.example
```

## Phase 0 — Recon ⛳

Deliverable: `docs/RECON.md`. Answer, with source links:
- Arc mainnet and testnet: chain ID, RPC, explorer, how to verify contracts there, how to get USDC on mainnet for gas from Nigeria (bridge/onramp options).
- USDC contract address, decimals in each interface, and whether it supports EIP-3009 `transferWithAuthorization` (needed for x402 "exact").
- x402: current spec version and payment-requirements format (`payTo`, `network`, `asset`, amount fields), which facilitators or SDKs support Arc mainnet, and whether Circle Nanopayments can pay out to a contract address. If unclear, assume they cannot and plan on standard x402 "exact".
- Foundry compatibility (EVM version, any Arc-specific opcodes or gas quirks).
Stop and summarize open questions before writing contracts.

## Phase 1 — Contracts and tests ⛳

Use Solidity ^0.8.24, Foundry, OpenZeppelin (AccessControl, ReentrancyGuard, SafeERC20, Clones, Pausable).

### RevenueSplitter (clone-friendly, initialize instead of constructor)
State: `usdc`, `vault`, `agent`, `payout`, `lifetimeRevenue`, `agentClaimable`.
```
function settle() external nonReentrant {
    uint256 bal = usdc.balanceOf(address(this));
    uint256 fresh = bal - agentClaimable;            // revenue not yet split
    if (fresh == 0) return;
    lifetimeRevenue += fresh;
    uint256 owed = vault.outstanding(address(this)); // 0 if no active loan
    uint256 repay = owed == 0 ? 0 : min(fresh * vault.shareBps(address(this)) / 10_000, owed);
    if (repay > 0) { usdc.safeTransfer(address(vault), repay); vault.onRepayment(repay); }
    agentClaimable += fresh - repay;
    emit RevenueSettled(fresh, repay, agentClaimable);
}
function withdraw() external nonReentrant { /* agent or payout; pull; sends agentClaimable to payout */ }
function setPayout(address p) external { /* only agent; revert if vault.outstanding(this) > 0 */ }
```
Reference only. Fix accounting bugs you find, and document any change.

### RunwayVault
- Roles: `DEFAULT_ADMIN`, `UNDERWRITER`, `WATCHER`, `PAUSER`.
- Config (immutable or admin-set with sane bounds): `GLOBAL_MAX_ADVANCE`, `STARTER_CAP`, `feeBps` (default 800), `shareBps` (default 3000), `termDays` (default 30).
- `openLoan(address splitter, uint256 principal, bytes32 rationaleHash)`, callable by UNDERWRITER only. Require: not paused; splitter registered by the factory; no active loan; not flagged; `principal <= min(GLOBAL_MAX_ADVANCE, STARTER_CAP + 2 * splitter.lifetimeRevenue())`; sufficient idle liquidity. Send principal to the splitter's `payout`. Emit `LoanOpened(id, splitter, principal, fee, shareBps, dueBy, rationaleHash)`.
- `onRepayment(uint256 amount)`: only registered splitters; verify the vault's USDC balance actually rose by `amount`; reduce outstanding; close the loan at zero.
- `flagLoan(id, reasonHash)` (WATCHER), `markDelinquent(id)` (permissionless after `dueBy`), `pause()` (PAUSER; pauses new loans only, never repayments or withdrawals).
- Views for the dashboard: `outstanding(splitter)`, `shareBps(splitter)`, `loanOf(splitter)`, `isFlagged(splitter)`.
- Funding: admin `deposit(amount)` / `withdrawIdle(amount)` for MVP (single funder, own funds).

### RunwayFactory
`createSplitter(address agent, address payout)` clones the splitter, registers it with the vault, emits `SplitterCreated`.

### Tests (must pass)
- Unit: settle with no loan; with loan (partial and full repayment); zero-revenue settle; multiple settles; withdraw; payout change blocked during loan; cap formula; role restrictions; pause behavior.
- Invariants (Foundry invariant tests): repayments never exceed `principal + fee`; `usdc.balanceOf(splitter) >= agentClaimable`; total USDC in equals total out plus balances; agent cannot receive funds other than through `withdraw()`; only registered splitters can call `onRepayment`; repayment path works even if the agent's payout address is blacklisted (simulate with a reverting token transfer to that address).
- Fuzz the split math at boundaries.
Report coverage. Do not proceed if any invariant fails.

## Phase 2 — Testnet deploy and scripts ⛳

`Deploy.s.sol` deploys vault and factory, sets roles, writes addresses to `docs/DEPLOYMENTS.md`. `OpenLoan.s.sol` for manual runs. Verify contracts on the Arc explorer following the method found in RECON. Run a full loop on testnet by hand: create splitter, fund vault, open loan, send USDC to splitter, `settle()`, check balances.

## Phase 3 — Demo seller, buyer, facilitator ⛳

- `demo-seller.ts`: an HTTP service with a paid endpoint (a small AI-backed function, e.g. extract structured fields from a short business message). Returns a 402 with payment requirements where **`payTo` is the splitter address**. Use the current x402 SDK if it supports Arc; otherwise implement `facilitator.ts`: verify the EIP-3009 signature and value/time bounds, submit `transferWithAuthorization` from a facilitator wallet (which pays gas in USDC), and only then return the response.
- `demo-buyer.ts`: pays per call in small amounts; configurable rate and count.
- Test the full path on testnet: buyer pays, USDC arrives at the splitter, `settle()` repays the vault.
Document exactly which x402 path was used and why.

## Phase 4 — Mainnet deploy and first real loan cycle ⛳

With my explicit approval per transaction over 1 USDC:
1. Deploy and verify contracts on Arc mainnet; update `DEPLOYMENTS.md`.
2. Fund the vault with a small amount (e.g., 20 USDC).
3. Create a splitter for the demo seller agent; start the seller with `payTo` = splitter.
4. Open loan #1 (starter cap), run the buyer, run settle, confirm repayment to zero. Repeat until 3 loans have been opened and repaid.
5. Record all transaction hashes in `DEPLOYMENTS.md` with explorer links.

## Phase 5 — Keeper and minimal status page

- `keeper.ts`: every N seconds, find splitters with `usdc.balanceOf > agentClaimable` and call `settle()` (batch if a multicall exists). Log gas cost per call in USDC.
- A single-page status view in `web/` listing splitters, outstanding balances, repayments and explorer links. This is the **submission cut line**: after this, write the README and submit. Everything in later phases can keep landing in the same public repo.

## Phase 6 — Watcher

`watcher.ts` fetches each borrower's endpoint without payment, parses the 402 payment requirements per the x402 version in use, and checks that every Arc payment option pays the splitter. On mismatch: call `flagLoan` with a hash of the evidence, store the evidence, and surface it in the dashboard. Provide `scripts/simulate-payee-swap.ts` to demonstrate detection.

## Phase 7 — Underwriter

- `features.ts`: from event logs compute 7d/30d revenue, active days, trend, distinct payers, top-payer share, and a wash flag (payers funded by the agent or operator within two hops over the last 30 days).
- `underwriter.ts`: call the Claude API with the features and ask for strict JSON `{limit_usdc, confidence, reasons[], risks[], wash_flag}`. Validate against a schema; reject and retry on malformed output. Final limit = `min(model, rule_based, on-chain cap)`. The model has no authority beyond suggesting. Store the report (Supabase) and pass its keccak hash as `rationaleHash` to `openLoan`. If wash_flag is true, do not open the loan.
- Include unit tests for the feature computation and the clamping.

## Phase 8 — Dashboard and README

Dashboard (Next.js, Tailwind): agent list; agent page with revenue chart, loan terms, repayment progress bar, watcher status, underwriter rationale, explorer links; a public read-only view. Read logs directly through viem; use Supabase only for underwriting reports.

README must include: what it does in three sentences; the architecture diagram; mainnet addresses and explorer links; how Arc is used (only tested claims); how to run locally; the threat model summary with the payee-swap limitation stated plainly; "prototype, not audited, own funds only" notice; and any seeded or simulated data clearly labeled.

## Definition of done for submission

- Contracts verified on Arc mainnet, linked in README.
- At least 3 loans opened and repaid with real x402 payments, transaction links recorded.
- All tests pass; invariant tests included.
- Live status page URL; public repo; `.env.example`; no secrets in history.
- README complete with honest limits.

## How to work

At the start of each phase, restate the goal and list what you will verify from docs. At each ⛳, summarize what was built, what was verified, what failed, and what you need from me. Prefer small commits with clear messages. If a requirement conflicts with reality (an Arc quirk, a missing facilitator), stop and propose options instead of silently changing scope.
