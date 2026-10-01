import type { RunwayPublicClient } from './chain.js';

/**
 * Block timestamps.
 *
 * Arc testnet produces a block roughly every 510 seconds, so a block number says
 * almost nothing about when something happened. A date needs the block's
 * timestamp.
 *
 * A block is immutable, so its timestamp never changes. That makes this cache
 * permanent rather than TTL'd: each block is fetched once for the life of the
 * process and never again. Without it a status read would add one RPC call per
 * event, on an endpoint that already rate-limits us.
 */

const cache = new Map<number, number>();

const MAX_CONCURRENT = 6;

async function fetchBlockTime(client: RunwayPublicClient, blockNumber: number): Promise<number> {
  const cached = cache.get(blockNumber);
  if (cached !== undefined) return cached;

  const block = await client.getBlock({ blockNumber: BigInt(blockNumber) });
  const seconds = Number(block.timestamp);
  cache.set(blockNumber, seconds);
  return seconds;
}

export type BlockTimeResult = {
  times: Map<number, number>;
  /** Distinct blocks asked about. */
  requested: number;
  /** Served from cache without an RPC call. */
  fromCache: number;
  /** Actually fetched this read. */
  fetched: number;
  /** Lookups that failed; those rows render as no timestamp. */
  failed: number;
};

/**
 * Resolve timestamps for a set of blocks, in parallel but bounded.
 *
 * Failures resolve to undefined rather than throwing: a missing timestamp on one
 * row must not cost the reader the whole page, and a status read that throws
 * degrades to stale cache, which reads as "no activity".
 *
 * The counts are reported because "resolved: 0" and "resolved: 6 of 6, all
 * cached" mean very different things when reading the payload.
 */
export async function blockTimes(
  client: RunwayPublicClient,
  blockNumbers: readonly number[],
): Promise<BlockTimeResult> {
  const unique = [...new Set(blockNumbers)];
  const todo = unique.filter((n) => !cache.has(n));

  const times = new Map<number, number>();
  for (const n of unique) {
    const hit = cache.get(n);
    if (hit !== undefined) times.set(n, hit);
  }

  let failed = 0;
  for (let i = 0; i < todo.length; i += MAX_CONCURRENT) {
    const batch = todo.slice(i, i + MAX_CONCURRENT);
    const settled = await Promise.all(
      batch.map((n) => fetchBlockTime(client, n).catch(() => undefined)),
    );
    settled.forEach((seconds, index) => {
      if (seconds === undefined) failed += 1;
      else times.set(batch[index], seconds);
    });
  }

  return {
    times,
    requested: unique.length,
    fromCache: unique.length - todo.length,
    fetched: todo.length - failed,
    failed,
  };
}

/** Seconds since epoch for a block, or undefined when it could not be read. */
export async function blockTime(
  client: RunwayPublicClient,
  blockNumber: number,
): Promise<number | undefined> {
  const known = cache.get(blockNumber);
  if (known !== undefined) return known;
  return fetchBlockTime(client, blockNumber).catch(() => undefined);
}

/**
 * ISO 8601 with a `Z`, so the browser parses it without guessing a zone.
 *
 * viem's `date` is an ISO string already; prefer it when present because it is
 * what the node reported, and fall back to formatting the seconds ourselves.
 */
export function isoTime(seconds: number | undefined): string | null {
  if (seconds === undefined || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}