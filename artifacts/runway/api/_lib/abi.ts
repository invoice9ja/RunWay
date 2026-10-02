/**
 * Errors the contracts raise that are not plain `require` strings.
 *
 * Without these, viem sees an unknown 4-byte selector and reports "Unable to
 * decode signature", which hides the real revert reason from every negative
 * test. AccessControl in particular reverts with custom errors, so any call from
 * an account missing a role decodes to nothing useful.
 */
export const customErrorsAbi = [
  {
    type: 'error',
    name: 'AccessControlUnauthorizedAccount',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'neededRole', type: 'bytes32' },
    ],
  },
  {
    type: 'error',
    name: 'AccessControlBadConfirmation',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ERC20InsufficientBalance',
    inputs: [
      { name: 'sender', type: 'address' },
      { name: 'balance', type: 'uint256' },
      { name: 'needed', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'ERC20InsufficientAllowance',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'allowance', type: 'uint256' },
      { name: 'needed', type: 'uint256' },
    ],
  },
  { type: 'error', name: 'NothingToWithdraw', inputs: [] },
  { type: 'error', name: 'FactoryAlreadyInitialized', inputs: [] },
] as const;

export const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    // EIP-3009
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
      // Arc testnet USDC takes the signature split into v/r/s, not as one bytes
      // argument. Selector 0xe3ee160e. The 7-arg `bytes` form is the other
      // common shape (0xcf092995) and encoding against the wrong one fails at
      // send time with a params/values length mismatch.
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    // EIP-3009 nonce replay guard
    type: 'function',
    name: 'authorizationState',
    stateMutability: 'view',
    inputs: [
      { name: 'authorizer', type: 'address' },
      { name: 'nonce', type: 'bytes32' },
    ],
    outputs: [{ type: 'bool' }],
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
] as const;

export const splitterAbi = [
  { type: 'function', name: 'agent', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'payout', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'usdc', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'vault', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'shareBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'agentClaimable', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'lastSettledBalance', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'lifetimeRevenue', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'loanActive', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'getUnsettledRevenue', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'event',
    name: 'Settled',
    inputs: [
      { name: 'revenue', type: 'uint256', indexed: true },
      { name: 'lenderShare', type: 'uint256', indexed: true },
      { name: 'agentShare', type: 'uint256', indexed: true },
      { name: 'advanceRepaid', type: 'uint256', indexed: false },
    ],
  },
  { type: 'function', name: 'surplus', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getBalance', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getAgentOwed', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getDebtOwed', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'loanActive', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'lifetimeRevenue', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  {
    type: 'event',
    name: 'Withdrawn',
    inputs: [
      { name: 'agent', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
] as const;

export const vaultAbi = [
  { type: 'function', name: 'usdc', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getBalance', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'getTotalOutstanding',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getLoansLength',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  { type: 'function', name: 'GLOBAL_MAX', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'STARTER_CAP', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'FEE_BPS_DEFAULT',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'SHARE_BPS_DEFAULT',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getLoanId',
    stateMutability: 'view',
    inputs: [{ name: 'splitter', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getLoan',
    stateMutability: 'view',
    inputs: [{ name: 'loanId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
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
        ],
      },
    ],
  },
  {
    type: 'event',
    name: 'LoanOpened',
    inputs: [
      { name: 'loanId', type: 'uint256', indexed: true },
      { name: 'splitter', type: 'address', indexed: true },
      { name: 'principal', type: 'uint256', indexed: false },
      { name: 'fee', type: 'uint256', indexed: false },
      { name: 'totalDue', type: 'uint256', indexed: false },
      { name: 'feeBps', type: 'uint256', indexed: false },
      { name: 'shareBps', type: 'uint256', indexed: false },
      { name: 'dueDate', type: 'uint256', indexed: false },
      { name: 'rationaleHash', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Repaid',
    inputs: [
      { name: 'loanId', type: 'uint256', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'outstanding', type: 'uint256', indexed: false },
    ],
  },
  { type: 'function', name: 'availableToWithdraw', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'advanceOutstanding', stateMutability: 'view', inputs: [{ name: 'splitter', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalDue', stateMutability: 'view', inputs: [{ name: 'loanId', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'openLoan',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'splitter', type: 'address' },
      { name: 'principal', type: 'uint256' },
      { name: 'rationaleHash', type: 'bytes32' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'FundsDeposited',
    inputs: [{ name: 'amount', type: 'uint256', indexed: false }],
  },
  {
    type: 'event',
    name: 'SplitterRegistered',
    inputs: [
      { name: 'splitter', type: 'address', indexed: true },
      { name: 'agent', type: 'address', indexed: true },
    ],
  },
] as const;

export const factoryAbi = [
  {
    type: 'function',
    name: 'getAllSplitters',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'getSplittersCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  { type: 'function', name: 'getVault', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'event',
    name: 'SplitterCreated',
    inputs: [
      { name: 'splitter', type: 'address', indexed: true },
      { name: 'agent', type: 'address', indexed: true },
      { name: 'payout', type: 'address', indexed: true },
    ],
  },
] as const;
