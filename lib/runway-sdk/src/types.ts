import type { Abi, AbiEvent, Address } from 'viem';

/** x402 exact-scheme challenge version. */
export const X402_VERSION = 1;

/** USDC on Arc testnet. */
/** Chain id the bundled contract addresses below belong to. */
export const ARC_TESTNET_CHAIN_ID = 5042002;

export const USDC_ARC_TESTNET: Address = '0x3600000000000000000000000000000000000000';

/**
 * RunwayFactory on Arc testnet, chain 5042002.
 *
 * Current deployment. The first testnet deployment (factory 0x62F0bE8a, vault
 * 0xc9497Ec4) is superseded and must not be used: its splitter locked admin to
 * an address that could not grant roles. Kept here as a reminder not to fall
 * back to it.
 */
export const FACTORY_ARC_TESTNET: Address = '0xc8f5ae45cfbc7a9f17248fd610adc989f8d08106';

/** RunwayVault on Arc testnet. Current deployment; see the note above. */
export const VAULT_ARC_TESTNET: Address = '0x30f5f5d45bbf94487fa3cae069d5bdaadb6744ab';

export type PaymentRequirements = {
  scheme: 'exact';
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: Address;
  maxTimeoutSeconds: number;
  asset: Address;
  extra: { name: string; version: string };
};

export type PaymentChallenge = {
  x402Version: number;
  error: string;
  accepts: PaymentRequirements[];
};

export type Authorization = {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
};

export type PaymentPayload = {
  x402Version: number;
  scheme: 'exact';
  network: string;
  payload: { signature: `0x${string}`; authorization: Authorization };
};

/**
 * Circle's USDC (FiatTokenV2) uses a fixed EIP-712 domain rather than
 * discovering one via EIP-5267. It must match the chain the payment settles on,
 * or the payer's signature will not recover.
 */
export const usdcDomain = (chainId: number, usdc: Address) =>
  ({ name: 'USDC', version: '2', chainId, verifyingContract: usdc }) as const;

