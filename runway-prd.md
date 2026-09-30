# Runway — PRD

Revenue-routed working capital for AI agents on Arc.

Status: draft v1 · Owner: Moses Sunday · Target: live on Arc mainnet and submitted by Oct 7–8, 2026 (hard deadline Oct 14, 23:59 ET = Oct 15, 04:59 in Lagos)

---

## 1. One-paragraph summary

AI agents that sell services (data, inference, tools) over x402 must pay for inputs before they earn. They have no credit history, no legal identity and no way to be sued, so nobody lends to them. Runway lets an agent list a **splitter contract** as the payee for its paid endpoint. Every dollar of revenue lands in the splitter, which pays a fixed share to the lender first until the advance and fee are cleared, then everything to the agent. Repayment is enforced by how the money is routed, not by trust, collateral or liquidation. An AI underwriter proposes credit limits from the agent's on-chain revenue history, but hard caps in the contract bound what it can do.

## 2. Problem

1. **Agents are cash-flow negative at the start.** A service that charges $0.01 per call pays for inference, data or API access before the revenue arrives.
2. **Traditional credit doesn't apply.** No credit score, no entity, no recourse. Over-collateralised DeFi loans don't help an agent that has no capital.
3. **Payments on Arc make the problem sharper.** Payments are near-instant and near-free, so agents can earn at high frequency, which produces exactly the kind of revenue history a lender could underwrite. Nobody uses it.
4. **Repayment enforcement is the blocker.** A lender can't chase software. The only credible enforcement is controlling where the money lands.

## 3. Users

| User | Need | Runway gives them |
|---|---|---|
| Agent operator (developer running a paid agent) | Float to fund inputs before revenue | Advance with no collateral, repaid as a share of sales |
| Lender / vault funder (for MVP: the builder, own funds) | Yield with enforceable repayment | Senior claim on every incoming payment |
| Ecosystem reviewer (Arc / Circle) | A financial primitive built on Agent Stack | Verified contracts, live loans, clear threat model |

Primary persona for the demo: a solo developer running an AI micro-service (e.g., a document-extraction endpoint priced per call).

## 4. Goals and non-goals

**Goals (MVP)**
- G1. A splitter that enforces senior repayment from x402 revenue, deployed and verified on Arc mainnet.
- G2. At least 3 real advances opened and repaid on mainnet with real x402 payments.
- G3. An AI underwriter that proposes limits and writes a verifiable rationale, bounded by on-chain caps.
- G4. A payee watcher that detects and flags a payee swap.
- G5. A public dashboard showing agents, revenue, loan status and repayment.

**Non-goals (say these out loud in the README)**
- No external lenders, no pooled deposits, no yield promises. MVP uses the builder's own funds only.
- No liquidation engine, no collateral, no legal enforcement.
- No claim of security audit. This is a prototype.
- No dependence on Arc privacy features or Circle Payments Network (both described as planned or upcoming).
- No fiat on/off-ramp.

## 5. Core mechanism

1. Operator registers an agent. Factory deploys a `RevenueSplitter` (minimal clone) bound to the agent.
2. Operator sets the endpoint's x402 `payTo` to the splitter address.
3. Buyers pay the endpoint. USDC (EIP-3009 `transferWithAuthorization`, per x402 "exact") lands in the splitter.
4. Anyone calls `settle()`. A keeper does this on a schedule. The splitter sends `shareBps` of new revenue to the vault until the loan is repaid; the rest becomes claimable by the agent.
5. The agent can only reach its money through `withdraw()`, so it can't bypass the lender's share.
6. Underwriter (off-chain, AI-assisted) proposes a limit; an underwriter-role transaction opens the loan if the contract's hard rules pass.
7. Watcher checks that the endpoint still advertises the splitter as its payee. On mismatch it flags the loan, which blocks further advances and records the event on-chain.

**Why token transfers force a `settle()` design:** an ERC-20 transfer to a contract does not run the receiver's code, so the splitter can't react on receipt. Because the agent can only withdraw through the splitter, deferring the split to `settle()` still preserves the guarantee.

