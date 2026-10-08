import { config as dotenvConfig } from "dotenv";
import { resolve } from "node:path";

// Load the workspace-root .env regardless of the caller's CWD. The dev/typecheck
// entrypoints live three levels under the repo root (services/underwriter/{src,dist}).
dotenvConfig({ path: resolve(new URL(".", import.meta.url).pathname, "../../../.env") });

import { isAddress } from "viem";
import { createUnderwriter, formatUsdc, optionsFromEnv, type Metrics, type Verdict } from "./core.js";

function report(splitterAddress: string, metrics: Metrics, verdict: Verdict): void {
  console.log("");
  console.log(`${splitterAddress}`);
  console.log(`  agent:     ${metrics.agent}`);
  console.log(`  payout:    ${metrics.payout}`);
  console.log(
    `  revenue:   ${formatUsdc(metrics.lifetimeRevenue)} USDC lifetime, ${formatUsdc(metrics.unsettledRevenue)} unsettled`,
  );
  console.log(
    `  advances:  ${metrics.loansOpened} opened, ${metrics.loansRepaid} repaid, ${metrics.loansDelinquent} delinquent`,
  );
  console.log(`  debt:      ${formatUsdc(metrics.debtOwed)} USDC`);
  console.log(
    `  decision:  ${verdict.approved ? "APPROVE" : "DECLINE"} (${verdict.score}, via ${verdict.source})`,
  );
  for (const reason of verdict.reasons) console.log(`    - ${reason}`);
}

async function main(): Promise<void> {
  const options = optionsFromEnv();
  const requestedPrincipal = BigInt(process.env.UNDERWRITER_PRINCIPAL || "10000000");
  const underwriter = await createUnderwriter(options);

  console.log(`Underwriter on ${options.network}`);
  console.log(`  vault:     ${options.vaultAddress}`);
  console.log(`  dry run:   ${options.dryRun}`);
  console.log(`  min score: ${options.minScore}`);
  console.log(`  principal: ${formatUsdc(requestedPrincipal)} USDC`);

  // Accept a splitter as the first CLI argument, or fall back to the environment.
  const argTarget = process.argv[2];
  if (argTarget && !argTarget.startsWith("--") && !isAddress(argTarget)) {
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

  if (!(await underwriter.isSplitter(target))) {
    throw new Error(`${target} is not a registered splitter`);
  }

  const { metrics, verdict } = await underwriter.evaluate(target, requestedPrincipal);
  report(target, metrics, verdict);

  if (!verdict.approved) {
    console.log("");
    console.log("  declined, no advance opened");
    return;
  }

  if (options.dryRun) {
    console.log("");
    console.log(`  dry run: not calling openLoan for ${target}`);
    return;
  }

  const { txHash, rationaleHash } = await underwriter.openLoan(target, requestedPrincipal, verdict);
  console.log(`  opened advance: ${txHash}`);
  console.log(`  rationaleHash: ${rationaleHash}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});