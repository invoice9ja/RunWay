import { decodeEventLog, toEventSelector, type Abi, type AbiEvent } from 'viem';

import type { RunwayPublicClient } from './chain.js';

/**
  * Block window per `eth_getLogs` request.
  *
  * Sized to the widest range the log endpoint actually serves. It now rejects
  * anything beyond roughly 5,000 blocks with "requested range too large", so the
  * old 10,000-block chunk never came back and every read spent its retries
  * before failing.
  */
const CHUNK = 5_000n;


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
/**
 * The public Arc endpoint rate-limits under a burst of wide-range reads, and
 * doing three of them back to back is reliably enough to trip it. Two retries at
 * 400ms was not enough to ride it out, which is why every read reported
 * retries and some chunks failed.
 */
const RETRIES = 4;
const BACKOFF_MS = 700;

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
    /**
     * Topic filter pushed to the node.
     *
     * Filtering here rather than only after decoding is what makes USDC
     * affordable: an unfiltered window on that token returns tens of thousands
     * of transfers, which the endpoint refuses. Asking only for transfers *to*
     * one address keeps the response to a handful of rows per chunk.
     */
    topics?: (`0x${string}` | null)[];
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
        // Jitter: without it every failing chunk retries on the same schedule
        // and the retries keep the limiter down rather than letting it recover.
        const jitter = Math.floor(Math.random() * BACKOFF_MS);
        await sleep(BACKOFF_MS * attempt + jitter);
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
              ...(options.topics ? { topics: options.topics } : {}),
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