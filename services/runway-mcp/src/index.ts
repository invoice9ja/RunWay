#!/usr/bin/env node

/**
 * RunWay MCP server.
 *
 * Exposes the revenue-financing operations an autonomous agent needs as MCP
 * tools over stdio, so any agent runtime (Claude Desktop, Claude Code, Cursor,
 * a custom loop) can manage its own working capital as tool calls.
 *
 * The tools wrap @workspace/runway-sdk. Read and permissionless operations use
 * the agent's own key; `runway_request_advance` deliberately does NOT open a
 * loan itself - the vault gates `openLoan` behind UNDERWRITER_ROLE, so the tool
 * forwards the request to the hosted underwriter, which is the only party that
 * should be able to approve credit. A borrower approving its own advance would
 * defeat the point of underwriting.
 *
 * Transport is stdio. Nothing may be written to stdout except the protocol;
 * all logging goes to stderr.
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env' });

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { type Address } from 'viem';
import {
  createRunwayClient,
  getSplitterStatus,
  settle,
  withdraw,
  formatUsdc,
  usdc,
  approveAbi,
  encodeHeader,
  transferWithAuthorizationTypes,
  usdcDomain,
  type PaymentChallenge,
} from '@workspace/runway-sdk';

const log = (...args: unknown[]) => console.error('[runway-mcp]', ...args);

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

const RPC_URL = env('RUNWAY_RPC_URL') ?? env('ARC_MAINNET_RPC') ?? env('ARC_TESTNET_RPC');
const PRIVATE_KEY = (env('AGENT_PRIVATE_KEY') ?? env('PRIVATE_KEY')) as `0x${string}` | undefined;
const DEFAULT_SPLITTER = env('RUNWAY_SPLITTER') as Address | undefined;

/**
 * Build a Runway client. Write tools require the key and fail loudly without it
 * rather than sending an unsigned call and surfacing a confusing RPC error.
 */
function client(needsWallet = false) {
  if (!RPC_URL) throw new Error('RUNWAY_RPC_URL (or ARC_MAINNET_RPC / ARC_TESTNET_RPC) is required');
  if (needsWallet && !PRIVATE_KEY) {
    throw new Error('AGENT_PRIVATE_KEY (or PRIVATE_KEY) is required for write tools');
  }
  return createRunwayClient({
    chainId: Number(env('RUNWAY_CHAIN_ID') ?? 5042002),
    network: env('RUNWAY_NETWORK') ?? 'arc-testnet',
    rpcUrl: RPC_URL,
    // Addresses are only defaulted by the SDK on testnet; on any other chain
    // they must be supplied, so these names are the contract.
    usdc: (env('RUNWAY_USDC') ?? env('RUNWAY_USDC_ADDRESS')) as Address | undefined,
    factory: (env('RUNWAY_FACTORY') ?? env('RUNWAY_FACTORY_ADDRESS')) as Address | undefined,
    vault: (env('RUNWAY_VAULT') ?? env('RUNWAY_VAULT_ADDRESS')) as Address | undefined,
    privateKey: needsWallet ? PRIVATE_KEY : undefined,
  });
}

function resolveSplitter(splitter?: string): Address {
  const value = splitter ?? DEFAULT_SPLITTER;
  if (!value) {
    throw new Error('No splitter: pass `splitter` in the call or set RUNWAY_SPLITTER');
  }
  return value as Address;
}

/** Every tool returns text; failures return isError instead of throwing so the model can recover. */
function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true as const, content: [{ type: 'text' as const, text: message }] };
}

const server = new McpServer({ name: 'runway', version: '0.1.0' });

