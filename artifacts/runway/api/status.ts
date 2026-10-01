import { getPublicClient } from './_lib/chain.js';
import { config, explorerAddress, explorerTx, formatUsdc } from './_lib/config.js';
import { erc20Abi, factoryAbi, splitterAbi, vaultAbi } from './_lib/abi.js';
import {
  addressArg,
  bigintArg,
  fetchLogsForAddress,
  newFetchStats,
  topicsByName,
} from './_lib/events.js';
import type { Handler } from './_lib/http.js';

/**
 * Block window for event history.
 *
 * Sized to reach this deployment's real activity. Arc testnet blocks about every
 * 510s, and the three loan cycles plus the x402 payments sit a few thousand blocks
 * back, so a short window returns an empty dashboard that looks perfectly healthy.
 * `fetchLogsForAddress` chunks the range and retries, which is how the endpoint's
 * unreliability is handled; the window itself only needs to be long enough.
 */
const LOOKBACK_BLOCKS = 20_000n;

/**
 * Each read costs roughly twenty RPC calls, and the public Base Sepolia endpoint
 * rate-limits under a burst. Serve a short-lived cache, and if a refresh fails,
 * fall back to the last good payload so the dashboard degrades instead of
 * breaking.
 */
const CACHE_TTL_MS = 10_000;
const STALE_TTL_MS = 300_000;

type CacheEntry = { at: number; body: Record<string, unknown> };
const cache = new Map<string, CacheEntry>();

const usdcAmount = (value: bigint) => ({
  raw: value.toString(),
  formatted: formatUsdc(value),
});

