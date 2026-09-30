import type { Address } from 'viem';

const read = (key: string, fallback = ''): string => {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
};

const readAddress = (key: string, fallback: Address): Address =>
  read(key, fallback).trim() as Address;

export const config = {
  /** Base Sepolia public RPC. No API key, so it is safe to ship in the client too. */
  rpcUrl: read('RUNWAY_RPC_URL', 'https://sepolia.base.org'),
  chainId: Number(read('RUNWAY_CHAIN_ID', '84532')),
  /** x402 `network` identifier. */
  network: read('RUNWAY_NETWORK', 'base-sepolia'),
  explorer: read('RUNWAY_EXPLORER_URL', 'https://sepolia.basescan.org'),

  usdc: readAddress(
    'RUNWAY_USDC_ADDRESS',
    '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  ),
  vault: readAddress(
    'RUNWAY_VAULT_ADDRESS',
    '0x50521815D832eb80BabBA0f888c686Fb224f2Dd4',
  ),
  factory: readAddress(
    'RUNWAY_FACTORY_ADDRESS',
    '0xC278850c7194a8ecD8b81A223847F995Ad56fCdf',
  ),
  /** Agent revenue router. Every x402 receipt is forwarded here. */
  splitter: readAddress(
    'RUNWAY_SPLITTER_ADDRESS',
    '0x96030e714e14b848445b40dfc327d828a3f474f6',
  ),

  /**
   * Testnet-only operational key. It signs EIP-3009 authorizations for the demo
   * buyer and submits keeper settlements. It holds no mainnet value and MUST be
   * replaced with a low-value, dedicated testnet key before any public demo.
   */
  settlerKey: read('RUNWAY_PRIVATE_KEY'),
  /** Guards /api/keeper and /api/demo/buy from being triggered by anyone. */
  keeperSecret: read('RUNWAY_KEEPER_SECRET'),
  /** Vercel Cron sends this automatically. */
  cronSecret: read('CRON_SECRET'),

  /** Minimum unsettled revenue (USDC base units) the keeper will route. */
  settleThreshold: BigInt(read('RUNWAY_SETTLE_THRESHOLD', '100000')),
  /** Default price of the demo resource served by /api/x402/resource. */
  defaultPrice: BigInt(read('RUNWAY_DEMO_PRICE', '100000')),

  decimals: 6,
} as const;

export const explorerAddress = (address: string): string =>
  `${config.explorer}/address/${address}`;

export const explorerTx = (hash: string): string =>
  `${config.explorer}/tx/${hash}`;

export function formatUsdc(value: bigint, dp = 6): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(dp);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(dp, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export function isAuthorized(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  const expected = config.keeperSecret || config.cronSecret;
  if (!expected) return process.env.NODE_ENV !== 'production';
  const auth = req.headers.authorization;
  const bearer = Array.isArray(auth) ? auth[0] : auth;
  const provided = [
    req.headers['x-keeper-secret'],
    bearer?.startsWith('Bearer ') ? bearer.slice(7) : undefined,
  ];
  return provided.some(
    (value) => typeof value === 'string' && value.length > 0 && value === expected,
  );
}
