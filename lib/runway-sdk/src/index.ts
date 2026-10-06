/**
 * Runway SDK.
 *
 * Revenue-routed working capital for AI agents on Arc. An agent's x402 payment
 * revenue is the collateral: a lender takes an automatic share of every incoming
 * payment, which is what makes an advance repayable without a credit check.
 *
 * Typical integration:
 *
 *   1. Deploy a splitter with { createSplitter }.
 *   2. Wrap the endpoint with { createSeller }, paying into that splitter.
 *   3. Call { settle } whenever revenue lands, or run a keeper that does.
 *   4. Call { requestAdvance } when cash-flow constrained.
 */
export {
  createRunwayClient,
  createSeller,
  createSplitter,
  getSplitterStatus,
  getVaultStatus,
  requestAdvance,
  settle,
  withdraw,
  formatUsdc,
  usdc,
  splitSignature,
  type CreateClientOptions,
  type PaymentVerification,
  type RunwayClient,
  type RunwayConfig,
  type Seller,
  type SellerOptions,
  type SplitterStatus,
  type VaultStatus,
} from './client.js';

export {
  decodeHeader,
  encodeHeader,
  transferWithAuthorizationTypes,
  usdcDomain,
  FACTORY_ARC_TESTNET,
  USDC_ARC_TESTNET,
  VAULT_ARC_TESTNET,
  X402_VERSION,
  type Authorization,
  type PaymentChallenge,
  type PaymentPayload,
  type PaymentRequirements,
} from './types.js';

export { erc20Abi, splitterAbi, vaultAbi, factoryAbi, approveAbi, withdrawAbi } from './types.js';

/** Re-exported so callers do not need a direct viem dependency for addresses. */
export type { Address } from 'viem';