// --------------------------------------------------------------------------
// Read: the agent's position
// --------------------------------------------------------------------------
server.registerTool(
  'runway_position',
  {
    title: 'Runway position',
    description:
      "Read the agent's revenue-financing position from its splitter: lifetime revenue, " +
      'unsettled revenue, claimable cash, unspent advance, debt owed, and whether a loan is active. ' +
      'Use this before deciding to settle, withdraw, or request an advance.',
    inputSchema: {
      splitter: z.string().optional().describe('Splitter address; defaults to RUNWAY_SPLITTER'),
    },
  },
  async ({ splitter }) => {
    try {
      const status = await getSplitterStatus(client(), resolveSplitter(splitter));
      const lines = [
        `splitter          ${status.address}`,
        `agent             ${status.agent}`,
        `payout            ${status.payout}`,
        `lender share      ${status.shareBps / 100}%`,
        `balance           ${formatUsdc(status.balance)} USDC`,
        `lifetime revenue  ${formatUsdc(status.lifetimeRevenue)} USDC`,
        `unsettled revenue ${formatUsdc(status.unsettled)} USDC`,
        `claimable (agent) ${formatUsdc(status.claimable)} USDC`,
        `unspent advance   ${formatUsdc(status.advanceHeld)} USDC`,
        `owed to agent     ${formatUsdc(status.agentOwed)} USDC`,
        `debt owed         ${formatUsdc(status.debtOwed)} USDC`,
        `loan active       ${status.loanActive ? 'yes' : 'no'}`,
        `explorer          ${status.explorer}`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return fail(error);
    }
  },
);

// --------------------------------------------------------------------------
// Write: settle revenue (permissionless)
// --------------------------------------------------------------------------
server.registerTool(
  'runway_settle',
  {
    title: 'Settle revenue',
    description:
      'Route revenue that has landed in the splitter since the last settle: the lender share ' +
      'repays the outstanding advance first, the rest is credited to the agent. ' +
      'settle() is permissionless, so the agent can call it (or a keeper does).',
    inputSchema: {
      splitter: z.string().optional().describe('Splitter address; defaults to RUNWAY_SPLITTER'),
    },
  },
  async ({ splitter }) => {
    try {
      const result = await settle(client(true), resolveSplitter(splitter));
      return {
        content: [{ type: 'text', text: `settled\ntx: ${result.explorer}` }],
      };
    } catch (error) {
      return fail(error);
    }
  },
);

// --------------------------------------------------------------------------
// Write: withdraw the agent's money
// --------------------------------------------------------------------------
server.registerTool(
  'runway_withdraw',
  {
    title: 'Withdraw agent funds',
    description:
      'Claim everything the splitter owes the agent - earned revenue first, then any unspent ' +
      'working capital from an advance. Sent to the splitter payout address; caller must hold AGENT_ROLE.',
    inputSchema: {
      splitter: z.string().optional().describe('Splitter address; defaults to RUNWAY_SPLITTER'),
    },
  },
  async ({ splitter }) => {
    try {
      const result = await withdraw(client(true), resolveSplitter(splitter));
      return {
        content: [{ type: 'text', text: `withdrawn\ntx: ${result.explorer}` }],
      };
    } catch (error) {
      return fail(error);
    }
  },
);

// --------------------------------------------------------------------------
// Write: request an advance (via the hosted underwriter)
// --------------------------------------------------------------------------
server.registerTool(
  'runway_request_advance',
  {
    title: 'Request an advance',
    description:
      'Ask the hosted underwriter for working capital against future revenue. The underwriter ' +
      'scores the splitter and, if approved, opens the loan on-chain. The agent cannot approve ' +
      'its own advance; this tool forwards the request and returns the decision and reasons.',
    inputSchema: {
      principal: z.number().positive().describe('Requested principal in USDC, e.g. 10 for 10 USDC'),
      rationale: z
        .string()
        .optional()
        .describe('Why the agent needs the capital, e.g. "buy more inference capacity". Committed on-chain.'),
      splitter: z.string().optional().describe('Splitter address; defaults to RUNWAY_SPLITTER'),
    },
  },
  async ({ principal, rationale, splitter }) => {
    try {
      const endpoint = env('RUNWAY_UNDERWRITER_URL');
      if (!endpoint) {
        throw new Error(
          'RUNWAY_UNDERWRITER_URL is not set. The advance must be approved by the hosted ' +
            'underwriter; point this env var at it.',
        );
      }
      const target = resolveSplitter(splitter);
      const secret = env('RUNWAY_UNDERWRITER_SECRET');
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify({
          splitter: target,
          principal: usdc(principal).toString(),
          rationale: rationale ?? 'runway-mcp advance request',
        }),
      });

      const body = await readBody(response.body);
      if (!response.ok) {
        return fail(new Error(`underwriter returned ${response.status}: ${body}`));
      }
      return {
        content: [
          { type: 'text', text: `underwriter decision for ${target}:\n${body}` },
        ],
      };
    } catch (error) {
      return fail(error);
    }
  },
);

