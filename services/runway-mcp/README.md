# RunWay MCP server

Exposes RunWay's revenue-routed working capital as [MCP](https://modelcontextprotocol.io)
tools, so an autonomous agent can manage its own financing over stdio — no human,
no dashboard.

The server wraps [`@workspace/runway-sdk`](../../lib/runway-sdk). Anything the SDK
can do, an agent can do here as a tool call.

## Tools

| Tool | Kind | What it does |
|------|------|--------------|
| `runway_position` | read | The agent's balance sheet: lifetime revenue, unsettled revenue, claimable cash, unspent advance, debt owed, loan active. |
| `runway_settle` | write | Route new revenue: lender share repays the advance first, the rest is credited to the agent. Permissionless. |
| `runway_withdraw` | write | Claim everything the splitter owes the agent (revenue, then unspent working capital). |
| `runway_request_advance` | write | Ask the **hosted underwriter** for working capital. The agent never approves its own advance. |
| `runway_pay` | write | Consume another agent's x402 endpoint: read the 402, sign EIP-3009, approve once, retry with `X-PAYMENT`. |

## Why `request_advance` calls an underwriter

The vault gates `openLoan` behind `UNDERWRITER_ROLE`. A borrower holding that role
would be approving its own credit, which defeats the point of underwriting. So this
tool forwards the request to the hosted underwriter (`RUNWAY_UNDERWRITER_URL`),
which scores the splitter and opens the loan only if it passes.

## Configuration

Copy `.env.example` to `.env` and fill it in:

```bash
ARC_TESTNET_RPC=https://rpc.testnet.arc.network
AGENT_PRIVATE_KEY=0x...        # AGENT_ROLE on the splitter; settle + withdraw
RUNWAY_SPLITTER=0x...          # so tools can omit `splitter`
RUNWAY_UNDERWRITER_URL=        # hosted underwriter for advances
RUNWAY_UNDERWRITER_SECRET=
```

The agent key needs `AGENT_ROLE` on the splitter. It does **not** need
`UNDERWRITER_ROLE`.

## Run

```bash
pnpm --filter @workspace/runway-mcp start
```

It speaks newline-delimited JSON-RPC on stdin/stdout. Nothing is written to stdout
except the protocol; logs go to stderr.

### Claude Desktop / Claude Code / Cursor

```json
{
  "mcpServers": {
    "runway": {
      "command": "pnpm",
      "args": ["--filter", "@workspace/runway-mcp", "start"],
      "cwd": "/path/to/RunWay"
    }
  }
}
```

## What it does not do

- **It does not approve credit.** Advances go through the underwriter and the
  on-chain cap; this server only asks.
- **It does not custody funds.** USDC moves payer → splitter → lender/agent.
- **It holds the agent's key** to settle and withdraw. On mainnet that key belongs
  on the agent host, scoped to `AGENT_ROLE` only.