import { config } from './config.js';
import {
  decodeEventLog,
  toEventSelector,
  type Abi,
  type AbiEvent,
  type Address,
} from 'viem';

/**
 * Ledger reads through the explorer API instead of `eth_getLogs`.
 *
 * Scanning logs directly is a losing game on this chain. Public endpoints cap a
 * range near 5,000 blocks and the keyed one caps it at ten, while Arc testnet
 * produces a block every half second — so any fixed window is either too slow to
 * fetch or too short to contain the deployment's history. A window that is too
 * short does not fail loudly: it returns an empty ledger that looks healthy,
 * which is worse than an error.
 *
 * The explorer indexes all of it already, with timestamps attached, and answers
 * in a couple of requests. So the ledger is read here, and `eth_getLogs` is kept
 * only as a fallback for when the explorer is unreachable.
 *
 * Only read paths. Nothing here writes or signs.
 */

/** Blockscout-style REST base for the configured explorer. */
function apiBase(): string {
  const base = config.explorer.replace(/\/+$/, '');
  return `${base}/api/v2`;
}

export type ExplorerTransfer = {
  transaction: `0x${string}`;
  block: number;
  timestamp: string;
  from: string;
  to: string;
  /** Raw base-unit amount as reported, already scaled by the token's decimals. */
  value: bigint;
  decimals: number;
  token: string;
};

type Json = Record<string, unknown>;

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    headers: { accept: 'application/json' },
    // The explorer caches by block, so a stale answer is not a risk, but a
    // cached one would be: a ledger that lags is a ledger that lies.
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`explorer ${path} returned ${response.status}`);
  return (await response.json()) as T;
}

const addressHash = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : ((value as Json | undefined)?.hash as string | undefined) ?? '';

/**
 * Token transfers involving an address, newest first.
 *
 * Filtered to the protocol's own token here rather than at the endpoint, because
 * the endpoint's token filter rejects the precompile-style address Arc uses for
 * its native asset.
 */
export async function fetchTransfers(
  address: Address,
  options: { token?: Address; limit?: number } = {},
): Promise<ExplorerTransfer[]> {
  const page = await getJson<{ items?: unknown[] }>(
    `/addresses/${address}/token-transfers`,
  );
  const items = Array.isArray(page.items) ? page.items : [];
  const token = options.token?.toLowerCase();

  const rows: ExplorerTransfer[] = [];
  for (const raw of items) {
    const item = raw as Json;
    const tokenInfo = item.token as Json | undefined;
    const total = item.total as Json | undefined;

    const tokenAddress = (tokenInfo?.address_hash as string | undefined) ?? '';
    if (token && tokenAddress.toLowerCase() !== token) continue;

    const value = (total?.value as string | undefined) ?? '0';
    const decimals = Number(total?.decimals ?? tokenInfo?.decimals ?? 6);

    rows.push({
      transaction: item.transaction_hash as `0x${string}`,
      block: Number(item.block_number ?? 0),
      timestamp: (item.timestamp as string | undefined) ?? '',
      from: addressHash(item.from),
      to: addressHash(item.to),
      value: BigInt(value),
      decimals,
      token: tokenAddress,
    });
  }

  rows.sort((a, b) => b.block - a.block || Number(b.timestamp > a.timestamp));
  return options.limit ? rows.slice(0, options.limit) : rows;
}

export type ExplorerEvent = {
  transaction: `0x${string}`;
  block: number;
  timestamp: string;
  /** Event name, resolved from our own ABI rather than the explorer's. */
  name: string;
  args: Record<string, unknown>;
  emitter: string;
};

/**
 * Events emitted by an address, decoded with our ABI, newest first.
 *
 * Enumerated from the address's own log index rather than its transaction list.
 * That distinction matters: a contract can emit a log from inside a call it did
 * not initiate, so the transaction endpoint is not a superset of the logs. Asking
 * transactions would have silently hidden the vault's Repaid event, which is
 * emitted while settling.
 *
 * Decoding uses the ABI in this repo rather than the explorer's `decoded` field:
 * that field is only populated for verified contracts, and it comes back as a
 * method-call shape here, so trusting it would yield an empty ledger for an
 * unverified deployment.
 *
 * The log rows already carry their block timestamp, so this is one request per
 * address with no follow-up round trips.
 */
export async function fetchEvents(
  address: Address,
  abi: Abi,
  options: { names?: string[]; limit?: number } = {},
): Promise<ExplorerEvent[]> {
  const byTopic = new Map<string, AbiEvent>();
  for (const item of abi as readonly { type: string }[]) {
    if (item.type !== 'event') continue;
    const event = item as AbiEvent;
    byTopic.set(toEventSelector(event), event);
  }

  const wanted = options.names ? new Set(options.names.map((n) => n.toLowerCase())) : null;
  const rows: ExplorerEvent[] = [];

  // Follow pagination, but only as far as a dashboard read needs. The cap is on
  // pages rather than rows because a busy address can hold thousands of logs.
  let params = '';
  for (let page = 0; page < 5; page += 1) {
    const body = await getJson<{ items?: unknown[]; next_page_params?: Record<string, unknown> }>(
      `/addresses/${address}/logs${params}`,
    );
    for (const raw of Array.isArray(body.items) ? body.items : []) {
      const log = raw as Json;
      const topics = (log.topics as string[] | undefined) ?? [];
      const definition = topics[0] ? byTopic.get(topics[0]) : undefined;
      if (!definition) continue;
      if (wanted && !wanted.has(definition.name.toLowerCase())) continue;

      let args: Record<string, unknown> = {};
      try {
        const decoded = decodeEventLog({
          abi: [definition],
          data: log.data as `0x${string}`,
          topics: topics as unknown as [`0x${string}`, ...`0x${string}`[]],
        });
        args = (decoded.args ?? {}) as Record<string, unknown>;
      } catch {
        // Keep the row even when decoding fails, so the transaction stays linked.
      }

      rows.push({
        transaction: log.transaction_hash as `0x${string}`,
        block: Number(log.block_number ?? 0),
        timestamp: (log.block_timestamp as string | undefined) ?? '',
        name: definition.name,
        args,
        emitter: addressHash(log.address) || address,
      });
    }

    const next = body.next_page_params;
    if (!next || Object.keys(next).length === 0) break;
    params = `?${new URLSearchParams(
      Object.entries(next).map(([k, v]) => [k, String(v)]),
    ).toString()}`;
  }

  rows.sort((a, b) => b.block - a.block);
  return options.limit ? rows.slice(0, options.limit) : rows;
}

/**
 * Whether the explorer answered.
 *
 * The caller uses this to decide between the explorer and the log-scan
 * fallback, so it must not throw: an unreachable explorer is a fallback, not a
 * failed request.
 */
export async function explorerAvailable(): Promise<boolean> {
  try {
    await getJson('/stats');
    return true;
  } catch {
    return false;
  }
}
