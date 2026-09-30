import { getPublicClient, requireWalletClient } from './_lib/chain.js';
import { config, explorerTx, formatUsdc, isAuthorized } from './_lib/config.js';
import { erc20Abi, factoryAbi, splitterAbi } from './_lib/abi.js';
import type { Handler } from './_lib/http.js';

const AUTO_COOLDOWN_MS = 15_000;
let lastAutoRun = 0;

/**
 * Hosted keeper.
 *
 * Reads every splitter registered on the factory, and when unsettled revenue
 * reaches the threshold, calls `settle()` which splits the receipt into the
 * lender share (repaid to the vault first) and the agent share.
 *
 * Guarded by `RUNWAY_KEEPER_SECRET` (or `CRON_SECRET` for Vercel Cron) so it
 * cannot be triggered by arbitrary callers.
 */
const handler: Handler = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const client = getPublicClient();
  const wallet = await requireWalletClient();
  const query = (key: string) => (Array.isArray(req.query[key]) ? req.query[key][0] : req.query[key]);
  const authorized = isAuthorized(req);
  const auto = query('auto') === '1';
  const force = authorized && query('force') === '1';

  /**
   * Vercel Hobby only allows daily crons, so the dashboard keeps the keeper
   * warm with `?auto=1`. That path may only settle revenue that is already
   * above the threshold and is rate limited per warm instance. Anything beyond
   * that still needs the keeper secret.
   */
  if (!authorized) {
    if (!auto) {
      res.status(401).json({ error: 'Unauthorized. Provide the keeper secret.' });
      return;
    }
    const since = Date.now() - lastAutoRun;
    if (since < AUTO_COOLDOWN_MS) {
      res.status(429).json({
        error: 'Keeper already ran recently.',
        retryAfterMs: AUTO_COOLDOWN_MS - since,
      });
      return;
    }
    lastAutoRun = Date.now();
  }

  const splitters = await client.readContract({
    address: config.factory,
    abi: factoryAbi,
    functionName: 'getAllSplitters',
  });

  const results = [];

  for (const splitter of splitters) {
    try {
      const [unsettled, balance, agent, lastSettled] = await Promise.all([
        client.readContract({ address: splitter, abi: splitterAbi, functionName: 'getUnsettledRevenue' }),
        client.readContract({
          address: config.usdc,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [splitter],
        }),
        client.readContract({ address: splitter, abi: splitterAbi, functionName: 'agent' }),
        client.readContract({ address: splitter, abi: splitterAbi, functionName: 'lastSettledBalance' }),
      ]);

      const shouldSettle = unsettled > 0n && (force || unsettled >= config.settleThreshold);
      const entry: Record<string, unknown> = {
        splitter,
        agent,
        settledBalance: lastSettled.toString(),
        balance: balance.toString(),
        unsettled: unsettled.toString(),
        unsettledFormatted: formatUsdc(unsettled),
        threshold: config.settleThreshold.toString(),
        action: shouldSettle ? 'settling' : 'skipped',
      };

      if (shouldSettle) {
        const hash = await wallet.writeContract({
          address: splitter,
          abi: splitterAbi,
          functionName: 'settle',
        });
        const receipt = await client.waitForTransactionReceipt({ hash });
        entry.action = 'settled';
        entry.transaction = hash;
        entry.explorer = explorerTx(hash);
        entry.block = receipt.blockNumber.toString();
        entry.gasUsed = receipt.gasUsed.toString();
      } else if (unsettled === 0n) {
        entry.reason = 'nothing unsettled';
      } else {
        entry.reason = 'below threshold';
      }

      results.push(entry);
    } catch (error) {
      results.push({
        splitter,
        action: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  res.status(200).json({
    network: config.network,
    factory: config.factory,
    vault: config.vault,
    threshold: config.settleThreshold.toString(),
    thresholdFormatted: formatUsdc(config.settleThreshold),
    splittersScanned: results.length,
    settled: results.filter((r) => r.action === 'settled').length,
    results,
  });
};

export default handler;
