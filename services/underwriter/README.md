# Underwriter

Scores a splitter and writes the decision, with its reasons, into the loan's
`rationaleHash`.

The vault stores a `bytes32` rationale hash and never reads it. That is the
design: the hash commits to a written rationale so the decision is auditable
afterwards, and the policy lives here rather than in the contract.

## Scoring

Two modes, in order of preference:

1. **LLM**, when `UNDERWRITER_LLM_ENDPOINT` is set. Sees only on-chain metrics
   and returns a score and reasons. It never returns an amount or an address,
   so it cannot widen the position on its own.
2. **Rules engine**, always available and the fallback. Every input is a number
   read from the chain, every threshold is named, and the output is reproducible
   from the same state.

If the two modes **disagree on approve/decline**, the service declines and asks
for a human. A disagreement means the metrics are wrong or the policy has
drifted, and neither should open a position.

## Rules engine

Starts at 100 and subtracts:

| Signal | Deduction |
|---|---|
| Prior advance delinquent | 50 each |
| Prior advance flagged | 100 each |
| Repayment rate below 100% | 25 once |
| No advance history | 10 |
| No lifetime revenue | 40 |
| Lifetime revenue below requested principal | 20 |
| Most revenue unsettled | 15 |
| Outstanding debt >= 90% of lifetime revenue | 35 |

Approve threshold is `UNDERWRITER_MIN_SCORE`, default 60.

The debt-to-revenue ratio is the wash-trading signal the threat model warns
about: the cap grows with lifetime revenue, so a self-paying agent can raise its
own limit.

## Safety

`UNDERWRITER_DRY_RUN` defaults to `true`, so nothing is opened unless you opt
in. An underwriter that opens advances unattended is a lending bot with an LLM
in the loop, which is more than this needs to demonstrate.

## Running

```shell
cp .env.example .env   # set UNDERWRITER_PRIVATE_KEY, UNDERWRITER_SPLITTER
pnpm --filter @workspace/underwriter dev
```
