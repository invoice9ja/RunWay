/**
 * Split an EIP-712 signature into the parts USDC's transferWithAuthorization wants.
 *
 * Arc testnet USDC takes `v` as a separate uint8 alongside `r` and `s`
 * (selector 0xe3ee160e), not one `bytes` signature argument. v must be 27 or 28:
 * wallets and viem return 0 or 1, and ecrecover rejects the low form with
 * "invalid signature 'v' value".
 */
export function splitSignature(signature: `0x${string}`): readonly [number, `0x${string}`, `0x${string}`] {
  const body = signature.slice(2);
  const r = `0x${body.slice(0, 64)}` as `0x${string}`;
  const s = `0x${body.slice(64, 128)}` as `0x${string}`;
  const raw = Number.parseInt(body.slice(128, 130), 16);
  const v = raw >= 27 ? raw : raw + 27;
  return [v, r, s] as const;
}
