import { getPublicClient, getAccount, requireWalletClient } from '../_lib/chain.js';
import { config, explorerTx, formatUsdc, isAuthorized } from '../_lib/config.js';
import { erc20Abi, splitterAbi, vaultAbi } from '../_lib/abi.js';
import type { Handler } from '../_lib/http.js';

/**
 * Individual protocol tests, callable one at a time from the dashboard.
 *
 * Each entry is a self-contained check with an explicit expected outcome. Reads
 * are free. Anything that sends a transaction is marked `costly` and is refused
 * without the keeper secret, so an unauthenticated visitor can run the read-only
 * suite but cannot drain the operational wallet.
 */

const amount = (value: bigint) => ({ raw: value.toString(), formatted: formatUsdc(value) });

type TestId =
  | 'splitter-balance'
  | 'surplus'
  | 'claim-backed'
  | 'vault-conservation'
  | 'debt-matches-loans'
  | 'unsettled-equals-surplus'
  | 'withdraw-claim'
  | 'reject-unregistered-splitter'
  | 'reject-oversized-advance';

type Entry = {
  id: TestId;
  title: string;
  description: string;
  costly: boolean;
  expect: string;
  run: () => Promise<{ ok: boolean; detail: string; data?: unknown }>;
};

const readSplitter = <T>(name: string) =>
  getPublicClient().readContract({
    address: config.splitter,
    abi: splitterAbi,
    functionName: name,
  } as never) as Promise<T>;

const entry = (
  id: TestId,
  title: string,
  description: string,
  costly: boolean,
  expect: string,
  run: Entry['run'],
): Entry => ({ id, title, description, costly, expect, run });

/**
 * A revert is only a pass if it names the condition under test.
 *
 * Without this the negative tests reported PASS while actually failing for an
 * unrelated reason, such as the ABI not containing the function at all. A test
 * that cannot fail is worse than no test, so the expected reason has to appear
 * in the revert string.
 */
async function expectRevert(
  label: string,
  expectReason: RegExp,
  action: () => Promise<unknown>,
) {
  try {
    await action();
    return { ok: false, detail: `${label} was ACCEPTED but should have reverted` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found on ABI|does not exist|Unknown function/i.test(message)) {
      return {
        ok: false,
        detail: `false pass: the call never reached the contract (${message.split('\n')[0].slice(0, 90)})`,
      };
    }
    if (!expectReason.test(message)) {
      return {
        ok: false,
        detail: `reverted, but not for the reason under test. Expected ${expectReason}, got: ${message.split('\n')[0].slice(0, 110)}`,
      };
    }
    const matched = message.match(expectReason)?.[0];
    return { ok: true, detail: `reverted as expected: ${matched}` };
  }
}

