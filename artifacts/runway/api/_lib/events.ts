import type { Abi, Address } from 'viem';

import type { RunwayPublicClient } from './chain.js';

const CHUNK = 900n;
const MAX_CHUNKS = 12;

export type LogRow = {
  transaction: `0x${string}`;
  explorer: string;
  block: number;
  args: Record<string, unknown>;
};

/**
 * `eth_getLogs` on the public Base Sepolia RPC is capped at a 1,000 block range,
 * so walk the window in chunks. A failing window degrades to a skip rather than
 * taking the whole status response down.
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

  for (let start = options.fromBlock, chunk = 0; start <= options.toBlock && chunk < MAX_CHUNKS; start += CHUNK, chunk += 1) {
    const end = start + CHUNK - 1n > options.toBlock ? options.toBlock : start + CHUNK - 1n;
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

      for (const log of logs) {
        rows.push({
          transaction: log.transactionHash,
          explorer: explorerTx(log.transactionHash),
          block: Number(log.blockNumber),
          args: (log.args ?? {}) as Record<string, unknown>,
        });
      }
    } catch {
      // Skip this window; the dashboard still renders the rest.
    }
  }

  return rows.sort((a, b) => b.block - a.block);
}

export function bigintArg(row: LogRow, key: string): bigint {
  return row.args[key] as bigint;
}

export function addressArg(row: LogRow, key: string): string {
  return row.args[key] as string;
}