## 6. Functional requirements

### Contracts
- FR-1. `RunwayFactory.createSplitter(agent, payout)` deploys a splitter clone and registers it in the vault.
- FR-2. `RevenueSplitter.settle()` is permissionless and idempotent. It splits only new revenue (balance minus already-claimable agent share).
- FR-3. Repayment per settle = `min(newRevenue × shareBps / 10000, outstanding)`.
- FR-4. Agent share accrues in `agentClaimable`; `withdraw()` is pull-based so a bad payout address (e.g., a USDC-blacklisted one) cannot block repayment.
- FR-5. `setPayout()` is blocked while a loan is outstanding.
- FR-6. `RunwayVault.openLoan(splitter, principal, rationaleHash)` requires: underwriter role, not paused, no active loan, not flagged, and `principal ≤ min(GLOBAL_MAX, STARTER_CAP + 2 × splitter.lifetimeRevenue())`.
- FR-7. Loan terms: flat fee (default 8%), revenue share (default 30%), soft due date (default 30 days). Past due with balance outstanding, `markDelinquent()` (permissionless) blocks new advances. No liquidation.
- FR-8. Watcher role can `flagLoan(id, reasonHash)`; flagged agents receive no further advances.
- FR-9. Owner can pause new advances. Repayment and withdrawals are never paused.
- FR-10. Every state change emits an event sufficient to rebuild the dashboard from logs.

### Services
- FR-11. **Keeper** calls `settle()` on every splitter whose balance exceeds a threshold.
- FR-12. **Watcher** polls each borrower's endpoint, parses the x402 payment requirements, and verifies the Arc payee equals the splitter.
- FR-13. **Underwriter** computes features from logs, asks an LLM for a limit and rationale in strict JSON, clamps to rule caps, stores the report, and submits `openLoan` with the report hash.
- FR-14. **Demo seller** exposes a paid endpoint using x402 with Arc USDC.
- FR-15. **Demo buyer** generates paid traffic (with real, small payments).

### Dashboard
- FR-16. Agent list, agent detail (revenue over time, repayment progress, current terms, watcher status, underwriter rationale, transaction links to the explorer).
- FR-17. Read-only for public visitors. An operator-only action for "request advance" can wait until after submission.

## 7. Architecture

```
Buyer agent ──x402 pay──▶ Seller endpoint (payTo = Splitter)
                               │ USDC (EIP-3009)
                               ▼
                         RevenueSplitter ◀── settle() ── Keeper
                          │ repay share          │ agentClaimable
                          ▼                      ▼
                     RunwayVault             Agent withdraw()
                          ▲
   Underwriter (LLM + rules) ── openLoan ─┘      Watcher ── flagLoan
                          
Indexer/Dashboard (Next.js) reads logs directly + Supabase for rationales
```

Stack: Solidity + Foundry (OpenZeppelin AccessControl, ReentrancyGuard, SafeERC20, Clones), TypeScript services with viem, Next.js dashboard on Vercel, Supabase (Postgres) for underwriting reports, Claude API for the underwriter.

## 8. Underwriting

**Features (from on-chain logs):** 7-day and 30-day revenue, active days, trend, distinct payers, top-payer concentration, and a wash-trading flag (payers funded by the agent's or operator's wallet within two hops in the last 30 days).

**Output schema:** `{ limit_usdc, confidence, reasons[], risks[], wash_flag }`.

**Control:** the model never has authority. Final limit = `min(model_limit, rule_limit, on-chain cap)`. The rationale JSON is hashed and the hash is emitted in `LoanOpened`, so anyone can check that the stored report matches what was used.

## 9. Threat model (include in the README)

