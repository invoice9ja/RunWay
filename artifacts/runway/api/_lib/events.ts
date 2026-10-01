import { decodeEventLog, toEventSelector, type Abi, type AbiEvent } from 'viem';

import type { RunwayPublicClient } from './chain.js';

/**
 * Block window per `eth_getLogs` request.
 *
 * Measured against the public Arc endpoint: the full 20,000-block window in
 * 10,000-block chunks is two requests and returns in under half a second, while
 * 300-block chunks produced over two hundred requests and tripped the rate
 * limiter. Fewer, wider requests are strictly better here. The limit exists at
 * all because the endpoint rejects very long ranges.
 */
const CHUNK = 10_000n;

/**
 * USDC needs a much smaller chunk than the protocol contracts.
 *
 * Arc testnet USDC is high-traffic: a 3,000-block window carries around 15,000
 * transfer logs. Wide queries against it are rejected, so the same 10,000-block
 * chunk that serves the vault in two requests fails for the token and silently
 * drops every receipt.
 */
const CHUNK_HIGH_TRAFFIC = 3_000n;

/** Ceiling so one status read cannot fan out into an unbounded call storm. */
const MAX_CHUNKS = 8;

/**
 * Errors are retried; empty results are not.
 *
 * Retrying empties was tripling the request count to defend against a lagging
 * node, which triggered the rate limiting it was meant to avoid. A wide chunk
 * served by a healthy node returns the events; if one chunk really is served
 * stale, the next status poll picks them up, and the payload reports chunk
 * failures so a persistent problem is visible.
 */
const RETRIES = 2;
const BACKOFF_MS = 400;

export type LogRow = {
  transaction: `0x${string}`;
  explorer: string;
  block: number;
  topic0: string;
  args: Record<string, unknown>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type FetchStats = {
  chunks: number;
  retries: number;
  failedChunks: number;
  calls: number;
  perAddress: Record<string, { chunks: number; calls: number; failedChunks: number }>;
};

export const newFetchStats = (): FetchStats => ({
  chunks: 0,
  retries: 0,
  failedChunks: 0,
  calls: 0,
  perAddress: {},
});

/**
 * topic0 for every event in an ABI, keyed by name.
 *
 * Resolved once up front so callers can filter decoded rows by event name
 * without recomputing hashes or re-querying the chain.
 */
export function topicsByName(abi: Abi): Record<string, `0x${string}`> {
  const map: Record<string, `0x${string}`> = {};
  for (const item of abi as readonly { type: string }[]) {
    if (item.type !== 'event') continue;
    const event = item as AbiEvent;
    map[event.name] = toEventSelector(event);
  }
  return map;
}

/**
 * Fetch every log an address emitted over a window, chunked and retried.
 *
 * One pass per address rather than one pass per event. The previous version
 * issued a separate range request per event name, so five event queries across
 * four chunks with retries came to roughly eighty RPC calls per status read,
 * which the public endpoint rate-limits. Fetching once and filtering by topic
 * locally cuts that to a third and keeps the history intact.
 *
 * Topics are decoded against the supplied ABI, so no second round trip is needed.
 */
export async function fetchLogsForAddress(
  client: RunwayPublicClient,
  options: {
    address: `0x${string}`;
    abi: Abi;
    fromBlock: bigint;
    toBlock: bigint;
    /** Override for high-traffic addresses such as USDC. */
    chunk?: bigint;
  },
  explorerTx: (hash: string) => string,
  stats: FetchStats,
): Promise<LogRow[]> {
  const rows: LogRow[] = [];
  const chunkSize = options.chunk ?? CHUNK;
  const bucket = (stats.perAddress[options.address] ??= { chunks: 0, calls: 0, failedChunks: 0 });

  const events = (options.abi as readonly { type: string }[])
    .filter((item) => item.type === 'event')
    .map((item) => item as AbiEvent);
  const byTopic = new Map<string, AbiEvent>();
  for (const event of events) byTopic.set(toEventSelector(event), event);

  for (
    let start = options.fromBlock, chunk = 0;
    start <= options.toBlock && chunk < MAX_CHUNKS;
    start += chunkSize, chunk += 1
  ) {
    const end = start + chunkSize - 1n > options.toBlock ? options.toBlock : start + chunkSize - 1n;
    stats.chunks += 1;
    bucket.chunks += 1;

    let collected: LogRow[] = [];
    let resolved = false;

    for (let attempt = 0; attempt <= RETRIES && !resolved; attempt += 1) {
      if (attempt > 0) {
        stats.retries += 1;
        await sleep(BACKOFF_MS * attempt);
      }
      stats.calls += 1;
      bucket.calls += 1;
      try {
        const logs = (await client.request({
          method: 'eth_getLogs',
          params: [
            {
              address: options.address,
              fromBlock: `0x${start.toString(16)}`,
              toBlock: `0x${end.toString(16)}`,
            },
          ],
        } as never)) as ReadonlyArray<{
          transactionHash: `0x${string}`;
          blockNumber: `0x${string}`;
          topics: readonly `0x${string}`[];
          data: `0x${string}`;
        }>;

        collected = logs.map((log) => {
          const topic0 = log.topics[0] ?? '0x';
          let args: Record<string, unknown> = {};
          const definition = byTopic.get(topic0);
          if (definition) {
            try {
              const decoded = decodeEventLog({
                abi: [definition],
                data: log.data,
                topics: log.topics as unknown as [`0x${string}`, ...`0x${string}`[]],
              });
              args = (decoded.args ?? {}) as Record<string, unknown>;
            } catch {
              // Keep the row even when decoding fails, so the tx stays linked.
            }
          }
          return {
            transaction: log.transactionHash,
            explorer: explorerTx(log.transactionHash),
            block: Number(BigInt(log.blockNumber)),
            topic0,
            args,
          };
        });

        resolved = true;
      } catch {
        // Rate limited or rejected; retry with backoff.
      }
    }

    if (!resolved) {
      stats.failedChunks += 1;
      bucket.failedChunks += 1;
    }
    rows.push(...collected);
  }

  return rows.sort((a, b) => b.block - a.block);
}

export function bigintArg(row: LogRow, key: string): bigint {
  return row.args[key] as bigint;
}

export function addressArg(row: LogRow, key: string): string {
  return row.args[key] as string;
}