// --------------------------------------------------------------------------
// Write: pay another agent's x402 endpoint (the agent as a buyer)
// --------------------------------------------------------------------------
server.registerTool(
  'runway_pay',
  {
    title: 'Pay an x402 endpoint',
    description:
      'Consume another agent or API that charges per call over x402. Reads the 402 challenge, ' +
      'signs an EIP-3009 authorization, approves USDC once if needed, and retries with X-PAYMENT. ' +
      'Use this when the agent needs to buy a service to do its own work.',
    inputSchema: {
      url: z.string().url().describe('The x402-protected endpoint to fetch'),
    },
  },
  async ({ url }) => {
    try {
      const runway = client(true);
      const payer = runway.wallet!.account;

      const unpaid = await fetch(url);
      if (unpaid.status !== 402) {
        const body = await unpaid.text();
        return {
          content: [
            { type: 'text', text: `${url} did not require payment (status ${unpaid.status}):\n${body}` },
          ],
        };
      }

      const challenge = (await unpaid.json()) as PaymentChallenge;
      const requirement = challenge.accepts[0];
      const price = BigInt(requirement.maxAmountRequired);
      const payTo = requirement.payTo as Address;

      // Pull-based EIP-3009 needs an allowance to the seller. Check first so a
      // repeat buyer does not pay gas for an approval it already has.
      const current = (await runway.publicClient.readContract({
        address: runway.config.usdc,
        abi: [
          {
            type: 'function',
            name: 'allowance',
            stateMutability: 'view',
            inputs: [
              { name: 'owner', type: 'address' },
              { name: 'spender', type: 'address' },
            ],
            outputs: [{ name: '', type: 'uint256' }],
          },
        ] as const,
        functionName: 'allowance',
        args: [payer.address, payTo],
      })) as bigint;

      if (current < price) {
        const approval = await runway.wallet!.client.writeContract({
          address: runway.config.usdc,
          abi: approveAbi,
          functionName: 'approve',
          args: [payTo, price * 1000n],
          account: payer,
        } as never);
        await runway.publicClient.waitForTransactionReceipt({ hash: approval });
      }

      const now = BigInt(Math.floor(Date.now() / 1000));
      const message = {
        from: payer.address,
        to: payTo,
        value: price,
        validAfter: now - 60n,
        validBefore: now + BigInt(requirement.maxTimeoutSeconds),
        nonce: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
      };

      const signature = (await payer.signTypedData({
        domain: usdcDomain(runway.config.chainId, runway.config.usdc),
        types: transferWithAuthorizationTypes,
        primaryType: 'TransferWithAuthorization',
        message: message as never,
      })) as `0x${string}`;

      const header = encodeHeader({
        x402Version: challenge.x402Version,
        scheme: 'exact',
        network: requirement.network,
        payload: {
          signature,
          authorization: {
            from: message.from,
            to: message.to,
            value: message.value.toString(),
            validAfter: message.validAfter.toString(),
            validBefore: message.validBefore.toString(),
            nonce: message.nonce,
          },
        },
      });

      const paid = await fetch(url, { headers: { 'X-PAYMENT': header } });
      const body = await paid.text();
      const receipt = paid.headers.get('x-payment-response') ?? 'none';
      return {
        content: [
          {
            type: 'text',
            text: `paid ${formatUsdc(price)} USDC to ${payTo}\nstatus: ${paid.status}\nreceipt: ${receipt}\n\n${body}`,
          },
        ],
      };
    } catch (error) {
      return fail(error);
    }
  },
);

async function readBody(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return '';
  return await new Response(stream).text();
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ready (rpc=${RPC_URL ? 'set' : 'missing'}, wallet=${PRIVATE_KEY ? 'set' : 'missing'}, splitter=${DEFAULT_SPLITTER ?? 'unset'})`);
}

main().catch((error) => {
  log('fatal', error);
  process.exit(1);
});