#!/usr/bin/env node

/**
 * Underwriter: scores a splitter before an advance is issued and writes the
 * decision, with its reasons, into the loan's rationaleHash.
 *
 * The vault stores a bytes32 rationaleHash and never reads it. That is the whole
 * design: the hash commits to a written rationale so the decision is auditable
 * after the fact, and the policy lives here rather than in the contract.
 *
 * Two scoring modes, in order of preference:
 *
 *  1. An LLM, when UNDERWRITER_LLM_ENDPOINT is set. The prompt carries the
 *     on-chain metrics and asks for a score plus reasons.
 *
 *  2. A deterministic rules engine, always available as a fallback and as the
 *     thing to reason against. It is intentionally boring: every input is a
 *     number read from the chain, every threshold is named, and the output is
 *     reproducible from the same state.
 *
 * The rules engine is not a toy. If the two modes disagree, the service reports
 * it and refuses to open the loan, because a disagreement means either the
 * metrics are wrong or the policy has drifted. Neither should open a position.
 *
 * `dryRun` defaults to true. An underwriter that opens advances on its own is a
 * lending bot with an LLM in the loop, which is not what this submission needs
 * to demonstrate.
 */

import { config } from "dotenv";
config({ path: ".env" });

import { ethers } from "ethers";

const USDC_DECIMALS = 6;

