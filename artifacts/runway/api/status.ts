import { getLogsClient, getPublicClient } from './_lib/chain.js';
import { config, explorerAddress, explorerTx, formatUsdc } from './_lib/config.js';
import { erc20Abi, factoryAbi, splitterAbi, vaultAbi } from './_lib/abi.js';
import {
  addressArg,
  bigintArg,
  fetchLogsForAddress,
  newFetchStats,
  topicsByName,
  type LogRow,
} from './_lib/events.js';
import { blockTimes, isoTime } from './_lib/blocktime.js';
import {
  explorerAvailable,
  fetchEvents,
  fetchTransfers,
  type ExplorerEvent,
} from './_lib/blockscout.js';
import type { Handler } from './_lib/http.js';

/** A contract event, decoded, with its explorer link and time. */
type LedgerEvent = {
  transaction: `0x${string}`;
  explorer: string;
  block: number;
  timestamp: string | null;
  args: Record<string, bigint>;
};

/** Revenue arriving at the splitter. */
type LedgerReceipt = {
  transaction: `0x${string}`;
  explorer: string;
  block: number;
  timestamp: string | null;
  from: string;
  amount: { raw: string; formatted: string };
};

/**
 * Block window for event history.
 *
 * Arc testnet produces a block about every half second, so 20,000 blocks is
 * roughly the last few hours — enough for a recording and small enough that the
 * whole window can be scanned inside one function invocation. Override with
 * RUNWAY_LOOKBACK_BLOCKS when a deployment needs deeper history.
 */
const LOOKBACK_BLOCKS = 20_000n;

