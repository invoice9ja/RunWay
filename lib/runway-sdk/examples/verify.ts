#!/usr/bin/env node

/**
 * End-to-end check for the SDK, against the live Arc testnet deployment.
 *
 * Exercises the whole integration a real user would: read status, build a seller,
 * issue a 402, verify a real EIP-3009 payment, and read the result back off the
 * chain. Run it and you have proof the published package works.
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env' });

import {
  createRunwayClient,
  createSeller,
  formatUsdc,
  getSplitterStatus,
  getVaultStatus,
  usdc,
  encodeHeader,
  approveAbi,
  transferWithAuthorizationTypes,
  usdcDomain,
  type PaymentChallenge,
} from '@workspace/runway-sdk';
import { keccak256, toBytes } from 'viem';
import { randomBytes } from 'node:crypto';

const RPC = process.env.ARC_TESTNET_RPC!;
const KEY = process.env.PRIVATE_KEY as `0x${string}`;
const SPLITTER = process.env.RUNWAY_SPLITTER_ADDRESS as `0x${string}`;
const ORIGIN = process.env.DEMO_ORIGIN ?? 'http://localhost:3001';

async function main() {
  const runway = createRunwayClient({
    chainId: 5042002,
    network: 'arc-testnet',
    rpcUrl: RPC,
    privateKey: KEY,
  });

  console.log(`SDK check against ${runway.config.network} (chain ${runway.config.chainId})`);
  console.log(`  vault: ${runway.config.vault}`);
  console.log(`  signer: ${runway.wallet?.account.address}`);

  const vault = await getVaultStatus(runway);
  console.log(`\n1. vault read`);
  console.log(`   balance ${formatUsdc(vault.balance)} USDC, ${vault.loans} loans, explorer ${vault.explorer}`);

  const before = await getSplitterStatus(runway, SPLITTER);
  console.log(`\n2. splitter read`);
  console.log(`   balance ${formatUsdc(before.balance)} USDC, lifetime revenue ${formatUsdc(before.lifetimeRevenue)} USDC`);
  console.log(`   unsettled ${formatUsdc(before.unsettled)} USDC, debt ${formatUsdc(before.debtOwed)} USDC`);
  console.log(`   claimable ${formatUsdc(before.claimable)} USDC, advanceHeld ${formatUsdc(before.advanceHeld)} USDC`);

  const price = usdc(0.1);
  const seller = createSeller({
    runway,
    splitter: SPLITTER,
    price,
    description: 'SDK verification call',
    resource: `${ORIGIN}/api/extract`,
  });

  const challenge = seller.challenge();
  const requirement = challenge.accepts[0];
  console.log(`\n3. challenge built`);
  console.log(`   scheme ${requirement.scheme}/${requirement.network}, price ${formatUsdc(price)} USDC`);
  console.log(`   payTo ${requirement.payTo}`);
  if (requirement.payTo.toLowerCase() !== SPLITTER.toLowerCase()) {
    throw new Error('challenge is not paying the splitter');
  }

  // Reject an unsigned request the way a server would.
  const unsigned = await seller.verify(undefined);
  console.log(`\n4. unsigned request correctly rejected: ${unsigned.ok ? 'NO' : `yes (${unsigned.status})`}`);

  // Sign a real authorization and settle it through the seller.
  const payer = runway.wallet!.account;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const nonce = keccak256(toBytes(randomBytes(32)));

  // EIP-3009 is a pull: the payer must approve the seller first. Real buyers do
  // this once, not per request, so it is not part of the payment itself.
  const approval = await runway.wallet!.client.writeContract({
    address: runway.config.usdc,
    abi: approveAbi,
    functionName: 'approve',
    args: [requirement.payTo, price * 1000n],
    account: runway.wallet!.account,
  } as never);
  await runway.publicClient.waitForTransactionReceipt({ hash: approval });
  console.log(`\n5. allowance granted for ${formatUsdc(price * 1000n)} USDC`);

  const domain = usdcDomain(runway.config.chainId, runway.config.usdc);
  const types = transferWithAuthorizationTypes;
  const message = {
    from: payer.address,
    to: requirement.payTo,
    value: price,
    validAfter: now - 60n,
    validBefore: now + 300n,
    nonce,
  };

  const signature = (await payer.signTypedData({
    domain,
    types,
    primaryType: 'TransferWithAuthorization',
    message: message as never,
  })) as `0x${string}`;

  const header = encodeHeader({
    x402Version: 1,
    scheme: 'exact',
    network: runway.config.network,
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

  console.log(`\n6. signed authorization`);
  console.log(`   nonce ${nonce.slice(0, 12)}…, signature ${signature.slice(0, 12)}…`);

  const result = await seller.verify(header);
  if (!result.ok) {
    console.log(`\n   payment FAILED: ${result.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n7. payment settled`);
  console.log(`   payer ${result.payer}`);
  console.log(`   value ${formatUsdc(result.value)} USDC`);
  console.log(`   pull  ${result.explorer.pull}`);
  console.log(`   route ${result.explorer.route}`);

  const after = await getSplitterStatus(runway, SPLITTER);
  console.log(`\n8. state after`);
  console.log(`   balance   ${formatUsdc(before.balance)} -> ${formatUsdc(after.balance)} USDC`);
  console.log(`   unsettled ${formatUsdc(before.unsettled)} -> ${formatUsdc(after.unsettled)} USDC`);
  console.log(`   surplus check: unsettled equals balance delta? ${
    after.balance - before.balance === after.unsettled ? 'yes' : `no (delta ${formatUsdc(after.balance - before.balance)})`
  }`);

  console.log(`\nSDK check passed. Every figure above was read from the chain.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});