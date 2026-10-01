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

/**
 * Resolve timestamps for a set of blocks, in parallel but bounded.
 *
 * Failures resolve to undefined rather than throwing: a missing timestamp on one
 * row must not cost the reader the whole page, and a status read that throws
 * degrades to stale cache, which reads as "no activity".
 */
export async function blockTimes(
  client: RunwayPublicClient,
  blockNumbers: readonly number[],
): Promise<Map<number, number>> {
  const unique = [...new Set(blockNumbers)].filter((n) => !cache.has(n));
  const out = new Map<number, number>([...cache].filter(([k]) => blockNumbers.includes(k)));

  for (let i = 0; i < unique.length; i += MAX_CONCURRENT) {
    const batch = unique.slice(i, i + MAX_CONCURRENT);
    const settled = await Promise.all(
      batch.map((n) => fetchBlockTime(client, n).catch(() => undefined)),
    );
    settled.forEach((seconds, index) => {
      if (seconds !== undefined) out.set(batch[index], seconds);
    });
  }

  return out;
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