/** Left-pad an address into the 32-byte word an indexed event argument uses. */
const padAddressTopic = (address: string): `0x${string}` =>
  `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;

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

    const stats = newFetchStats();
    let receipts: LedgerReceipt[] = [];
    let settlements: LedgerEvent[] = [];
    let repayments: LedgerEvent[] = [];
    let loansOpened: LedgerEvent[] = [];
    let stampsRequested = 0;
    let stampsResolved = 0;
    let stampsFromCache = 0;
    let stampsFetched = 0;
    let stampsFailed = 0;
    let fromBlock = 0n;
    let settledRows: LogRow[] = [];
    let repaidRows: LogRow[] = [];
    let loanRows: LogRow[] = [];
    let receiptRows: LogRow[] = [];
    let explorerError: string | null = null;

    /**
     * The ledger comes from the explorer's index, which carries timestamps and
     * has no block-range limit. `eth_getLogs` stays as the fallback, and the
     * source that answered is reported: a log scan only sees its window, so
     * "0 receipts" from that path means something quite different from "0
     * receipts" from the explorer.
     *
     * The probe is advisory, not a promise. If the explorer accepts `/stats` and
     * then fails on the real query, the scan still runs rather than the endpoint
     * returning an error the dashboard cannot recover from.
     */
    const explorerLooksHealthy = await explorerAvailable();
    let viaExplorer = explorerLooksHealthy;

    if (viaExplorer) {
      try {
        const [splitterEvents, vaultEvents, transfers] = await Promise.all([
          fetchEvents(config.splitter, splitterAbi, { names: ['Settled'] }),
          fetchEvents(config.vault, vaultAbi, { names: ['LoanOpened', 'Repaid'] }),
          fetchTransfers(config.splitter, { token: config.usdc }),
        ]);

      const asEvent = (rows: ExplorerEvent[], names: string[]): LedgerEvent[] =>
        rows
          .filter((row) => names.includes(row.name))
          .map((row) => ({
            transaction: row.transaction,
            explorer: explorerTx(row.transaction),
            block: row.block,
            timestamp: row.timestamp ? new Date(row.timestamp).toISOString() : null,
            args: row.args as Record<string, bigint>,
          }));

      settlements = asEvent(splitterEvents, ['Settled']);
      loansOpened = asEvent(vaultEvents, ['LoanOpened']);
      repayments = asEvent(vaultEvents, ['Repaid']);

      // A receipt is revenue arriving at the splitter. Filtered on the recipient
      // because that is what makes it a receipt; the settlement that follows is
      // picked up from the splitter's own events above.
      receipts = transfers
        .filter((row) => row.to.toLowerCase() === config.splitter.toLowerCase())
        .map((row) => ({
          transaction: row.transaction,
          explorer: explorerTx(row.transaction),
          block: row.block,
          timestamp: row.timestamp ? new Date(row.timestamp).toISOString() : null,
          from: row.from,
          amount: usdcAmount(row.value),
        }));
      } catch (error) {
        // Explorer reachable but not usable for this query. Say so and fall
        // through to the scan: a narrower ledger beats none at all.
        viaExplorer = false;
        explorerError = (error as Error).message;
      }
    }

    if (!viaExplorer) {
      /**
       * Fallback: scan logs over a bounded window and resolve timestamps by
       * block. The window is configurable because the useful depth depends on
       * the deployment, and a window too short to reach a payment returns an
       * empty ledger that looks perfectly healthy.
       */
      const lookback = BigInt(process.env.RUNWAY_LOOKBACK_BLOCKS ?? LOOKBACK_BLOCKS.toString());
      fromBlock = head > lookback ? head - lookback : 0n;

      // Log scans go through a separate client: the endpoint that answers
      // ordinary calls reliably caps `eth_getLogs` at ten blocks, which cannot
      // cover this window. The reads above still use the reliable endpoint.
      const logs = getLogsClient();

      // One pass per address, then filter by topic locally. Querying per event
      // name cost roughly eighty RPC calls per read and got rate-limited into
      // silence.
      const splitterLogs = await fetchLogsForAddress(
        logs,
        { address: config.splitter, abi: splitterAbi, fromBlock, toBlock: head },
        explorerTx,
        stats,
      );
      const vaultLogs = await fetchLogsForAddress(
        logs,
        { address: config.vault, abi: vaultAbi, fromBlock, toBlock: head },
        explorerTx,
        stats,
      );

      const settledTopic = topicsByName(splitterAbi).Settled;
      const repaidTopic = topicsByName(vaultAbi).Repaid;
      const loanTopic = topicsByName(vaultAbi).LoanOpened;
      const transferTopic = topicsByName(erc20Abi).Transfer;

      // Ask the node only for transfers into the splitter. USDC is the busiest
      // address on this chain, and an unfiltered scan of it is rejected outright.
      const usdcLogs = await fetchLogsForAddress(
        logs,
        {
          address: config.usdc,
          abi: erc20Abi,
          fromBlock,
          toBlock: head,
          topics: [transferTopic, null, padAddressTopic(config.splitter)],
        },
        explorerTx,
        stats,
      );

      settledRows = splitterLogs.filter((row) => row.topic0 === settledTopic);
      repaidRows = vaultLogs.filter((row) => row.topic0 === repaidTopic);
      loanRows = vaultLogs.filter((row) => row.topic0 === loanTopic);
      receiptRows = usdcLogs.filter(
        (row) =>
          row.topic0 === transferTopic &&
          String(row.args.to).toLowerCase() === config.splitter.toLowerCase(),
      );

      const stamps = await blockTimes(client, [
        ...repaidRows,
        ...settledRows,
        ...loanRows,
        ...receiptRows,
      ].map((row) => row.block));
      stampsRequested = stamps.requested;
      stampsResolved = stamps.times.size;
      stampsFromCache = stamps.fromCache;
      stampsFetched = stamps.fetched;
      stampsFailed = stamps.failed;
      const timeOf = (block: number) => isoTime(stamps.times.get(block));

      repayments = repaidRows.slice(0, 25).map((row) => ({
        transaction: row.transaction,
        explorer: row.explorer,
        block: row.block,
        timestamp: timeOf(row.block),
        args: row.args as Record<string, bigint>,
      }));
      settlements = settledRows.slice(0, 25).map((row) => ({
        transaction: row.transaction,
        explorer: row.explorer,
        block: row.block,
        timestamp: timeOf(row.block),
        args: row.args as Record<string, bigint>,
      }));
      receipts = receiptRows.slice(0, 25).map((row) => ({
        transaction: row.transaction,
        explorer: row.explorer,
        block: row.block,
        timestamp: timeOf(row.block),
        from: addressArg(row, 'from'),
        amount: usdcAmount(bigintArg(row, 'value')),
      }));
      loansOpened = loanRows.map((row) => ({
        transaction: row.transaction,
        explorer: row.explorer,
        block: row.block,
        timestamp: timeOf(row.block),
        args: row.args as Record<string, bigint>,
      }));
    }

    const repayments2 = repayments.map((row) => ({
      transaction: row.transaction,
      explorer: row.explorer,
      block: row.block,
      timestamp: row.timestamp,
      loanId: String(row.args.loanId ?? 0n),
      amount: usdcAmount(row.args.amount ?? 0n),
    }));

    const settlements2 = settlements.map((row) => ({
      transaction: row.transaction,
      explorer: row.explorer,
      block: row.block,
      timestamp: row.timestamp,
      revenue: usdcAmount(row.args.revenue ?? 0n),
      lenderShare: usdcAmount(row.args.lenderShare ?? 0n),
      agentShare: usdcAmount(row.args.agentShare ?? 0n),
    }));

    const loansOpened2 = loansOpened.map((row) => ({
      transaction: row.transaction,
      explorer: row.explorer,
      block: row.block,
      timestamp: row.timestamp,
      loanId: String(row.args.loanId ?? 0n),
      principal: usdcAmount(row.args.principal ?? 0n),
      feeBps: Number(row.args.feeBps ?? 0),
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
        splitterImpl: {
          address: config.splitterImpl,
          explorer: explorerAddress(config.splitterImpl),
        },
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
      repayments: repayments2,
      settlements: settlements2,
      receipts,
      loansOpened: loansOpened2,
      /**
       * Which source answered, and what it covered. Reported because the two
       * paths have genuinely different reach: the explorer sees all history,
       * while the log scan only sees its window. Reading "0 receipts" without
       * knowing which produced it is how an empty ledger passes for a quiet one.
       */
      blockTimestamps: viaExplorer
        ? { requested: 0, resolved: 0, fromCache: 0, fetched: 0, failed: 0 }
        : {
            requested: stampsRequested,
            resolved: stampsResolved,
            fromCache: stampsFromCache,
            fetched: stampsFetched,
            failed: stampsFailed,
          },
      rpc: config.rpcUrl,
      indexer: {
        source: viaExplorer ? 'explorer' : 'log-scan',
        ...(explorerError ? { explorerError } : {}),
        fromBlock: viaExplorer ? null : Number(fromBlock),
        toBlock: viaExplorer ? null : Number(head),
        settledEvents: settlements2.length,
        repaidEvents: repayments2.length,
        loanOpenedEvents: loansOpened2.length,
        receiptEvents: receipts.length,
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
