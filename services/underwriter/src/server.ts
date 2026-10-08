import { config as dotenvConfig } from "dotenv";
import { resolve } from "node:path";

// Load the workspace-root .env regardless of the caller's CWD. The dev/typecheck
// entrypoints live three levels under the repo root (services/underwriter/{src,dist}).
dotenvConfig({ path: resolve(new URL(".", import.meta.url).pathname, "../../../.env") });

/**
 * HTTP front-end for the underwriter.
 *
 * The batch CLI in index.ts and this server share one scoring implementation
 * (core.ts). This endpoint is what the agent-facing MCP calls when it wants an
 * advance: it scores the splitter, and — only if approved and not in dry-run —
 * opens the loan.
 */

import http from "node:http";
import { isAddress } from "viem";
import { createUnderwriter, optionsFromEnv } from "./core.js";

const port = Number(process.env.UNDERWRITER_HTTP_PORT || "8787");

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(
    JSON.stringify(payload, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  );
}

async function main(): Promise<void> {
  const options = optionsFromEnv();
  const underwriter = await createUnderwriter(options);
  const secret = process.env.RUNWAY_UNDERWRITER_SECRET;

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || (req.url !== "/underwrite" && req.url !== "/")) {
        return send(res, 404, { error: "not found" });
      }

      if (secret && req.headers.authorization !== `Bearer ${secret}`) {
        return send(res, 401, { error: "unauthorized" });
      }

      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { error: "request body must be JSON" });
      }

      const splitter = body?.splitter;
      if (typeof splitter !== "string" || !isAddress(splitter)) {
        return send(res, 400, { error: "splitter must be a 0x-prefixed address" });
      }

      let principal: bigint;
      try {
        principal = BigInt(
          typeof body?.principal === "string" || typeof body?.principal === "number"
            ? String(body.principal)
            : process.env.UNDERWRITER_PRINCIPAL || "10000000",
        );
      } catch {
        return send(res, 400, { error: "principal must be an integer (base units)" });
      }
      if (principal <= 0n) return send(res, 400, { error: "principal must be positive" });

      const registered = await underwriter.isSplitter(splitter);
      if (!registered) {
        return send(res, 404, { error: `${splitter} is not a registered splitter` });
      }

      const { metrics, verdict } = await underwriter.evaluate(splitter, principal);

      let txHash: string | null = null;
      let rationaleHash: string | null = null;
      if (verdict.approved && !options.dryRun) {
        const result = await underwriter.openLoan(splitter, principal, verdict);
        txHash = result.txHash;
        rationaleHash = result.rationaleHash;
      }

      return send(res, 200, {
        splitter,
        approved: verdict.approved,
        score: verdict.score,
        source: verdict.source,
        reasons: verdict.reasons,
        rationale: verdict.rationale,
        requestedPrincipal: principal.toString(),
        metrics,
        dryRun: options.dryRun,
        txHash,
        rationaleHash,
      });
    } catch (error) {
      return send(res, 500, { error: (error as Error).message });
    }
  });

  server.listen(port, () => {
    console.log(`Underwriter HTTP on :${port}`);
    console.log(`  network: ${options.network}`);
    console.log(`  vault:   ${options.vaultAddress}`);
    console.log(`  dry run: ${options.dryRun}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