/** EIP-3009 `TransferWithAuthorization` struct. */
export const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/** Base64 of a JSON object, as the x402 header spec requires. */
export function encodeHeader(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

export function decodeHeader<T>(raw: string): T {
  return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as T;
}

/** Minimal USDC surface: EIP-3009 pull plus the reads needed to verify one. */
export const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'authorizationState',
    stateMutability: 'view',
    inputs: [
      { name: 'authorizer', type: 'address' },
      { name: 'nonce', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'transferWithAuthorization',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const satisfies Abi;

/** Splitter reads a seller or status page needs. */
export const splitterAbi = [
  { type: 'function', name: 'agent', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'payout', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'shareBps', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'agentClaimable', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'advanceHeld', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'lifetimeRevenue', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'lastSettledBalance', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'loanActive', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'getBalance', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'getUnsettledRevenue', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'getAgentOwed', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'getDebtOwed', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
] as const satisfies Abi;

export const vaultAbi = [
  { type: 'function', name: 'openLoan', stateMutability: 'nonpayable', inputs: [
    { name: 'splitter', type: 'address' },
    { name: 'principal', type: 'uint256' },
    { name: 'rationaleHash', type: 'bytes32' },
  ], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'getLoanId', stateMutability: 'view', inputs: [{ name: 'splitter', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'advanceOutstanding', stateMutability: 'view', inputs: [{ name: 'splitter', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'getBalance', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'getTotalOutstanding', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'getLoansLength', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'getLoan', stateMutability: 'view', inputs: [{ name: 'loanId', type: 'uint256' }], outputs: [{ type: 'tuple', components: [
    { name: 'splitter', type: 'address' },
    { name: 'principal', type: 'uint256' },
    { name: 'feeBps', type: 'uint256' },
    { name: 'shareBps', type: 'uint256' },
    { name: 'dueDate', type: 'uint256' },
    { name: 'repaid', type: 'uint256' },
    { name: 'delinquent', type: 'bool' },
    { name: 'flagged', type: 'bool' },
    { name: 'rationaleHash', type: 'bytes32' },
    { name: 'active', type: 'bool' },
  ] }] },
] as const satisfies Abi;

export const factoryAbi = [
  { type: 'function', name: 'createSplitter', stateMutability: 'nonpayable', inputs: [
    { name: 'agent', type: 'address' },
    { name: 'payout', type: 'address' },
  ], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'getAllSplitters', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address[]' }] },
  { type: 'function', name: 'defaultShareBps', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
] as const satisfies Abi;

export type { AbiEvent };
/*
 * Narrow single-function ABIs.
 *
 * viem infers a call's arguments from the whole ABI it is handed, so passing the
 * combined surface makes every write a type error. One constant per function
 * keeps the calls type-checked rather than cast away.
 */
export const transferWithAuthorizationAbi = [{
  type: 'function',
  name: 'transferWithAuthorization',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'v', type: 'uint8' },
    { name: 'r', type: 'bytes32' },
    { name: 's', type: 'bytes32' },
  ],
  outputs: [{ name: '', type: 'bool' }],
}] as const satisfies Abi;

export const transferAbi = [{
  type: 'function',
  name: 'transfer',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
  ],
  outputs: [{ name: '', type: 'bool' }],
}] as const satisfies Abi;

export const settleAbi = [{
  type: 'function',
  name: 'settle',
  stateMutability: 'nonpayable',
  inputs: [],
  outputs: [],
}] as const satisfies Abi;

export const withdrawAbi = [{
  type: 'function',
  name: 'withdraw',
  stateMutability: 'nonpayable',
  inputs: [],
  outputs: [],
}] as const satisfies Abi;

export const openLoanAbi = [{
  type: 'function',
  name: 'openLoan',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'splitter', type: 'address' },
    { name: 'principal', type: 'uint256' },
    { name: 'rationaleHash', type: 'bytes32' },
  ],
  outputs: [{ name: '', type: 'uint256' }],
}] as const satisfies Abi;

export const createSplitterAbi = [{
  type: 'function',
  name: 'createSplitter',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'agent', type: 'address' },
    { name: 'payout', type: 'address' },
  ],
  outputs: [{ name: '', type: 'address' }],
}] as const satisfies Abi;

export const allowanceAbi = [{
  type: 'function',
  name: 'allowance',
  stateMutability: 'view',
  inputs: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
  ],
  outputs: [{ name: '', type: 'uint256' }],
}] as const satisfies Abi;

export const authorizationStateAbi = [{
  type: 'function',
  name: 'authorizationState',
  stateMutability: 'view',
  inputs: [
    { name: 'authorizer', type: 'address' },
    { name: 'nonce', type: 'bytes32' },
  ],
  outputs: [{ name: '', type: 'uint256' }],
}] as const satisfies Abi;

/** Events, used to read a splitter address out of a deployment receipt. */
export const splitterCreatedEvent = {
  type: 'event',
  name: 'SplitterCreated',
  inputs: [
    { name: 'splitter', type: 'address', indexed: true },
    { name: 'agent', type: 'address', indexed: true },
  ],
} as const satisfies AbiEvent;

export const loanOpenedEvent = {
  type: 'event',
  name: 'LoanOpened',
  inputs: [
    { name: 'loanId', type: 'uint256', indexed: true },
    { name: 'splitter', type: 'address', indexed: true },
  ],
} as const satisfies AbiEvent;

/**
 * Single-view ABIs.
 *
 * Written out literally rather than generated. A helper that builds these dropped
 * the function name, which gave every one of them viem's fallback selector and
 * made every read hit the same unknown function. Selectors verified against the
 * deployed bytecode with `cast sig`.
 */
export const agentAbi = [{
  type: 'function', name: 'agent', stateMutability: 'view', inputs: [],
  outputs: [{ name: '', type: 'address' }],
}] as const satisfies Abi;
export const payoutAbi = [{
  type: 'function', name: 'payout', stateMutability: 'view', inputs: [],
  outputs: [{ name: '', type: 'address' }],
}] as const satisfies Abi;
export const shareBpsAbi = [{
  type: 'function', name: 'shareBps', stateMutability: 'view', inputs: [],
  outputs: [{ name: '', type: 'uint256' }],
}] as const satisfies Abi;
export const getBalanceAbi = [{
  type: 'function', name: 'getBalance', stateMutability: 'view', inputs: [],
  outputs: [{ name: '', type: 'uint256' }],
}] as const satisfies Abi;
export const lifetimeRevenueAbi = [{
  type: 'function', name: 'lifetimeRevenue', stateMutability: 'view', inputs: [],
  outputs: [{ name: '', type: 'uint256' }],
}] as const satisfies Abi;
export const unsettledAbi = [{
  type: 'function', name: 'getUnsettledRevenue', stateMutability: 'view', inputs: [],
  outputs: [{ name: '', type: 'uint256' }],
}] as const satisfies Abi;
export const agentClaimableAbi = [{
  type: 'function', name: 'agentClaimable', stateMutability: 'view', inputs: [],
  outputs: [{ name: '', type: 'uint256' }],
}] as const satisfies Abi;
export const advanceHeldAbi = [{
  type: 'function', name: 'advanceHeld', stateMutability: 'view', inputs: [],
  outputs: [{ name: '', type: 'uint256' }],
}] as const satisfies Abi;
export const agentOwedAbi = [{
  type: 'function', name: 'getAgentOwed', stateMutability: 'view', inputs: [],
  outputs: [{ name: '', type: 'uint256' }],
}] as const satisfies Abi;
export const debtOwedAbi = [{
  type: 'function', name: 'getDebtOwed', stateMutability: 'view', inputs: [],
  outputs: [{ name: '', type: 'uint256' }],
}] as const satisfies Abi;
export const loanActiveAbi = [{
  type: 'function', name: 'loanActive', stateMutability: 'view', inputs: [],
  outputs: [{ name: '', type: 'bool' }],
}] as const satisfies Abi;
export const getVaultBalanceAbi = [{
  type: 'function', name: 'getBalance', stateMutability: 'view', inputs: [],
  outputs: [{ name: '', type: 'uint256' }],
}] as const satisfies Abi;
export const totalOutstandingAbi = [{
  type: 'function', name: 'getTotalOutstanding', stateMutability: 'view', inputs: [],
  outputs: [{ name: '', type: 'uint256' }],
}] as const satisfies Abi;
export const loansLengthAbi = [{
  type: 'function', name: 'getLoansLength', stateMutability: 'view', inputs: [],
  outputs: [{ name: '', type: 'uint256' }],
}] as const satisfies Abi;

export const approveAbi = [{
  type: 'function',
  name: 'approve',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
  ],
  outputs: [{ name: '', type: 'bool' }],
}] as const satisfies Abi;
