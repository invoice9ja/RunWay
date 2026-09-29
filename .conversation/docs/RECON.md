# Runway — Arc and x402 reconnaissance

**Reviewed:** 2026-09-30  
**Status:** Phase 0 is blocked for a mainnet implementation. No contracts have been written.

## Executive finding

The brief requires a working Arc mainnet deployment, but the official Arc deployment model currently lists both Private Mainnet and Public Mainnet as **Upcoming**. The official RPC and deployment guides provide testnet configuration only; Circle’s Arc USDC, EIP-3009, and Gateway/CCTP material found for this review is also testnet-scoped. Do not substitute testnet addresses or chain IDs for mainnet values, and do not deploy or claim mainnet readiness until the official details are published and independently checked.

Sources:

- [Arc network deployment model](https://docs.arc.io/arc/concepts/deployment-model)
- [Arc RPC endpoints](https://docs.arc.io/arc/references/rpc-endpoints)
- [Arc contract addresses](https://docs.arc.io/arc/references/contract-addresses)
- [Circle USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)

## Network facts

| Item | Arc Testnet (officially documented) | Arc Mainnet |
|---|---|---|
| Availability | Permissionless testnet | Private and public mainnet are listed as upcoming |
| Chain ID | `5042002` | Not published in the reviewed Arc RPC docs |
| HTTP RPC | `https://rpc.testnet.arc.io` | Not published |
| WebSocket RPC | `wss://rpc.testnet.arc.io` | Not published |
| Explorer | `https://testnet.arcscan.app` | Not published |
| Testnet USDC/ERC-20 interface | `0x3600000000000000000000000000000000000000` | Mainnet address not published in the reviewed Arc/Circle address references |
| Verification | Arc Testnet Explorer is Blockscout; Arc's guide shows Foundry `forge verify-contract` with the Blockscout verifier and testnet API URL | Mainnet verifier and endpoint not documented |
| Test tokens | Circle Faucet, selecting Arc Testnet | No mainnet faucet; no production funding route verified |

The testnet deployment guide's verification example uses chain ID `5042002` and `https://testnet.arcscan.app/api/`. These are not mainnet settings.

Sources:

- [Arc network deployment model](https://docs.arc.io/arc/concepts/deployment-model)
- [Arc RPC endpoints](https://docs.arc.io/arc/references/rpc-endpoints)
- [Arc contract addresses](https://docs.arc.io/arc/references/contract-addresses)
- [Deploy on Arc](https://docs.arc.io/arc/tutorials/deploy-on-arc)

## USDC accounting and EIP-3009

Arc's native USDC and its ERC-20 interface represent the same underlying balance but use different units:

- Native balance / gas accounting: 18 decimals.
- ERC-20 interface: 6 decimals.
- For application accounting, use the ERC-20 `balanceOf` and keep values in 6-decimal USDC units. Never use `address.balance` as the lending ledger.
- Do not mix native-value amounts and ERC-20 amounts; their integer representations differ by `10^12`.

Arc's official EIP-3009 relayer guide demonstrates `transferWithAuthorization` on **Arc Testnet**, with the testnet USDC interface and testnet chain ID. This establishes a testnet path only; it does not establish a mainnet USDC address or mainnet EIP-3009 domain.

Sources:

- [Arc EVM differences](https://docs.arc.io/arc/references/evm-differences)
- [Arc contract addresses](https://docs.arc.io/arc/references/contract-addresses)
- [Operate an EIP-3009 relayer on Arc](https://docs.arc.io/integrate/relayers-and-paymasters/eip-3009-relayer)

## x402 and facilitators

The current Circle Facilitator Service quickstart uses x402 version 2 and Arc Testnet (`eip155:5042002`). Its example `exact` payment requirements contain `scheme`, `network`, `asset`, `amount`, `payTo`, `maxTimeoutSeconds`, and `extra`. `amount` is an integer string in the asset's atomic units. The generic x402 EVM network identifier is CAIP-2 `eip155:<chainId>`.

Circle advertises its hosted Facilitator Service for Arc, but the Arc quickstart is explicitly testnet-based. No official mainnet chain/address configuration could be verified for the required deployment. The x402 format has a `payTo` address field, but this alone does not prove that Circle's facilitator accepts a **contract** recipient under its current production checks; that needs a concrete supported-network/API confirmation or a testnet end-to-end test.

Circle Gateway Nanopayments documentation says its EVM flow uses EIP-3009 signatures and does not support ERC-1271 signature validation. The official supported-blockchains material lists Arc testnet, not Arc mainnet. Do not assume Nanopayments is a viable mainnet route or that its contract-recipient behavior matches the project's splitter design.

Sources:

- [x402 Exact scheme](https://docs.x402.org/schemes/exact)
- [x402 networks and token support](https://docs.x402.org/core-concepts/network-and-token-support.md)
- [Circle Facilitator Service](https://developers.circle.com/facilitator-service)
- [Circle Facilitator Service Arc Testnet quickstart](https://developers.circle.com/facilitator-service/quickstart)
- [Circle Gateway supported blockchains](https://developers.circle.com/gateway/references/supported-blockchains.md)
- [Circle Nanopayments](https://developers.circle.com/gateway/nanopayments.md)

## Foundry and EVM compatibility

Arc's network overview identifies its execution environment as EVM (Osaka hard fork). Circle's Arc deployment tutorial uses Foundry and documents Blockscout verification on testnet. This is useful testnet evidence, not confirmation of a production mainnet RPC, supported compiler settings, or mainnet verification flow. Recheck the exact Foundry/toolchain settings against official mainnet documentation when it is available.

Source: [Deploy on Arc](https://docs.arc.io/arc/tutorials/deploy-on-arc)

## Getting USDC from Nigeria

The only confirmed Arc acquisition route in the reviewed Arc docs is the **testnet faucet**, which is not real USDC. Circle's supported-chain references identify Arc as testnet-only for relevant bridge/Gateway routes; they do not establish a mainnet bridge or a Nigeria-specific fiat on-ramp to Arc. No Nigeria on-ramp is recommended here without confirming both (1) the provider's current Nigeria availability and (2) a supported route to Arc mainnet once that network is live.

Sources:

- [Arc contract addresses / testnet faucet](https://docs.arc.io/arc/references/contract-addresses)
- [Circle Gateway supported blockchains](https://developers.circle.com/gateway/references/supported-blockchains.md)
- [Circle CCTP supported chains and domains](https://developers.circle.com/cctp/concepts/supported-chains-and-domains.md)

## Open questions before implementation

1. Is the intended target a Circle-accessible Private Mainnet, or the future Public Mainnet? The official deployment model currently lists both as upcoming.
2. Can Circle confirm that its production x402 facilitator supports Arc mainnet and accepts a smart-contract `payTo` such as `RevenueSplitter`? If not, the brief's self-operated EIP-3009 facilitator needs a mainnet USDC address/domain and a tested relayer path first.
3. What supported route will fund the deployer, vault, and buyer from Nigeria once mainnet is available?
4. Please provide the referenced `runway-prd.md` (to become `docs/PRD.md`). The prompt names it as the source of truth for scope, but it is not present in the supplied workspace.
5. The brief says a testnet-only build is ineligible. Should work pause at this checkpoint until mainnet documentation/access is available, or should the eligibility constraint be changed?

**Checkpoint:** Phase 0 has surfaced a blocking network-availability mismatch and unresolved payment/funding questions. No contract work should proceed until these are resolved and the missing PRD is supplied.