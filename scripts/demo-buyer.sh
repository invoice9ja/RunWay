#!/usr/bin/env bash
# Demo Buyer - exercises the real x402 path against the hosted seller.
#
# Flow: request the resource -> receive a 402 with payment requirements ->
# sign an EIP-3009 authorization -> the facilitator settles it on-chain and
# forwards USDC to the agent's splitter.
#
# The earlier version of this script was hardcoded to Base Sepolia against an
# abandoned splitter and simply transferred USDC, which is not x402 and proved
# nothing. This one drives the real endpoint.
#
# Run: ./scripts/demo-buyer.sh [amount_usdc]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-runway-config.sh
. "$SCRIPT_DIR/lib-runway-config.sh"

PRICE="${RUNWAY_DEMO_PRICE:-100000}"

# Pass settle=0 to leave the payment unsettled so scripts/keeper.sh can route it.
SETTLE="${SETTLE:-1}"

echo "Demo Buyer (x402)"
banner

echo "Fetching payment requirements from $RUNWAY_URL/api/demo/sell"
echo

# The 402 carries the payment requirements. Save headers and body separately so
# the challenge can be inspected without hiding a failure behind curl's output.
HDR=$(mktemp); BODY=$(mktemp)
trap 'rm -f "$HDR" "$BODY"' EXIT

STATUS=$(curl -sS -D "$HDR" -o "$BODY" -w '%{http_code}' \
  -H "Accept: application/json" \
  "$RUNWAY_URL/api/demo/sell" || true)

if [ "$STATUS" != "402" ]; then
  echo "Expected HTTP 402 from the seller, got $STATUS." >&2
  echo "The x402 challenge is the whole point of this script; something is wrong." >&2
  echo "--- response ---" >&2
  head -c 600 "$BODY" >&2
  echo >&2
  exit 1
fi

echo "  HTTP $STATUS as expected"
echo
echo "Challenge:"
python3 - "$BODY" <<'PY'
import json, sys
with open(sys.argv[1]) as fh:
    doc = json.load(fh)
accepts = (doc.get('accepts') or [{}])[0]
for label, key in (
    ('resource', 'resource'), ('network', 'network'), ('asset', 'asset'),
    ('max amount', 'maxAmountRequired'), ('mime', 'mimeType'),
    ('payTo', 'payTo'), ('maxTimeout', 'maxTimeoutSeconds'),
):
    value = accepts.get(key)
    if value not in (None, ''):
        print(f'  {label:12} {value}')
PY
echo

# Settling needs a funded payer. The hosted /api/demo/buy does the signing and
# submission server-side using the configured settler key.
require_key RUNWAY_KEEPER_SECRET "It authorises /api/demo/buy."
require_key RUNWAY_PRIVATE_KEY "It signs the EIP-3009 authorization."

BUYER=$(cast wallet address --private-key "$RUNWAY_PRIVATE_KEY")
BAL_RAW=$(cast call "$USDC" "balanceOf(address)" "$BUYER" --rpc-url "$RPC_URL" | strip)
echo "Payer $BUYER holds $(usdc_fmt "$BAL_RAW") USDC"
echo

if [ "$BAL_RAW" = "0" ]; then
  echo "Payer has no USDC. Fund it on Arc testnet first." >&2
  exit 1
fi

echo "Requesting settlement from $RUNWAY_URL/api/demo/buy"
RESULT=$(curl -sS -X POST -H "Authorization: Bearer $RUNWAY_KEEPER_SECRET" \
  -H "Content-Type: application/json" \
  -d "{\"amount\":\"$PRICE\"}" \
  "$RUNWAY_URL/api/demo/buy?settle=$SETTLE" || true)

echo
python3 - "$RESULT" <<'PY'
import json, sys
raw = sys.argv[1]
try:
    doc = json.loads(raw)
except Exception:
    print('  non-JSON response:', raw[:400]); raise SystemExit(1)
if doc.get('error'):
    print('  error:', doc['error'])
    for k in ('detail', 'reason'):
        if doc.get(k): print(f'  {k}:', str(doc[k])[:300])
    raise SystemExit(1)
for key in ('ok', 'paid', 'payer', 'payTo', 'amount', 'settled', 'txHash', 'splitter'):
    if key in doc:
        print(f'  {key:9} {doc[key]}')
PY

echo
echo "Splitter balance after payment:"
BAL_RAW=$(cast call "$USDC" "balanceOf(address)" "$SPLITTER" --rpc-url "$RPC_URL" | strip)
echo "  $SPLITTER  $(usdc_fmt "$BAL_RAW") USDC"
UNSETTLED=$(cast call "$SPLITTER" "getUnsettledRevenue()(uint256)" --rpc-url "$RPC_URL" | strip)
echo "  unsettled  $(usdc_fmt "$UNSETTLED") USDC"
echo
if [ "$SETTLE" = "0" ]; then
  echo "Left unsettled (settle=0). Run scripts/keeper.sh to route it to the vault."
else
  echo "Settled automatically by /api/demo/buy: the vault and the agent split it."
  echo "Run SETTLE=0 ./scripts/demo-buyer.sh to exercise the keeper instead."
fi