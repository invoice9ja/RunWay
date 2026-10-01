# Watcher

Holds the vault's `WATCHER_ROLE` and decides which splitters to flag.

`flagLoan` is the only way to mark an agent as unborrowable. What this service
adds is the *decision*: which splitters deserve one. It never flags on a hunch,
and every finding carries the evidence that produced it.

## Rules

| Rule | Trigger | On-chain effect |
|---|---|---|
| `missed-repayment` | Advance past its due date with debt outstanding | `markDelinquent` (permissionless), then a flag if allowed |
| `payout-swap` | `PayoutChanged` while an advance is active | `flagLoan` if allowed |
| `cap-inflation` | Outstanding debt >= `WATCHER_INFLATION_RATIO` of lifetime revenue | `flagLoan` if allowed |

A flag is permanent for the loan and blocks future borrowing through
`_isSplitterFlagged`. That is intentional: it is a stop, not a score. Reversing
a bad flag needs a human.

## Safety

`WATCHER_ALLOW` is empty by default, so the service reports and calls
`markDelinquent` but never flags. Add splitter addresses explicitly to enable
flagging. This is a stop with real consequences and it should be hard to turn on
by accident.

The watcher key is separate from the underwriter key on purpose. A compromised
scorer should not be able to flag arbitrary splitters.

## Running

```shell
cp .env.example .env   # set WATCHER_PRIVATE_KEY, RUNWAY_VAULT_ADDRESS
pnpm --filter @workspace/watcher dev
```

The public Arc testnet endpoint times out intermittently, so the provider pins
chain 5042002 and disables network detection.