/** Read-only endpoint that powers the dashboard with real Base Sepolia state. */
const handler: Handler = async (_req, res) => {
  const key = 'status';
  const cached = cache.get(key);
  const age = cached ? Date.now() - cached.at : Infinity;

  if (cached && age < CACHE_TTL_MS) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Runway-Cache', 'hit');
    res.status(200).json(cached.body);
    return;
  }

  const client = getPublicClient();

  try {
    const head = await client.getBlockNumber();

    const [splitters, vaultBalance, totalOutstanding, loansLength, globalMax, starterCap, feeBps, shareBps] =
      await Promise.all([
        client.readContract({ address: config.factory, abi: factoryAbi, functionName: 'getAllSplitters' }),
        client.readContract({ address: config.vault, abi: vaultAbi, functionName: 'getBalance' }),
        client.readContract({ address: config.vault, abi: vaultAbi, functionName: 'getTotalOutstanding' }),
        client.readContract({ address: config.vault, abi: vaultAbi, functionName: 'getLoansLength' }),
        client.readContract({ address: config.vault, abi: vaultAbi, functionName: 'GLOBAL_MAX' }),
        client.readContract({ address: config.vault, abi: vaultAbi, functionName: 'STARTER_CAP' }),
        client.readContract({ address: config.vault, abi: vaultAbi, functionName: 'FEE_BPS_DEFAULT' }),
        client.readContract({ address: config.vault, abi: vaultAbi, functionName: 'SHARE_BPS_DEFAULT' }),
      ]);

    const splitterRows = await Promise.all(
      splitters.map(async (address) => {
        const [agent, payout, share, claimable, lastSettled, lifetime, loanActive, unsettled, tokenBalance] =
          await Promise.all([
            client.readContract({ address, abi: splitterAbi, functionName: 'agent' }),
            client.readContract({ address, abi: splitterAbi, functionName: 'payout' }),
            client.readContract({ address, abi: splitterAbi, functionName: 'shareBps' }),
            client.readContract({ address, abi: splitterAbi, functionName: 'agentClaimable' }),
            client.readContract({ address, abi: splitterAbi, functionName: 'lastSettledBalance' }),
            client.readContract({ address, abi: splitterAbi, functionName: 'lifetimeRevenue' }),
            client.readContract({ address, abi: splitterAbi, functionName: 'loanActive' }),
            client.readContract({ address, abi: splitterAbi, functionName: 'getUnsettledRevenue' }),
            client.readContract({ address: config.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
          ]);

        return {
          address,
          explorer: explorerAddress(address),
          agent,
          payout,
          lenderShareBps: Number(share),
          agentClaimable: usdcAmount(claimable),
          unsettled: usdcAmount(unsettled),
          tokenBalance: usdcAmount(tokenBalance),
          lastSettledBalance: usdcAmount(lastSettled),
          lifetimeRevenue: usdcAmount(lifetime),
          loanActive,
        };
      }),
    );

    const loans = await Promise.all(
      Array.from({ length: Number(loansLength) }, async (_, index) => {
        const loanId = BigInt(index);
        const loan = await client.readContract({
          address: config.vault,
          abi: vaultAbi,
          functionName: 'getLoan',
          args: [loanId],
        });
        const outstanding = loan.principal - loan.repaid;
        return {
          loanId: loanId.toString(),
          splitter: loan.splitter,
          splitterExplorer: explorerAddress(loan.splitter),
          principal: usdcAmount(loan.principal),
          repaid: usdcAmount(loan.repaid),
          outstanding: usdcAmount(outstanding > 0n ? outstanding : 0n),
          progressBps:
            loan.principal > 0n ? Number((loan.repaid * 10000n) / loan.principal) : 0,
          feeBps: Number(loan.feeBps),
          lenderShareBps: Number(loan.shareBps),
          dueDate: Number(loan.dueDate),
          delinquent: loan.delinquent,
          flagged: loan.flagged,
          active: loan.active,
        };
      }),
    );

    /**
     * The window is sized to cover real history rather than to be safe: Arc testnet
     * blocks about every 510s, so the loans and settlements in this deployment sit
     * a few thousand blocks back. A window too short to reach them shows an empty
     * dashboard that looks correct, which is the failure worth avoiding. Chunking
     * and retries handle the endpoint's unreliability instead.
     */
    const fromBlock = head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;

    // One pass per address, then filter by topic locally. Querying per event name
    // cost roughly eighty RPC calls per read and got rate-limited into silence.
    const stats = newFetchStats();
    // Sequential rather than concurrent: three simultaneous wide-range reads trip
    // the public endpoint's rate limiter, which then fails the chunks it should
    // have served.
    const splitterLogs = await fetchLogsForAddress(
      client,
      { address: config.splitter, abi: splitterAbi, fromBlock, toBlock: head },
      explorerTx,
      stats,
    );
    const vaultLogs = await fetchLogsForAddress(
      client,
      { address: config.vault, abi: vaultAbi, fromBlock, toBlock: head },
      explorerTx,
      stats,
    );
    const usdcLogs = await fetchLogsForAddress(
      client,
      { address: config.usdc, abi: erc20Abi, fromBlock, toBlock: head, chunk: 3_000n },
      explorerTx,
      stats,
    );

    const settledTopic = topicsByName(splitterAbi).Settled;
    const repaidTopic = topicsByName(vaultAbi).Repaid;
    const loanTopic = topicsByName(vaultAbi).LoanOpened;
    const transferTopic = topicsByName(erc20Abi).Transfer;

    const settledRows = splitterLogs.filter((row) => row.topic0 === settledTopic);
    const repaidRows = vaultLogs.filter((row) => row.topic0 === repaidTopic);
    const loanRows = vaultLogs.filter((row) => row.topic0 === loanTopic);
    const receiptRows = usdcLogs.filter(
      (row) => row.topic0 === transferTopic && String(row.args.to).toLowerCase() === config.splitter.toLowerCase(),
    );

    const repayments = repaidRows.slice(0, 25).map((row) => ({
      transaction: row.transaction,
      explorer: row.explorer,
      block: row.block,
      loanId: bigintArg(row, 'loanId').toString(),
      amount: usdcAmount(bigintArg(row, 'amount')),
    }));

    const settlements = settledRows.slice(0, 25).map((row) => ({
      transaction: row.transaction,
      explorer: row.explorer,
      block: row.block,
      revenue: usdcAmount(bigintArg(row, 'revenue')),
      lenderShare: usdcAmount(bigintArg(row, 'lenderShare')),
      agentShare: usdcAmount(bigintArg(row, 'agentShare')),
    }));

    const receipts = receiptRows.slice(0, 25).map((row) => ({
      transaction: row.transaction,
      explorer: row.explorer,
      block: row.block,
      from: addressArg(row, 'from'),
      amount: usdcAmount(bigintArg(row, 'value')),
    }));

    const loansOpened = loanRows.map((row) => ({
      transaction: row.transaction,
      explorer: row.explorer,
      block: row.block,
      loanId: bigintArg(row, 'loanId').toString(),
      principal: usdcAmount(bigintArg(row, 'principal')),
      feeBps: Number(bigintArg(row, 'feeBps')),
    }));

    const payload = {
      network: config.network,
      chainId: config.chainId,
      block: Number(head),
      readAt: new Date().toISOString(),
      contracts: {
        vault: { address: config.vault, explorer: explorerAddress(config.vault) },
        factory: { address: config.factory, explorer: explorerAddress(config.factory) },
        splitter: { address: config.splitter, explorer: explorerAddress(config.splitter) },
        usdc: { address: config.usdc, explorer: explorerAddress(config.usdc) },
      },
      protocol: {
        vaultBalance: usdcAmount(vaultBalance),
        totalOutstanding: usdcAmount(totalOutstanding),
        globalMax: usdcAmount(globalMax),
        starterCap: usdcAmount(starterCap),
        feeBpsDefault: Number(feeBps),
        lenderShareBpsDefault: Number(shareBps),
        settleThreshold: usdcAmount(config.settleThreshold),
      },
      summary: {
        splitters: splitterRows.length,
        loans: loans.length,
        openLoans: loans.filter((loan) => loan.active).length,
        repaidLoans: loans.filter((loan) => !loan.active).length,
        lifetimeRevenue: usdcAmount(
          splitterRows.reduce((total, row) => total + BigInt(row.lifetimeRevenue.raw), 0n),
        ),
        unsettled: usdcAmount(
          splitterRows.reduce((total, row) => total + BigInt(row.unsettled.raw), 0n),
        ),
        sellerReceipts: usdcAmount(
          receipts.reduce((total, entry) => total + BigInt(entry.amount.raw), 0n),
        ),
      },
      splitters: splitterRows,
      loans,
      repayments,
      settlements,
      receipts,
      loansOpened,
      rpc: config.rpcUrl,
      indexer: {
        fromBlock: Number(fromBlock),
        toBlock: Number(head),
        settledEvents: settledRows.length,
        repaidEvents: repaidRows.length,
        loanOpenedEvents: loanRows.length,
        receiptEvents: receiptRows.length,
        ...stats,
      },
    };
    cache.set(key, { at: Date.now(), body: payload });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Runway-Cache', 'miss');
    res.status(200).json(payload);
  } catch (error) {
    // Serve the last good read rather than breaking the dashboard, but say so:
    // the previous version returned this silently and it read as "no activity".
    if (cached && age < STALE_TTL_MS) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Runway-Cache', 'stale');
      res.status(200).json({
        ...cached.body,
        degraded: true,
        degradedReason: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    res.status(502).json({
      error: error instanceof Error ? error.message : String(error),
      hint: 'The dashboard could not complete its Arc testnet reads.',
    });
  }
};

export default handler;