const tests: Entry[] = [
  entry(
    'splitter-balance',
    'Splitter holds what it should',
    'Reads the live USDC balance of the RevenueSplitter.',
    false,
    'any non-negative value',
    async () => {
      const balance = await readSplitter<bigint>('getBalance');
      return { ok: balance >= 0n, detail: `${formatUsdc(balance)} USDC held`, data: amount(balance) };
    },
  ),
  entry(
    'surplus',
    'No tokens are stranded',
    'surplus() is USDC held that belongs to neither the agent nor working capital. It must be zero.',
    false,
    '0',
    async () => {
      const surplus = await readSplitter<bigint>('surplus');
      return {
        ok: surplus === 0n,
        detail: surplus === 0n ? 'no stranded USDC' : `${formatUsdc(surplus)} USDC stranded`,
        data: amount(surplus),
      };
    },
  ),
  entry(
    'claim-backed',
    'Agent claim is backed by tokens',
    'The agent cannot be owed more than the splitter holds. This was one of the six fixed defects.',
    false,
    'agentOwed <= balance',
    async () => {
      const [owed, balance] = await Promise.all([
        readSplitter<bigint>('getAgentOwed'),
        readSplitter<bigint>('getBalance'),
      ]);
      return {
        ok: owed <= balance,
        detail: `owed ${formatUsdc(owed)} USDC against ${formatUsdc(balance)} USDC held`,
        data: { owed: amount(owed), balance: amount(balance) },
      };
    },
  ),
  entry(
    'unsettled-equals-surplus',
    'Unsettled revenue accounts for the rest',
    'Anything held beyond what is owed is revenue that has not been settled yet, not a leak.',
    false,
    'unsettled == surplus',
    async () => {
      const [unsettled, surplus] = await Promise.all([
        readSplitter<bigint>('getUnsettledRevenue'),
        readSplitter<bigint>('surplus'),
      ]);
      return {
        ok: unsettled === surplus,
        detail: `unsettled ${formatUsdc(unsettled)} USDC, surplus ${formatUsdc(surplus)} USDC`,
        data: { unsettled: amount(unsettled), surplus: amount(surplus) },
      };
    },
  ),
  entry(
    'vault-conservation',
    'Vault balance equals debt plus free',
    'The vault must always equal what it owes lenders plus what is unencumbered. A third fixed defect.',
    false,
    'balance == outstanding + availableToWithdraw',
    async () => {
      const client = getPublicClient();
      const [balance, outstanding, free] = await Promise.all([
        client.readContract({ address: config.vault, abi: vaultAbi, functionName: 'getBalance' }),
        client.readContract({ address: config.vault, abi: vaultAbi, functionName: 'getTotalOutstanding' }),
        client.readContract({ address: config.vault, abi: vaultAbi, functionName: 'availableToWithdraw' }),
      ]);
      return {
        ok: balance === outstanding + free,
        detail: `${formatUsdc(balance)} USDC = ${formatUsdc(outstanding)} debt + ${formatUsdc(free)} free`,
        data: { balance: amount(balance), outstanding: amount(outstanding), free: amount(free) },
      };
    },
  ),
  entry(
    'debt-matches-loans',
    'Repaid plus outstanding equals principal plus fee',
    'The flat fee must actually be charged. Its absence was the most serious of the six defects.',
    false,
    'every loan balances',
    async () => {
      const client = getPublicClient();
      const length = Number(await client.readContract({
        address: config.vault,
        abi: vaultAbi,
        functionName: 'getLoansLength',
      }));
      const rows: unknown[] = [];
      let ok = true;
      for (let i = 0; i < length; i += 1) {
        const loan = await client.readContract({
          address: config.vault,
          abi: vaultAbi,
          functionName: 'getLoan',
          args: [BigInt(i)],
        });
        const totalDue = loan.principal + (loan.principal * loan.feeBps) / 10000n;
        const outstanding = loan.active
          ? await client.readContract({
              address: config.vault,
              abi: vaultAbi,
              functionName: 'advanceOutstanding',
              args: [loan.splitter],
            })
          : 0n;
        const balanced = loan.repaid + outstanding === totalDue;
        if (!balanced) ok = false;
        rows.push({
          loanId: i,
          principal: formatUsdc(loan.principal),
          feeBps: Number(loan.feeBps),
          totalDue: formatUsdc(totalDue),
          repaid: formatUsdc(loan.repaid),
          outstanding: formatUsdc(outstanding),
          active: loan.active,
          delinquent: loan.delinquent,
          flagged: loan.flagged,
          balanced,
        });
      }
      return {
        ok,
        detail: ok
          ? `${length} loan(s) balance, fee charged on each`
          : 'a loan does not balance',
        data: rows,
      };
    },
  ),
  entry(
    'reject-unregistered-splitter',
    'Vault rejects an unregistered splitter',
    'Negative test: a loan request for an address the factory never deployed must revert. Simulated, so nothing is sent.',
    false,
    'revert "Not a registered splitter"',
    async () => {
      const client = getPublicClient();
      const fake = '0x000000000000000000000000000000000000dEaD';
      return expectRevert(
        'openLoan for an unregistered splitter',
        /Not a registered splitter/i,
        () =>
          client.simulateContract({
            address: config.vault,
            abi: vaultAbi,
            functionName: 'openLoan',
            args: [fake, 1_000_000n, `0x${'00'.repeat(32)}`],
            account: getAccount()?.address,
          } as never),
      );
    },
  ),
  entry(
    'reject-oversized-advance',
    'Vault rejects an oversized advance',
    'Negative test: a request far beyond the cap must revert rather than silently over-advancing. Simulated.',
    false,
    'revert "Exceeds cap"',
    async () => {
      const client = getPublicClient();
      return expectRevert(
        'openLoan for 1e12 USDC',
        /Exceeds cap/i,
        () =>
          client.simulateContract({
            address: config.vault,
            abi: vaultAbi,
            functionName: 'openLoan',
            args: [config.splitter, 1_000_000_000_000n, `0x${'00'.repeat(32)}`],
            account: getAccount()?.address,
          } as never),
      );
    },
  ),
  entry(
    'withdraw-claim',
    'Agent withdraws its earned revenue',
    'Calls withdraw() on the splitter. Sends a transaction, so it costs gas and moves real testnet USDC to the payout address.',
    true,
    'claim drops to zero, payout balance rises',
    async () => {
      const before = await readSplitter<bigint>('getAgentOwed');
      if (before === 0n) {
        return { ok: true, detail: 'nothing claimed, nothing to withdraw' };
      }
      const wallet = await requireWalletClient();
      const hash = await wallet.writeContract({
        address: config.splitter,
        abi: splitterAbi,
        functionName: 'withdraw',
      } as never);
      await getPublicClient().waitForTransactionReceipt({ hash });
      const after = await readSplitter<bigint>('getAgentOwed');
      return {
        ok: after === 0n,
        detail: `claimed ${formatUsdc(before)} USDC, ${formatUsdc(after)} USDC remains`,
        data: { withdrawn: amount(before), remaining: amount(after), explorer: explorerTx(hash) },
      };
    },
  ),
];

const handler: Handler = async (req, res) => {
  const id = (Array.isArray(req.query.id) ? req.query.id[0] : req.query.id) as TestId | undefined;
  const authenticated = isAuthorized(req);

  if (!id) {
    res.status(200).json({
      authenticated,
      tests: tests.map(({ id: testId, title, description, costly, expect }) => ({
        id: testId,
        title,
        description,
        costly,
        expect,
      })),
    });
    return;
  }

  const found = tests.find((test) => test.id === id);
  if (!found) {
    res.status(404).json({ error: `Unknown test: ${id}` });
    return;
  }
  if (found.costly && !authenticated) {
    res.status(401).json({
      error: `"${found.title}" sends a transaction and needs the keeper secret.`,
      id: found.id,
    });
    return;
  }

  const started = Date.now();
  try {
    const result = await found.run();
    res.status(result.ok ? 200 : 500).json({
      id: found.id,
      title: found.title,
      expect: found.expect,
      pass: result.ok,
      detail: result.detail,
      data: result.data,
      ms: Date.now() - started,
    });
  } catch (error) {
    res.status(500).json({
      id: found.id,
      title: found.title,
      expect: found.expect,
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
      ms: Date.now() - started,
    });
  }
};

export default handler;