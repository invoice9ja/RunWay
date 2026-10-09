# Mainnet deployment checklist

Everything below is a gate, not a suggestion. Testnet works with testnet keys and
testnet-sized caps; none of that transfers. Work top to bottom.

## 0. Facts confirmed for Arc mainnet

| | Value |
|---|---|
| Chain id | `5042` (`0x13b2`) |
| Gas token | USDC (native, 18 decimals) |
| USDC (ERC-20 interface) | `0x3600000000000000000000000000000000000000`, 6 decimals — **same address as testnet** |
| Explorer | `https://explorer.arc.io` |
| Block time | ~0.5s |

The EIP-712 domain for USDC is `{ name: 'USDC', version: '2', chainId, verifyingContract }`.
Only `chainId` changes between networks. The USDC address does not.

## 1. Keys

The current keys were used on a public testnet and are in shell history and this
repository's history. Treat all of them as burned.

- [ ] Generate a **new** deployer key. This one only broadcasts the deployment.
- [ ] Generate a separate **underwriter** key (holds `UNDERWRITER_ROLE`, signs
      advances). This is the key that moves the most value.
- [ ] Generate a separate **watcher** key (flags loans).
- [ ] Generate a separate **settler/keeper** key.
- [ ] Generate a separate **agent** key per agent, not one shared agent key.
- [ ] Put the deployer key on hardware or in a KMS/HSM-backed signer. It is the
      only key that needs to exist at deploy time; the rest only need to sign
      from wherever their service runs.

## 2. Caps

`contracts/script/Deploy.s.sol` now reads these from the environment, in USDC and
bps, and refuses to deploy to mainnet unless they are set explicitly:

- [ ] `GLOBAL_MAX_USDC` — the most the vault can ever be owed at once.
- [ ] `STARTER_CAP_USDC` — the most a single borrower can take. Start small.
- [ ] `FEE_BPS_DEFAULT` — cost of the advance.
- [ ] `SHARE_BPS_DEFAULT` — lender's cut of each payment.
- [ ] `DUE_DAYS_DEFAULT` — repayment window.

The script rejects `STARTER_CAP > GLOBAL_MAX`, a fee above 20%, and a lender share
above 50%.

## 3. Deploy

```bash
export RUNWAY_MAINNET_CONFIRM=true
export GLOBAL_MAX_USDC=...   # deliberate, not inherited
export STARTER_CAP_USDC=...
export USDC_ADDRESS=0x3600000000000000000000000000000000000000
export PRIVATE_KEY=...       # deployer only
forge script script/Deploy.s.sol:Deploy --rpc-url "$ARC_MAINNET_RPC" --broadcast
```

The deployer needs USDC on mainnet for gas.

## 4. Point the app at the new deployment

- [ ] `RUNWAY_CHAIN_ID=5042`
- [ ] `RUNWAY_NETWORK=arc-mainnet`
- [ ] `RUNWAY_EXPLORER_URL=https://explorer.arc.io`
- [ ] `RUNWAY_VAULT_ADDRESS`, `RUNWAY_FACTORY_ADDRESS`, `RUNWAY_SPLITTER_ADDRESS`,
      `RUNWAY_SPLITTER_IMPL_ADDRESS` from the deploy output
- [ ] `RUNWAY_USDC_ADDRESS=0x3600000000000000000000000000000000000000`
- [ ] Client build variables: `VITE_RUNWAY_CHAIN_ID`, `VITE_RUNWAY_NETWORK`,
      `VITE_RUNWAY_NETWORK_LABEL`, `VITE_RUNWAY_EXPLORER_URL`,
      `VITE_RUNWAY_RPC_URL`, `VITE_RUNWAY_GAS_SYMBOL` (`USDC`), `VITE_RUNWAY_GAS_NAME`
- [ ] SDK and MCP: `RUNWAY_VAULT`/`RUNWAY_FACTORY` or `RUNWAY_VAULT_ADDRESS`/
      `RUNWAY_FACTORY_ADDRESS`. The SDK now refuses to assume testnet addresses
      on another chain rather than reading and writing an address with no code
      there.

## 5. Close or gate what must not be public

- [ ] `/api/demo/*` — the hosted seller and buyer **pay gas from the operator
      wallet**, and on mainnet that gas is real USDC. They are bounded (per-payer
      cooldown, global hourly cap, wallet floor) but the honest options are to
      require an API key (`isAuthorized`), to raise the price above gas cost, or
      to keep these endpoints on testnet only. Set `RUNWAY_DEMO_WALLET_FLOOR` to
      a real reserve.
- [ ] `/api/keeper` and `/api/tests/*` — both must stay behind
      `RUNWAY_KEEPER_SECRET`.
- [ ] Confirm `RUNWAY_DEMO_*` and any UI copy that says "testnet".

## 6. Settlement actually happens

The keeper settles revenue above a threshold. On testnet it runs from a Vercel
cron, which on the Hobby plan fires **once a day** — fine for testnet, wrong for
mainnet, where a payment could sit unsettled for a day.

- [ ] Run `services/keeper` on a host with a real scheduler (every few minutes),
      or move the cron to a plan/host that supports it.
- [ ] Alert on failure: settlement errors, watcher flags, and a vault balance
      below its floor. An unsettled payment is a missed repayment.

## 7. Indexing

`/api/status` reads the ledger from the explorer API, which has no block-range
limit, and falls back to `eth_getLogs`. The endpoints differ in what they allow
(Alchemy free caps a log query at ten blocks; the public endpoint caps it near
5,000), so reads and log scans use separate URLs:

- [ ] `RUNWAY_RPC_URL` — the reliable keyed endpoint for calls.
- [ ] `RUNWAY_LOGS_RPC_URL` — the endpoint that accepts a wide range.

Note for any custom indexer: an ERC-20 transfer on Arc emits **two** `Transfer`
logs, one from the ERC-20 contract (6 decimals) and one from the EIP-7708 system
emitter (18 decimals). Match on the emitter address or the same movement is
counted twice.

## 8. Before announcing

- [ ] Contracts verified on the mainnet explorer.
- [ ] Invariant suite green against the deployed addresses
      (`/api/tests/run`, and `forge test`).
- [ ] One real end-to-end advance → payment → settlement → withdrawal on
      mainnet, with the transaction hashes to prove it.
- [ ] Rotate the Alchemy key. The testnet one was committed to this repository
      before it was moved to the Vercel environment.
