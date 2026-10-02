#!/usr/bin/env node

/**
 * Watcher: monitors every registered splitter and flags the ones that break the
 * rules before they can borrow again.
 *
 * The vault's WATCHER_ROLE is the only way to call flagLoan. What this service
 * adds on top of the contract is a *decision*: which splitters deserve a flag.
 * It never flags on a hunch. Every rule below is derived from on-chain state,
 * and each finding carries the evidence that produced it.
 *
 * Rules, in the order they are checked:
 *
 *  1. Missed repayment. An advance past its due date with debt still
 *     outstanding. markDelinquent is permissionless, so the vault records this
 *     regardless; the watcher also escalates it to a flag so the agent cannot
 *     open a fresh advance while owing.
 *
 *  2. Payout redirected mid-flight. A PayoutChanged event while an advance is
 *     active is the swap scenario the threat model calls out. setPayout already
 *     reverts in that case, so this fires only if the guard is ever bypassed or
 *     removed. Watching it is cheap and the failure mode is severe.
 *
 *  3. Self-funded cap inflation. The advance cap grows with lifetime revenue,
 *     so an agent paying itself can raise its own limit. The watcher reports
 *     when a splitter's outstanding debt is a large share of its lifetime
 *     revenue, which is the signature of washing.
 *
 * A flag is permanent for the loan and blocks future borrowing through
 * `_isSplitterFlagged`. That is deliberate: it is a stop, not a score. Reversing
 * a bad flag needs a human, so WATCHER_ALLOW is required per splitter address.
 */

import { config } from "dotenv";
config({ path: ".env" });

import { ethers } from "ethers";

const USDC_DECIMALS = 6;

type Loan = {
  splitter: string;
  principal: bigint;
  feeBps: bigint;
  shareBps: bigint;
  dueDate: bigint;
  repaid: bigint;
  delinquent: boolean;
  flagged: boolean;
  rationaleHash: string;
  active: boolean;
};

type Finding = {
  splitter: string;
  loanId: bigint;
  rule: "missed-repayment" | "payout-swap" | "cap-inflation";
  evidence: string;
};