| Threat | Mitigation | Residual risk |
|---|---|---|
| Agent changes the endpoint's `payTo` to an address it controls | Watcher flags within one polling interval; advances are small; further advances blocked | Revenue between swap and flag is lost. Stated openly. |
| Wash trading to inflate revenue and unlock bigger advances | Cap grows only 2× lifetime revenue; wash heuristic; hard global cap | Sophisticated multi-wallet loops. Bounded by the cap. |
| Borrower stops selling | Flat fee, revenue share: no revenue means no repayment | Lender loses the principal. Bounded by cap. |
| Underwriter key compromised | Role can only open loans within on-chain caps; pause switch | Loss bounded by GLOBAL_MAX per agent. |
| USDC blacklist blocks agent payout | Pull-based `withdraw()`; repayment leg never touches the agent address | Agent can't withdraw its own share. |
| Reentrancy / accounting bugs | ReentrancyGuard, invariant tests, tiny mainnet amounts | Unaudited. Say so. |
| Regulatory | Own funds only, no external depositors, labeled prototype | Real lending would need licensing analysis. |

## 10. Success metrics

**Submission-ready (by Oct 7–8)**
- Contracts verified on the Arc explorer; addresses in the README.
- ≥ 1 splitter, ≥ 3 loans opened and repaid on mainnet, all linkable.
- Test suite passes, including invariant tests.
- Live URL opens; public repo; public builder profile linked.

**Grant-ladder metrics (log from day one)**
- Loans originated, USDC advanced, repayment rate, average days to repay, number of distinct agents, settle events, payee-swap flags raised.

## 11. Scope

**Cut line for submission:** contracts, mainnet deploy, demo seller and buyer, keeper, one real loan cycle, minimal status page, README with threat model.
**After submission (same repo, keep committing):** watcher, underwriter, richer dashboard, second agent, docs.
**Grant milestones to propose later:** (1) independent review of contracts; (2) support for third-party agents onboarding self-serve; (3) pooled liquidity with external lenders after legal review; (4) integration with the Circle Agent Marketplace listing flow.

## 12. Timeline (today is Sep 30)

| Date | Work |
|---|---|
| Oct 1 | Recon of Arc docs; get USDC to Arc mainnet for gas; repo scaffold |
| Oct 2–3 | Contracts and tests (splitter, vault, factory), invariant tests |
| Oct 4 | Testnet deploy, then mainnet deploy and explorer verification |
| Oct 5 | Demo seller/buyer with x402 on Arc; keeper |
| Oct 6 | Real loan cycle on mainnet (3 advances repaid); status page |
| Oct 7 | README, threat model, submission description; **submit** |
| Oct 8–13 | Watcher, underwriter, dashboard, second-project work if time allows |

## 13. Risks and open questions

- Which x402 facilitator or SDK supports Arc mainnet today? Fallback: minimal self-hosted facilitator that verifies the EIP-3009 signature and calls `transferWithAuthorization`.
- Do Circle Nanopayments pay out to a contract address? Untested. Do not rely on it; use the standard x402 path.
- USDC decimals and address on Arc mainnet (native USDC gas vs ERC-20 interface). Read from docs; don't hardcode from memory.
- How to get USDC onto Arc mainnet quickly from Nigeria. Solve on day one because it can block everything.
- Explorer verification tooling for Arc contracts. Confirm in recon.

## 14. Submission draft (fill in with real addresses)

**What it does:** Runway is a working-capital line for AI agents. An agent sets a splitter contract as the payee for its x402 endpoint; revenue repays the lender first, then flows to the agent. An AI underwriter proposes limits from on-chain revenue history, bounded by contract-level caps.

**What it uses Arc for:** USDC as gas, so keeper settlement costs are predictable in dollars; sub-second deterministic finality, so each repayment is final almost immediately; and the Circle agent payment stack (x402 with USDC), which the demo agent uses to earn the revenue that repays the loan. *(Only keep claims you have tested.)*

**Why worth taking further:** Agents can earn and spend but cannot borrow. Revenue-routed repayment removes the enforcement problem, which is what blocks agent credit. Next steps: independent review, self-serve onboarding for third-party agents, and pooled liquidity after legal review.
