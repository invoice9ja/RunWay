import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
loadEnv({ path: resolve(import.meta.dirname, '../../../.env') });

import {
  createRunwayClient,
  encodeHeader,
  transferWithAuthorizationTypes,
  usdcDomain,
  erc20Abi,
  formatUsdc,
  type PaymentChallenge,
} from '@workspace/runway-sdk';
import { keccak256, toBytes } from 'viem';
import { randomBytes } from 'node:crypto';

const ORIGIN = process.env.DEMO_ORIGIN ?? 'https://runwaay-ivory.vercel.app';

async function main() {
  const runway = createRunwayClient({
    chainId: Number(process.env.RUNWAY_CHAIN_ID ?? 5042002),
    network: process.env.RUNWAY_NETWORK ?? 'arc-testnet',
    rpcUrl: process.env.RUNWAY_RPC_URL!,
    vault: process.env.RUNWAY_VAULT_ADDRESS as `0x${string}`,
    privateKey: (process.env.BUYER_PRIVATE_KEY ?? process.env.PRIVATE_KEY) as `0x${string}`,
  });

  const challengeUrl = `${ORIGIN}/api/demo/sell-x402`;
  const unpaid = await fetch(challengeUrl, { method: 'POST' });
  console.log(`  step 1  challenge status ${unpaid.status}`);

  const challenge = (await unpaid.json()) as PaymentChallenge;
  const requirement = challenge.accepts[0];
  const resource = requirement.resource;
  const price = BigInt(requirement.maxAmountRequired);
  console.log(
    `  step 2  ${requirement.scheme}/${requirement.network} ${formatUsdc(price)} USDC -> ${requirement.payTo}`,
  );

  const payer = runway.wallet!.account;
  console.log(`  payer   ${payer.address}`);

  const allowance = (await runway.publicClient.readContract({
    address: runway.config.usdc,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [payer.address, requirement.payTo],
  })) as bigint;

  if (allowance < price) {
    const approval = await runway.wallet!.client.writeContract({
      address: runway.config.usdc,
      abi: erc20Abi,
      functionName: 'approve',
      args: [requirement.payTo, price * 1000n],
      account: payer,
    } as never);
    await runway.publicClient.waitForTransactionReceipt({ hash: approval });
    console.log(`  step 3  approved ${formatUsdc(price * 1000n)} USDC allowance`);
  } else {
    console.log(`  step 3  allowance already sufficient (${formatUsdc(allowance)} USDC)`);
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  const message = {
    from: payer.address,
    to: requirement.payTo,
    value: price,
    validAfter: now - 60n,
    validBefore: now + BigInt(requirement.maxTimeoutSeconds),
    nonce: keccak256(toBytes(randomBytes(32))),
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

  const paid = await fetch(resource, { headers: { 'X-PAYMENT': header } });
  const body = await paid.text();
  console.log(`  step 5  resource status ${paid.status}`);
  console.log(`  response header: ${paid.headers.get('x-payment-response') ?? 'none'}`);
  console.log(`  body: ${body.slice(0, 400)}`);
  if (paid.status !== 200) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
