/**
 * Shared underwriting core.
 *
 * Reads on-chain metrics for a splitter, scores them, and — when it holds the
 * role and is not in dry-run — opens the advance. Extracted from the CLI so the
 * same policy runs behind both the batch command and the HTTP server that the
 * agent-facing MCP talks to. There is one scoring path; two copies would drift.
 *
 * Reads/writes go through the same viem-based SDK the MCP uses. (The previous
 * ethers path intermittently stalled against the public Arc endpoint.)
 */

import {
  createRunwayClient,
  formatUsdc,
  requestAdvance,
  splitterAbi,
  vaultAbi,
  type RunwayClient,
} from "@workspace/runway-sdk";
import { isAddress, maxUint256, type Address } from "viem";

export type Metrics = {
  splitter: string;
  agent: string;
  payout: string;
  lifetimeRevenue: bigint;
  unsettledRevenue: bigint;
  agentOwed: bigint;
  debtOwed: bigint;
  loansOpened: number;
  loansRepaid: number;
  loansDelinquent: number;
  loansFlagged: number;
  loanActive: boolean;
  flagged: boolean;
};

export type Verdict = {
  approved: boolean;
  score: number;
  reasons: string[];
  rationale: string;
  source: "rules" | "llm";
};

export type UnderwriterOptions = {
  rpcUrl: string;
  vaultAddress: string;
  chainId: number;
  network: string;
  /** When true, decisions are reported but no advance is opened. */
  dryRun: boolean;
  /** Minimum score the rules engine must reach to approve. */
  minScore: number;
  /** Operator key. Must hold UNDERWRITER_ROLE; required only to actually lend. */
  underwriterKey?: `0x${string}`;
  llm?: { endpoint?: string; apiKey?: string; model?: string };
};

export type Underwriter = {
  options: UnderwriterOptions;
  isSplitter(splitter: string): Promise<boolean>;
  collect(splitter: string): Promise<Metrics>;
  evaluate(splitter: string, principal: bigint): Promise<{ metrics: Metrics; verdict: Verdict }>;
  /** Returns `dryRun: true` and empty hashes when no advance was submitted. */
  openLoan(
    splitter: string,
    principal: bigint,
    verdict: Verdict,
  ): Promise<{ txHash: string; rationaleHash: string; dryRun: boolean }>;
};

/** Read configuration from the environment. Throws if a required value is missing. */
export function optionsFromEnv(): UnderwriterOptions {
  const rpcUrl = process.env.RUNWAY_RPC_URL || process.env.ARC_TESTNET_RPC;
  if (!rpcUrl) throw new Error("RUNWAY_RPC_URL (or ARC_TESTNET_RPC) is not configured");

  const vaultAddress = process.env.RUNWAY_VAULT_ADDRESS;
  if (!vaultAddress) throw new Error("RUNWAY_VAULT_ADDRESS is not configured");

  const chainId = Number(process.env.RUNWAY_CHAIN_ID || 5042002);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`RUNWAY_CHAIN_ID is not a valid chain id: ${process.env.RUNWAY_CHAIN_ID}`);
  }

  return {
    rpcUrl,
    vaultAddress,
    chainId,
    network: process.env.RUNWAY_NETWORK || (chainId === 5042002 ? "arc-testnet" : "arc-mainnet"),
    dryRun: process.env.UNDERWRITER_DRY_RUN !== "false",
    minScore: Number(process.env.UNDERWRITER_MIN_SCORE || "60"),
    underwriterKey: process.env.UNDERWRITER_PRIVATE_KEY as `0x${string}` | undefined,
    llm: {
      endpoint: process.env.UNDERWRITER_LLM_ENDPOINT,
      apiKey: process.env.UNDERWRITER_LLM_API_KEY,
      model: process.env.UNDERWRITER_LLM_MODEL,
    },
  };
}

