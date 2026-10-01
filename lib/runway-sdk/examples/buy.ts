#!/usr/bin/env node

/**
 * Buys from the demo seller over x402, end to end.
 *
 * Proves the seller integration works over HTTP rather than in-process: it reads
 * the 402, signs an EIP-3009 authorization against the USDC domain, retries with
 * X-PAYMENT, and prints the result the endpoint returns.
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env' });

import {
  createRunwayClient,
  encodeHeader,
  transferWithAuthorizationTypes,
  usdcDomain,
  approveAbi,
  formatUsdc,
  usdc,
  type PaymentChallenge,
} from '@workspace/runway-sdk';
import { keccak256, toBytes } from 'viem';
import { randomBytes } from 'node:crypto';

const ORIGIN = process.env.DEMO_ORIGIN ?? 'http://localhost:3011';

async function main() {
  const runway = createRunwayClient({
    chainId: Number(process.env.RUNWAY_CHAIN_ID ?? 5042002),
    network: process.env.RUNWAY_NETWORK ?? 'arc-testnet',
    rpcUrl: process.env.ARC_TESTNET_RPC!,
    privateKey: process.env.PRIVATE_KEY as `0x${string}`,
  });

  const url = `${ORIGIN}/api/extract`;
  console.log(`Buying from ${url}`);

  const unpaid = await fetch(url);
  console.log(`  step 1  status ${unpaid.status}`);

  const challenge = (await unpaid.json()) as PaymentChallenge;
  const requirement = challenge.accepts[0];
  console.log(`  step 2  ${requirement.scheme}/${requirement.network}, ${formatUsdc(BigInt(requirement.maxAmountRequired))} USDC to ${requirement.payTo}`);

  const payer = runway.wallet!.account;
  const price = BigInt(requirement.maxAmountRequired);

  // EIP-3009 pulls, so the payer must approve the seller first. A real buyer
  // does this once, not per request.
  const approval = await runway.wallet!.client.writeContract({
    address: runway.config.usdc,
    abi: approveAbi,
    functionName: 'approve',
    args: [requirement.payTo, price * 1000n],
    account: payer,
  } as never);
  await runway.publicClient.waitForTransactionReceipt({ hash: approval });
  console.log(`  step 3  approved ${formatUsdc(price * 1000n)} USDC allowance`);

  const now = BigInt(Math.floor(Date.now() / 1000));
  const nonce = keccak256(toBytes(randomBytes(32)));
  const message = {
    from: payer.address,
    to: requirement.payTo,
    value: price,
    validAfter: now - 60n,
    validBefore: now + BigInt(requirement.maxTimeoutSeconds),
    nonce,
  };

  const signature = (await payer.signTypedData({
    domain: usdcDomain(runway.config.chainId, runway.config.usdc),
    types: transferWithAuthorizationTypes,
    primaryType: 'TransferWithAuthorization',
    message: message as never,
  })) as `0x${string}`;
  console.log(`  step 4  signed EIP-3009 authorization`);

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
  } satisfies never);

  const paid = await fetch(url, { headers: { 'X-PAYMENT': header } });
  const body = await paid.text();
  console.log(`  step 5  status ${paid.status}`);
  console.log(`  payment response header: ${paid.headers.get('x-payment-response') ?? 'none'}`);
  console.log(`\n  result: ${body}`);

  if (paid.status !== 200) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});