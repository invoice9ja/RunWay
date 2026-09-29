# Runway — Arc and x402 reconnaissance

**Reviewed:** 2026-09-30  
**Status:** Testnet prototype authorized; no mainnet deployment is in scope.

## Executive finding

The supplied brief requires Arc mainnet, but the official Arc deployment model currently lists both Private Mainnet and Public Mainnet as **Upcoming**. This build therefore targets Arc Testnet only. Do not substitute testnet settings for mainnet values or describe the prototype as mainnet-ready.

Sources:

- [Arc network deployment model](https://docs.arc.io/arc/concepts/deployment-model)
- [Arc RPC endpoints](https://docs.arc.io/arc/references/rpc-endpoints)
- [Arc contract addresses](https://docs.arc.io/arc/references/contract-addresses)
- [Circle USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)

## Network facts

| Item | Arc Testnet (officially documented) | Arc Mainnet |
|---|---|---|
| Availability | Permissionless testnet | Private and public mainnet listed as upcoming |
| Chain ID | `5042002` | Not published in reviewed RPC docs |
| HTTP RPC | `https://rpc.testnet.arc.io` | Not published |
| WebSocket RPC | `wss://rpc.testnet.arc.io` | Not published |
| Explorer | `https://testnet.arcscan.app` | Not published |
| USDC/ERC-20 interface | `0x3600000000000000000000000000000000000000` | Mainnet address not published in reviewed references |
| Verification | Testnet Explorer is Blockscout; Arc guide uses Foundry `forge verify-contract` with testnet API URL | Mainnet verifier and endpoint not documented |
| Test tokens | Circle Faucet, selecting Arc Testnet | No mainnet faucet or production funding route verified |

The testnet verification example uses chain ID `5042002` and `https://testnet.arcscan.app/api/`. These are not mainnet settings.

Sources:

- [Arc network deployment model](https://docs.arc.io/arc/concepts/deployment-model)
- [Arc RPC endpoints](https://docs.arc.io/arc/references/rpc-endpoints)
- [Arc contract addresses](https://docs.arc.io/arc/references/contract-addresses)
- [Deploy on Arc](https://docs.arc.io/arc/tutorials/deploy-on-Arc)

## USDC accounting and EIP-3009

Arc's native USDC and ERC-20 interface represent the same underlying balance but use different units:

- Native balance / gas accounting: 18 decimals.
- ERC-20 interface: 6 decimals.
- Protocol accounting uses ERC-20 `balanceOf` in 6-decimal USDC units. Never use `address.balance` as the lending ledger.
- Do not mix native-value amounts and ERC-20 amounts; their integer representations differ by `10^12`.

Arc's EIP-3009 relayer guide demonstrates `transferWithAuthorization` on Arc Testnet using the testnet USDC interface and chain ID. This is testnet evidence only.

Sources:

- [Arc EVM differences](https://docs.arc.io/arc/references/evm-differences)
- [Arc contract addresses](https://docs.arc.io/arc/references/contract-addresses)
- [Operate an EIP-3009 relayer on Arc](https://docs.arc.io/integrate/relayers-and-paymasters/eip-3009-relayer)

## x402 and facilitators

Circle's Facilitator Service quickstart uses x402 version 2 and Arc Testnet (`eip155:5042002`). Its example `exact` requirements contain `scheme`, `network`, `asset`, `amount`, `payTo`, `maxTimeoutSeconds`, and `extra`. `amount` is an integer string in the asset's atomic units. The generic x402 EVM network identifier is CAIP-2 `eip155:<chainId>`.

Circle advertises its hosted facilitator for Arc, but its Arc quickstart is explicitly testnet-based. The x402 `payTo` field accepts an address syntactically; this does not by itself prove Circle's facilitator accepts a **contract** recipient under its current checks. This prototype uses a self-operated testnet EIP-3009 relayer path instead of claiming Circle production-facilitator support.

Circle Gateway Nanopayments documentation says its EVM flow does not support ERC-1271 signature validation. Its supported-chain material lists Arc testnet, not Arc mainnet. Nanopayments is not treated as an available mainnet route.

Sources:

- [x402 Exact scheme](https://docs.x402.org/schemes/exact)
- [x402 networks and token support](https://docs.x402.org/core-concepts/network-and-token-support.md)
- [Circle Facilitator Service](https://developers.circle.com/facilitator-service)
- [Circle Facilitator Service Arc Testnet quickstart](https://developers.circle.com/facilitator-service/quickstart)
- [Circle Gateway supported blockchains](https://developers.circle.com/gateway/references/supported-blockchains.md)
- [Circle Nanopayments](https://developers.circle.com/gateway/nanopayments.md)

## Foundry and EVM compatibility

Arc's network overview identifies its execution environment as EVM (Osaka hard fork). The Circle deployment guide uses Foundry and documents Blockscout verification on testnet. This project compiles Solidity `^0.8.24` for Cancun and avoids relying on newer fork-specific opcodes. Recheck compiler settings and verification flow against official production guidance before any mainnet work.

Source: [Deploy on Arc](https://docs.arc.io/arc/tutorials/deploy-on-arc)

## Getting USDC from Nigeria

The confirmed Arc acquisition route in reviewed Arc docs is the testnet faucet, which has no real value. Circle's supported-chain references identify Arc as testnet-only for relevant bridge/Gateway routes; they do not establish a Nigeria-specific fiat on-ramp to Arc mainnet. No real-money route is configured in this prototype.

Sources:

- [Arc contract addresses / testnet faucet](https://docs.arc.io/arc/references/contract-addresses)
- [Circle Gateway supported blockchains](https://developers.circle.com/gateway/references/supported-blockchains.md)
- [Circle CCTP supported chains and domains](https://developers.circle.com/cctp/concepts/supported-chains-and-domains.md)

## Remaining limitations

- The referenced `runway-prd.md` was not attached. This prototype follows the supplied development brief and should be checked against the PRD before expanding scope.
- All deployment scripts hard-check Arc Testnet chain ID `5042002`.
- No mainnet settings, mainnet deployment, production facilitator claim, or real USDC funding instructions are included.