type Metrics = {
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

type Verdict = {
  approved: boolean;
  score: number;
  reasons: string[];
  rationale: string;
  source: "llm" | "rules";
};

function formatUsdc(value: bigint): string {
  const whole = value / 10n ** BigInt(USDC_DECIMALS);
  const frac = (value % 10n ** BigInt(USDC_DECIMALS))
    .toString()
    .padStart(USDC_DECIMALS, "0")
    .replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""}`;
}

/**
 * Pinning the chain skips ethers' network detection, which times out on the
 * public Arc endpoint often enough to make a read look like a hard failure.
 */
/**
 * Resolve the chain from configuration and verify the RPC actually serves it.
 *
 * This previously hardcoded Arc testnet with `staticNetwork: true`. Pointing the
 * service at the mainnet RPC therefore failed inside ethers with a network
 * mismatch rather than anything that named the real problem, and every network
 * value in the file was a testnet literal.
 */
type ChainConfig = { chainId: number; name: string };

function resolveChain(): ChainConfig {
  const chainId = Number(process.env.RUNWAY_CHAIN_ID || 5042002);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`RUNWAY_CHAIN_ID is not a valid chain id: ${process.env.RUNWAY_CHAIN_ID}`);
  }
  const name = process.env.RUNWAY_NETWORK || (chainId === 5042002 ? "arc-testnet" : "arc-mainnet");
  return { chainId, name };
}

const CHAIN = resolveChain();

async function providerFor(rpcUrl: string): Promise<ethers.JsonRpcProvider> {
  const provider = new ethers.JsonRpcProvider(rpcUrl, CHAIN, {
    staticNetwork: true,
    batchMaxCount: 1,
  });
  // Ask the node directly. `getNetwork()` is useless for this because
  // staticNetwork makes ethers return the pinned value, so comparing it against
  // CHAIN always matches. Raw eth_chainId is the only honest source.
  const actual = Number(await provider.send("eth_chainId", []));
  if (actual !== CHAIN.chainId) {
    throw new Error(
      `RPC serves chain ${actual} but RUNWAY_CHAIN_ID is ${CHAIN.chainId}. ` +
        `Check RUNWAY_CHAIN_ID and the RPC URL before sending transactions.`,
    );
  }
  return provider;
}

async function main() {
  const network = CHAIN.name;
  // Accept either variable so one config works on both chains.
  const rpcUrl = process.env.RUNWAY_RPC_URL || process.env.ARC_TESTNET_RPC;
  if (!rpcUrl) throw new Error("RUNWAY_RPC_URL (or ARC_TESTNET_RPC) is not configured");

  const provider = await providerFor(rpcUrl);
  const vaultAddress = process.env.RUNWAY_VAULT_ADDRESS;
  if (!vaultAddress) throw new Error("RUNWAY_VAULT_ADDRESS is not configured");

  const dryRun = process.env.UNDERWRITER_DRY_RUN !== "false";
  const minScore = Number(process.env.UNDERWRITER_MIN_SCORE || "60");
  const requestedPrincipal = BigInt(process.env.UNDERWRITER_PRINCIPAL || "10000000");

  const vault = new ethers.Contract(
    vaultAddress,
    [
      "function getLoansLength() view returns (uint256)",
      "function getLoan(uint256) view returns (tuple(address splitter, uint256 principal, uint256 feeBps, uint256 shareBps, uint256 dueDate, uint256 repaid, bool delinquent, bool flagged, bytes32 rationaleHash, bool active))",
      "function getLoanId(address) view returns (uint256)",
      "function advanceOutstanding(address) view returns (uint256)",
      "function totalDue(uint256) view returns (uint256)",
      "function GLOBAL_MAX() view returns (uint256)",
      "function STARTER_CAP() view returns (uint256)",
      "function FEE_BPS_DEFAULT() view returns (uint256)",
      "function DUE_DAYS_DEFAULT() view returns (uint256)",
      "function isSplitter(address) view returns (bool)",
      "function splitterToAgent(address) view returns (address)",
      "function openLoan(address, uint256, bytes32) returns (uint256)",
      "function UNDERWRITER_ROLE() view returns (bytes32)",
    ],
    provider,
  );

  const splitter = new ethers.Contract(
    "0x0000000000000000000000000000000000000000",
    [
      "function lifetimeRevenue() view returns (uint256)",
      "function getUnsettledRevenue() view returns (uint256)",
      "function getAgentOwed() view returns (uint256)",
      "function getDebtOwed() view returns (uint256)",
      "function agent() view returns (address)",
      "function payout() view returns (address)",
      "function loanActive() view returns (bool)",
    ],
    provider,
  );

  console.log(`Underwriter on ${network}`);
  console.log(`  vault:     ${vaultAddress}`);
  console.log(`  dry run:   ${dryRun}`);
  console.log(`  min score: ${minScore}`);
  console.log(`  principal: ${formatUsdc(requestedPrincipal)} USDC`);

  async function collect(splitterAddress: string): Promise<Metrics> {
    const contract = splitter.attach(splitterAddress) as typeof splitter;

    const length = Number(await vault.getLoansLength());
    let loansOpened = 0;
    let loansRepaid = 0;
    let loansDelinquent = 0;
    let loansFlagged = 0;

    for (let i = 0; i < length; i++) {
      const loan = await vault.getLoan(i);
      if (loan.splitter.toLowerCase() !== splitterAddress.toLowerCase()) continue;
      loansOpened += 1;
      if (!loan.active) loansRepaid += 1;
      if (loan.delinquent) loansDelinquent += 1;
      if (loan.flagged) loansFlagged += 1;
    }

    const loanId = await vault.getLoanId(splitterAddress);
    const active = loanId !== ethers.MaxUint256;

    return {
      splitter: splitterAddress,
      agent: await contract.agent(),
      payout: await contract.payout(),
      lifetimeRevenue: await contract.lifetimeRevenue(),
      unsettledRevenue: await contract.getUnsettledRevenue(),
      agentOwed: await contract.getAgentOwed(),
      debtOwed: await contract.getDebtOwed(),
      loansOpened,
      loansRepaid,
      loansDelinquent,
      loansFlagged,
      loanActive: active,
      flagged: false,
    };
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
        reasons.push(`repayment rate ${(repayRate * 100).toFixed(0)}% across ${metrics.loansOpened} advances`);
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
    const approved = score >= minScore;

    if (approved) reasons.unshift(`score ${score} meets the ${minScore} threshold`);
    else reasons.unshift(`score ${score} is below the ${minScore} threshold`);

    return {
      approved,
      score,
      reasons,
      rationale: reasons.join("; "),
      source: "rules",
    };
  }

  /**
   * Optional LLM pass. The model sees only the metrics above and returns a score
   * and reasons; it never returns an amount or an address, so it cannot widen
   * the position on its own.
   */
  async function scoreLlm(metrics: Metrics, principal: bigint): Promise<Verdict | null> {
    const endpoint = process.env.UNDERWRITER_LLM_ENDPOINT;
    const apiKey = process.env.UNDERWRITER_LLM_API_KEY;
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
          model: process.env.UNDERWRITER_LLM_MODEL || "gpt-4o-mini",
          messages: [
            { role: "system", content: "Return only JSON. Be conservative." },
            { role: "user", content: prompt },
          ],
          temperature: 0,
          response_format: { type: "json_object" },
        }),
      });

      if (!response.ok) throw new Error(`endpoint returned ${response.status}`);
      const payload = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
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

  async function evaluate(splitterAddress: string) {
    const metrics = await collect(splitterAddress);
    const rules = scoreRules(metrics, requestedPrincipal);
    const llm = await scoreLlm(metrics, requestedPrincipal);

    let verdict = rules;
    if (llm && llm.approved !== rules.approved) {
      // A disagreement means the metrics or the policy are wrong. Neither
      // should open a position, so decline and say why.
      console.log("");
      console.log(`Disagreement on ${splitterAddress}:`);
      console.log(`  rules: ${rules.approved ? "approve" : "decline"} (${rules.score})`);
      console.log(`  llm:   ${llm.approved ? "approve" : "decline"} (${llm.score})`);
      verdict = {
        approved: false,
        score: Math.min(rules.score, llm.score),
        reasons: [
          "rules and LLM disagree, so the decision needs a human",
          ...rules.reasons,
          ...llm.reasons,
        ],
        rationale: "",
        source: "llm",
      };
      verdict.rationale = verdict.reasons.join("; ");
    } else if (llm) {
      verdict = llm;
    }

    return { metrics, verdict };
  }

  function report(splitterAddress: string, metrics: Metrics, verdict: Verdict) {
    console.log("");
    console.log(`${splitterAddress}`);
    console.log(`  agent:     ${metrics.agent}`);
    console.log(`  payout:    ${metrics.payout}`);
    console.log(
      `  revenue:   ${formatUsdc(metrics.lifetimeRevenue)} USDC lifetime, ${formatUsdc(metrics.unsettledRevenue)} unsettled`,
    );
    console.log(`  advances:  ${metrics.loansOpened} opened, ${metrics.loansRepaid} repaid, ${metrics.loansDelinquent} delinquent`);
    console.log(`  debt:      ${formatUsdc(metrics.debtOwed)} USDC`);
    console.log(`  decision:  ${verdict.approved ? "APPROVE" : "DECLINE"} (${verdict.score}, via ${verdict.source})`);
    for (const reason of verdict.reasons) console.log(`    - ${reason}`);
  }

  async function submit(splitterAddress: string, principal: bigint, verdict: Verdict) {
    if (dryRun) {
      console.log("");
      console.log(`  dry run: not calling openLoan for ${splitterAddress}`);
      return;
    }

    // Fail loudly and specifically. A non-null assertion here turns a missing key
    // into an opaque ethers error, or a wallet built from a default value that
    // silently fails every tx. Better to stop at the first decision point.
    const underwriterKey = process.env.UNDERWRITER_PRIVATE_KEY;
    if (!underwriterKey) {
      throw new Error(
        "UNDERWRITER_PRIVATE_KEY is not set. The underwriter needs its own key, distinct " +
          "from the watcher and the deployer, and it must hold UNDERWRITER_ROLE on the vault. " +
          "Set it in the environment (or .env) before starting.",
      );
    }
    let signer: ethers.Wallet;
    try {
      signer = new ethers.Wallet(underwriterKey, provider);
    } catch {
      throw new Error(
        "UNDERWRITER_PRIVATE_KEY is set but is not a valid private key. Expected 0x followed by 64 hex characters.",
      );
    }
    const signerVault = vault.connect(signer) as typeof vault;
    const hasRole = await signerVault.hasRole(await vault.UNDERWRITER_ROLE(), signer.address);
    if (!hasRole) {
      throw new Error(
        `signer ${signer.address} does not hold UNDERWRITER_ROLE on ${vaultAddress}. ` +
          "Grant it with grantRole(UNDERWRITER_ROLE(), <address>) from the vault admin.",
      );
    }

    const rationaleHash = ethers.solidityPackedKeccak256(
      ["string", "uint256", "uint256", "string"],
      [verdict.rationale, principal, BigInt(verdict.score), verdict.source],
    );

    const tx = await signerVault.openLoan(splitterAddress, principal, rationaleHash);
    await tx.wait();
    console.log(`  opened advance: ${tx.hash}`);
    console.log(`  rationaleHash: ${rationaleHash}`);
  }

// Accept a splitter as the first CLI argument, or fall back to the environment.
// The help text promised this argument, but only the env var was ever read, so
// passing an address appeared to do nothing.
const argTarget = process.argv[2];
if (argTarget && !argTarget.startsWith("--") && !ethers.isAddress(argTarget)) {
  throw new Error(
    `argument "${argTarget}" is not a contract address. Pass a 0x-prefixed address, or use --help.`,
  );
}

const target = argTarget || process.env.UNDERWRITER_SPLITTER;
if (!target) {
  console.log("");
  console.log("Usage: node dist/index.js <splitter-address>");
  console.log("Or set UNDERWRITER_SPLITTER in the environment.");
  console.log("");
  console.log("Nothing was scored. Registered splitters can be listed with:");
  console.log("  ./scripts/keeper.sh --dry-run");
  return;
}

if (!(await vault.isSplitter(target))) {
  throw new Error(`${target} is not a registered splitter`);
}

  const { metrics, verdict } = await evaluate(target);
  report(target, metrics, verdict);

  if (verdict.approved) {
    await submit(target, requestedPrincipal, verdict);
  } else {
    console.log("");
    console.log("  declined, no advance opened");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});