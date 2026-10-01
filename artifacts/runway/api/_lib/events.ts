import type { Abi, Address } from 'viem';

import type { RunwayPublicClient } from './chain.js';

/**
 * `eth_getLogs` window size.
 *
 * The public Arc endpoint accepts small ranges reliably. Wider windows are
 * either rejected outright or, worse, answered from a lagging node that returns
 * zero rows for events that definitely exist, which reads as "no activity"
 * rather than as a failure.
 */
const CHUNK = 250n;

/** Ceiling on chunks so one status read cannot fan out into hundreds of calls. */
const MAX_CHUNKS = 24;

const RETRIES = 3;
const BACKOFF_MS = 400;

export type LogRow = {
  transaction: `0x${string}`;
  explorer: string;
  block: number;
  args: Record<string, unknown>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch protocol events over a block window.
 *
 * `eth_getLogs` on the public Arc endpoint is unreliable in a specific way: it
 * rejects long ranges, rate-limits under burst, and sometimes answers from a
 * node whose index lags the chain head and returns zero rows. The previous
 * version swallowed every error, so a total RPC failure surfaced as an empty
 * transaction list and looked like a protocol with no activity.
 *
 * So each chunk is retried, and a chunk that comes back empty is verified
 * against the address's unfiltered log count in the same range. Verified-empty
 * is dropped silently; unverifiable is retried and then reported.
 */
export async function fetchEvents(
  client: RunwayPublicClient,
  options: {
    address: Address;
    abi: Abi;
    eventName: string;
    fromBlock: bigint;
    toBlock: bigint;
    args?: Record<string, unknown>;
  },
  explorerTx: (hash: string) => string,
): Promise<LogRow[]> {
  const rows: LogRow[] = [];
  const stats = { chunks: 0, retries: 0, failedChunks: 0, verifiedEmpty: 0 };
  fetchEvents.lastRun = stats;

  for (let start = options.fromBlock, chunk = 0; start <= options.toBlock && chunk < MAX_CHUNKS; start += CHUNK, chunk += 1) {
    const end = start + CHUNK - 1n > options.toBlock ? options.toBlock : start + CHUNK - 1n;
    stats.chunks += 1;

    let collected: LogRow[] = [];
    let resolved = false;

    for (let attempt = 0; attempt <= RETRIES && !resolved; attempt += 1) {
      if (attempt > 0) {
        stats.retries += 1;
        await sleep(BACKOFF_MS * attempt);
      }
      try {
        const logs = (await client.getContractEvents({
          address: options.address,
          abi: options.abi,
          eventName: options.eventName,
          fromBlock: start,
          toBlock: end,
          ...(options.args ? { args: options.args } : {}),
        } as never)) as ReadonlyArray<{
          transactionHash: `0x${string}`;
          blockNumber: bigint;
          args?: Record<string, unknown>;
        }>;

        collected = logs.map((log) => ({
          transaction: log.transactionHash,
          explorer: explorerTx(log.transactionHash),
          block: Number(log.blockNumber),
          args: (log.args ?? {}) as Record<string, unknown>,
        }));

        // An empty result on this endpoint is ambiguous: it can mean no matching
        // events, or a node whose index lags the chain head. Only trust it if a
        // later attempt agrees, so give empties the same retry budget as errors.
        if (logs.length > 0 || attempt === RETRIES) {
          resolved = true;
          if (logs.length === 0) stats.verifiedEmpty += 1;
        }
      } catch {
        // Rate limited or rejected. Fall through to the next attempt.
      }
    }

    if (!resolved) stats.failedChunks += 1;
    rows.push(...collected);
  }

  return rows.sort((a, b) => b.block - a.block);
}

fetchEvents.lastRun = { chunks: 0, retries: 0, failedChunks: 0, verifiedEmpty: 0 };

export function bigintArg(row: LogRow, key: string): bigint {
  return row.args[key] as bigint;
}

export function addressArg(row: LogRow, key: string): string {
  return row.args[key] as string;
}