/** Build an underwriter bound to the configured chain. The publicClient is shared. */
export async function createUnderwriter(options: UnderwriterOptions): Promise<Underwriter> {
  const runway: RunwayClient = createRunwayClient({
    chainId: options.chainId,
    network: options.network,
    rpcUrl: options.rpcUrl,
    vault: options.vaultAddress as Address,
    privateKey: options.underwriterKey,
  });

  // The EIP-712 domain and every address are per-chain, so fail fast on a
  // mismatched endpoint rather than deep inside a write.
  const actualChainId = await runway.publicClient.getChainId();
  if (actualChainId !== options.chainId) {
    throw new Error(
      `RPC serves chain ${actualChainId} but RUNWAY_CHAIN_ID is ${options.chainId}. ` +
        `Check RUNWAY_CHAIN_ID and the RPC URL before sending transactions.`,
    );
  }

  const vault = options.vaultAddress as Address;

  // The SDK's vaultAbi omits isSplitter; call it with a minimal ABI fragment.
  const isSplitterAbi = [
    {
      type: "function",
      name: "isSplitter",
      stateMutability: "view",
      inputs: [{ name: "splitter", type: "address" }],
      outputs: [{ name: "", type: "bool" }],
    },
  ] as const;

  async function isSplitter(splitterAddress: string): Promise<boolean> {
    return (await runway.publicClient.readContract({
      address: vault,
      abi: isSplitterAbi,
      functionName: "isSplitter",
      args: [splitterAddress as Address],
    })) as boolean;
  }

  async function theSplitterReads(splitterAddress: string) {
    const address = splitterAddress as Address;
    const [lifetimeRevenue, unsettledRevenue, agentOwed, debtOwed] = (await Promise.all([
      runway.publicClient.readContract({ address, abi: splitterAbi, functionName: "lifetimeRevenue" }),
      runway.publicClient.readContract({ address, abi: splitterAbi, functionName: "getUnsettledRevenue" }),
      runway.publicClient.readContract({ address, abi: splitterAbi, functionName: "getAgentOwed" }),
      runway.publicClient.readContract({ address, abi: splitterAbi, functionName: "getDebtOwed" }),
    ])) as [bigint, bigint, bigint, bigint];
    return { lifetimeRevenue, unsettledRevenue, agentOwed, debtOwed };
  }

  async function collectOnce(splitterAddress: string): Promise<Metrics> {
    const [agent, payout] = (await Promise.all([
      runway.publicClient.readContract({ address: splitterAddress as Address, abi: splitterAbi, functionName: "agent" }),
      runway.publicClient.readContract({ address: splitterAddress as Address, abi: splitterAbi, functionName: "payout" }),
    ])) as [Address, Address];

    const { lifetimeRevenue, unsettledRevenue, agentOwed, debtOwed } =
      await theSplitterReads(splitterAddress);

    const length = Number(
      (await runway.publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "getLoansLength",
      })) as bigint,
    );

    let loansOpened = 0;
    let loansRepaid = 0;
    let loansDelinquent = 0;
    let loansFlagged = 0;

    for (let i = 0; i < length; i++) {
      const loan = (await runway.publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "getLoan",
        args: [BigInt(i)],
      })) as { splitter: Address; active: boolean; delinquent: boolean; flagged: boolean };
      if (loan.splitter.toLowerCase() !== splitterAddress.toLowerCase()) continue;
      loansOpened += 1;
      if (!loan.active) loansRepaid += 1;
      if (loan.delinquent) loansDelinquent += 1;
      if (loan.flagged) loansFlagged += 1;
    }

    const loanId = (await runway.publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "getLoanId",
      args: [splitterAddress as Address],
    })) as bigint;
    const active = loanId !== maxUint256;

    return {
      splitter: splitterAddress,
      agent,
      payout,
      lifetimeRevenue,
      unsettledRevenue,
      agentOwed,
      debtOwed,
      loansOpened,
      loansRepaid,
      loansDelinquent,
      loansFlagged,
      loanActive: active,
      flagged: false,
    };
  }

  async function withReadRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (error) {
        last = error;
        if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 400 * (i + 1)));
      }
    }
    throw last;
  }

  async function collect(splitterAddress: string): Promise<Metrics> {
    return withReadRetry(() => collectOnce(splitterAddress));
  }

  /**
   * Deterministic policy. Every threshold is a named constant so a reviewer can
   * see the decision rule without reading the scoring arithmetic.
   */
  function scoreRules(metrics: Metrics, principal: bigint): Verdict {
    const reasons: string[] = [];
    let score = 100;

    // Repayment record is the strongest signal.
    if (metrics.loansDelinquent > 0) {
      score -= 50 * metrics.loansDelinquent;
      reasons.push(`${metrics.loansDelinquent} prior advance(s) went delinquent`);
    }
    if (metrics.loansFlagged > 0) {
      score -= 100 * metrics.loansFlagged;
      reasons.push(`${metrics.loansFlagged} prior advance(s) flagged by the watcher`);
    }
    if (metrics.loansOpened > 0) {
      const repayRate = metrics.loansRepaid / metrics.loansOpened;
      if (repayRate === 1) {
        reasons.push(`repaid ${metrics.loansRepaid} of ${metrics.loansOpened} advances in full`);
      } else {
        score -= 25;
        reasons.push(
          `repayment rate ${(repayRate * 100).toFixed(0)}% across ${metrics.loansOpened} advances`,
        );
      }
    } else {
      // Thin history is not disqualifying but it is unproven.
      score -= 10;
      reasons.push("no advance history to underwrite against");
    }

    // Revenue is what backs repayment.
    if (metrics.lifetimeRevenue === 0n) {
      score -= 40;
      reasons.push("no lifetime revenue recorded");
    } else if (metrics.lifetimeRevenue < principal) {
      score -= 20;
      reasons.push(
        `lifetime revenue ${formatUsdc(metrics.lifetimeRevenue)} USDC is below the requested principal`,
      );
    } else {
      reasons.push(
        `lifetime revenue ${formatUsdc(metrics.lifetimeRevenue)} USDC covers the requested principal`,
      );
    }

    // Unsettled revenue is revenue we cannot count on yet.
    if (metrics.unsettledRevenue > metrics.lifetimeRevenue / 2n && metrics.unsettledRevenue > 0n) {
      score -= 15;
      reasons.push(
        `most revenue is unsettled (${formatUsdc(metrics.unsettledRevenue)} USDC pending)`,
      );
    }

    // Outstanding debt against revenue is the wash-trading signature.
    if (metrics.debtOwed > 0n && metrics.lifetimeRevenue > 0n) {
      const ratio = Number((metrics.debtOwed * 100n) / metrics.lifetimeRevenue);
      if (ratio >= 90) {
        score -= 35;
        reasons.push(
          `outstanding debt is ${ratio}% of lifetime revenue, which suggests self-funded revenue`,
        );
      }
    }

    score = Math.max(0, Math.min(100, score));
    const approved = score >= options.minScore;

    if (approved) reasons.unshift(`score ${score} meets the ${options.minScore} threshold`);
    else reasons.unshift(`score ${score} is below the ${options.minScore} threshold`);

    return { approved, score, reasons, rationale: reasons.join("; "), source: "rules" };
  }

  /**
   * Optional LLM pass. The model sees only the metrics above and returns a score
   * and reasons; it never returns an amount or an address, so it cannot widen
   * the position on its own.
   */
  async function scoreLlm(metrics: Metrics, principal: bigint): Promise<Verdict | null> {
    const endpoint = options.llm?.endpoint;
    const apiKey = options.llm?.apiKey;
    if (!endpoint || !apiKey) return null;

    const prompt = [
      "You are underwriting working capital for an autonomous AI agent on a revenue-based credit protocol.",
      "Score this borrower from 0 to 100 on repayment likelihood. Answer with JSON only:",
      '{"score": <int 0-100>, "approved": <bool>, "reasons": [<string>, ...]}',
      "",
      `requested principal: ${formatUsdc(principal)} USDC`,
      `lifetime revenue: ${formatUsdc(metrics.lifetimeRevenue)} USDC`,
      `unsettled revenue: ${formatUsdc(metrics.unsettledRevenue)} USDC`,
      `outstanding debt: ${formatUsdc(metrics.debtOwed)} USDC`,
      `agent owed: ${formatUsdc(metrics.agentOwed)} USDC`,
      `advances opened: ${metrics.loansOpened}, repaid: ${metrics.loansRepaid}, delinquent: ${metrics.loansDelinquent}, flagged: ${metrics.loansFlagged}`,
    ].join("\n");

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: options.llm?.model || "gpt-4o-mini",
          messages: [
            { role: "system", content: "Return only JSON. Be conservative." },
            { role: "user", content: prompt },
          ],
          temperature: 0,
          response_format: { type: "json_object" },
        }),
      });

      if (!response.ok) throw new Error(`endpoint returned ${response.status}`);
      const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error("no content in response");

      const parsed = JSON.parse(content) as { score: number; approved: boolean; reasons: string[] };
      const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : [];
      reasons.unshift(`LLM score ${parsed.score} vs rules score (see below)`);

      return {
        approved: parsed.approved === true,
        score: Math.max(0, Math.min(100, Number(parsed.score))),
        reasons,
        rationale: reasons.join("; "),
        source: "llm",
      };
    } catch (error) {
      console.warn(`  LLM scoring unavailable: ${(error as Error).message}`);
      return null;
    }
  }

  async function evaluate(
    splitterAddress: string,
    principal: bigint,
  ): Promise<{ metrics: Metrics; verdict: Verdict }> {
    const metrics = await collect(splitterAddress);
    const rules = scoreRules(metrics, principal);
    const llm = await scoreLlm(metrics, principal);

    let verdict = rules;
    if (llm && llm.approved !== rules.approved) {
      // A disagreement means the metrics or the policy are wrong. Neither
      // should open a position, so decline and say why.
      verdict = {
        approved: false,
        score: Math.min(rules.score, llm.score),
        reasons: [
          "rules and LLM disagree, so the decision needs a human",
          ...rules.reasons,
          ...llm.reasons,
        ],
        source: "rules",
        rationale: "",
      };
      verdict.rationale = verdict.reasons.join("; ");
    } else if (llm) {
      verdict = llm;
    }

    return { metrics, verdict };
  }

  async function openLoan(
    splitterAddress: string,
    principal: bigint,
    verdict: Verdict,
  ): Promise<{ txHash: string; rationaleHash: string; dryRun: boolean }> {
    if (options.dryRun) return { txHash: "", rationaleHash: "", dryRun: true };
    if (!options.underwriterKey) {
      throw new Error(
        "UNDERWRITER_PRIVATE_KEY is not set. The underwriter needs its own key, distinct " +
          "from the watcher and the deployer, and it must hold UNDERWRITER_ROLE on the vault.",
      );
    }

    const result = await requestAdvance(runway, {
      splitter: splitterAddress as Address,
      principal,
      rationale: verdict.rationale,
    });
    return { txHash: result.hash, rationaleHash: result.rationaleHash, dryRun: false };
  }

  return { options, isSplitter, collect, evaluate, openLoan };
}

export { formatUsdc };