function formatUsdc(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 10n ** BigInt(USDC_DECIMALS);
  const frac = (abs % 10n ** BigInt(USDC_DECIMALS))
    .toString()
    .padStart(USDC_DECIMALS, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/**
 * Pinning the chain skips ethers' network detection, which times out on the
 * public Arc endpoint often enough to make a read look like a hard failure.
 */
const ARC_TESTNET = { chainId: 5042002, name: "arc-testnet" };

function providerFor(rpcUrl: string): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(rpcUrl, ARC_TESTNET, {
    staticNetwork: true,
    batchMaxCount: 1,
  });
}

async function main() {
  const network = process.env.NETWORK || "testnet";
  const rpcUrl = process.env.ARC_TESTNET_RPC;
  if (!rpcUrl) throw new Error("ARC_TESTNET_RPC is not configured");

  const intervalMs = parseInt(process.env.WATCHER_INTERVAL_MS || "60000", 10);
  /**
   * Debt above this fraction of lifetime revenue is the wash-trading signal.
   * A legitimate advance is repaid out of revenue that arrives after it, so
   * outstanding debt normally stays a small fraction of lifetime revenue.
   */
  const inflationRatio = Number(process.env.WATCHER_INFLATION_RATIO || "0.9");
  /**
   * Splitters allowed to be flagged. Empty means nothing is flagged and the
   * service only reports, which is the safe default for a first run.
   */
  const allow = new Set(
    (process.env.WATCHER_ALLOW || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );

  const provider = providerFor(rpcUrl);

  // Fail loudly and specifically. A non-null assertion here turns a missing key
  // into an opaque ethers error deep in a wallet constructor, or worse, a wallet
  // built from a default value that then silently fails every tx it signs.
  const watcherKey = process.env.WATCHER_PRIVATE_KEY;
  if (!watcherKey) {
    throw new Error(
      "WATCHER_PRIVATE_KEY is not set. The watcher needs its own key, distinct from " +
        "the underwriter and the deployer, and it must hold WATCHER_ROLE on the vault. " +
        "Set it in the environment (or .env) before starting.",
    );
  }
  let walletAddress: string;
  try {
    const wallet = new ethers.Wallet(watcherKey, provider);
    walletAddress = wallet.address;
  } catch {
    throw new Error(
      "WATCHER_PRIVATE_KEY is set but is not a valid private key. Expected 0x followed by 64 hex characters.",
    );
  }

  const vaultAddress = process.env.RUNWAY_VAULT_ADDRESS;
  if (!vaultAddress) throw new Error("RUNWAY_VAULT_ADDRESS is not configured");

  const vaultAbi = [
    "function getLoansLength() view returns (uint256)",
    "function getLoan(uint256) view returns (tuple(address splitter, uint256 principal, uint256 feeBps, uint256 shareBps, uint256 dueDate, uint256 repaid, bool delinquent, bool flagged, bytes32 rationaleHash, bool active))",
    "function markDelinquent(uint256)",
    "function flagLoan(uint256, bytes32)",
    "function WATCHER_ROLE() view returns (bytes32)",
    "function hasRole(bytes32, address) view returns (bool)",
    "function getLoanId(address) view returns (uint256)",
  ];

  const splitterAbi = [
    "function lifetimeRevenue() view returns (uint256)",
    "function payout() view returns (address)",
    "function agent() view returns (address)",
    "function getAgentOwed() view returns (uint256)",
    "function getDebtOwed() view returns (uint256)",
  ];

  const vault = new ethers.Contract(vaultAddress, vaultAbi, new ethers.Wallet(watcherKey, provider));

  console.log(`Watcher on ${network}`);
  console.log(`  vault:  ${vaultAddress}`);
  console.log(`  signer: ${walletAddress}`);
  console.log(`  every:  ${intervalMs}ms`);
  console.log(`  flags:  ${allow.size === 0 ? "disabled (set WATCHER_ALLOW)" : `${allow.size} splitter(s)`}`);

  const hasRole = await vault.hasRole(await vault.WATCHER_ROLE(), walletAddress).catch(() => false);
  if (!hasRole) {
    console.warn("  warning: signer does not hold WATCHER_ROLE; flags will revert");
  }

  /**
   * Payout changes are only interesting while an advance is live, and the
   * contract already blocks them. Track the last seen block per splitter so a
   * missed event is not replayed as current news.
   */
  const payoutLog = new ethers.Interface([
    "event PayoutChanged(address indexed oldPayout, address indexed newPayout)",
  ]);

  /**
   * Payout swaps are only interesting while an advance is live, and setPayout
   * already reverts then. This fires only if that guard is bypassed or removed,
   * which is exactly the case worth an alarm.
   *
   * PayoutChanged carries no splitter topic, so logs are filtered by address.
   */
  async function scanPayoutSwaps(fromBlock: number): Promise<Finding[]> {
    const found: Finding[] = [];
    const toBlock = await provider.getBlockNumber();
    const topic = payoutLog.getEvent("PayoutChanged")!.topicHash;

    for (const loan of await activeLoans()) {
      let logs: ethers.Log[];
      try {
        logs = await provider.getLogs({ address: loan.splitter, fromBlock, toBlock, topics: [topic] });
      } catch {
        continue;
      }

      for (const log of logs) {
        try {
          const parsed = payoutLog.parseLog({ topics: [...log.topics], data: log.data });
          if (!parsed) continue;
          found.push({
            splitter: loan.splitter,
            loanId: BigInt(await vault.getLoanId(loan.splitter)),
            rule: "payout-swap",
            evidence: `payout moved ${parsed.args.oldPayout} -> ${parsed.args.newPayout} at block ${log.blockNumber}`,
          });
        } catch {
          /* unparseable log, ignore */
        }
      }
    }
    return found;
  }

  async function activeLoans(): Promise<Loan[]> {
    const length = Number(await vault.getLoansLength());
    const loans: Loan[] = [];
    for (let i = 0; i < length; i++) {
      const loan = (await vault.getLoan(i)) as Loan;
      if (loan.active) loans.push(loan);
    }
    return loans;
  }

  let lastScannedBlock = 0;

  async function scan() {
    try {
      const block = await provider.getBlockNumber();
      const loans = await activeLoans();
      const findings: Finding[] = [];

      for (const loan of loans) {
        const loanId = await vault.getLoanId(loan.splitter);
        const splitter = new ethers.Contract(loan.splitter, splitterAbi, provider);

        // Rule 1: past due with debt outstanding.
        const now = BigInt(Math.floor(Date.now() / 1000));
        if (!loan.delinquent && now > loan.dueDate) {
          const outstanding = await splitter.getDebtOwed();
          if (outstanding > 0n) {
            findings.push({
              splitter: loan.splitter,
              loanId: BigInt(loanId),
              rule: "missed-repayment",
              evidence: `due ${new Date(Number(loan.dueDate) * 1000).toISOString()}, ${formatUsdc(outstanding)} USDC outstanding`,
            });
          }
        }

        // Rule 3: debt that is large relative to lifetime revenue.
        const revenue = await splitter.lifetimeRevenue().catch(() => 0n);
        const outstanding = await splitter.getDebtOwed().catch(() => 0n);
        if (revenue > 0n && outstanding > 0n) {
          const ratio = Number((outstanding * 10000n) / revenue) / 10000;
          if (ratio >= inflationRatio) {
            findings.push({
              splitter: loan.splitter,
              loanId: BigInt(loanId),
              rule: "cap-inflation",
              evidence: `outstanding ${formatUsdc(outstanding)} is ${(ratio * 100).toFixed(1)}% of lifetime revenue ${formatUsdc(revenue)}`,
            });
          }
        }
      }

      // Rule 2: payout swaps during an active advance.
      if (lastScannedBlock > 0 && block - lastScannedBlock < 2000) {
        findings.push(...(await scanPayoutSwaps(lastScannedBlock)));
      }

      if (findings.length === 0) {
        console.log(`[${new Date().toISOString()}] ${loans.length} active loan(s), no findings`);
      } else {
        console.log(`[${new Date().toISOString()}] ${findings.length} finding(s) across ${loans.length} active loan(s)`);
        for (const finding of findings) {
          console.log(`  [${finding.rule}] ${finding.splitter} loan ${finding.loanId}`);
          console.log(`      ${finding.evidence}`);
        }
      }

      for (const finding of findings) {
        await escalate(finding);
      }

      lastScannedBlock = block;
    } catch (error) {
      console.error("Scan failed:", (error as Error).message);
    }
  }

  async function escalate(finding: Finding) {
    const key = finding.splitter.toLowerCase();

    // A missed repayment is recorded on-chain by anyone, so always try it.
    if (finding.rule === "missed-repayment") {
      try {
        const tx = await vault.markDelinquent(finding.loanId);
        await tx.wait();
        console.log(`  marked loan ${finding.loanId} delinquent: ${tx.hash}`);
      } catch (error) {
        console.log(`  markDelinquent(${finding.loanId}) skipped: ${short(error)}`);
      }
    }

    if (!allow.has(key)) {
      console.log(`  not flagging ${finding.splitter}: not in WATCHER_ALLOW (${finding.rule})`);
      return;
    }

    try {
      const reasonHash = ethers.solidityPackedKeccak256(
        ["string", "uint256", "string"],
        [finding.rule, finding.loanId, finding.evidence],
      );
      const tx = await vault.flagLoan(finding.loanId, reasonHash);
      await tx.wait();
      console.log(`  flagged loan ${finding.loanId}: ${tx.hash}`);
    } catch (error) {
      console.log(`  flagLoan(${finding.loanId}) failed: ${short(error)}`);
    }
  }

  function short(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > 110 ? `${message.slice(0, 110)}...` : message;
  }

  await scan();
  setInterval(scan, intervalMs);

  process.on("SIGINT", () => {
    console.log("\nStopping watcher");
    process.exit(0);
  });

  console.log("Watcher running. Ctrl+C to stop.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});