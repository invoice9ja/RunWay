#!/usr/bin/env bash
# Demo Seller - shows what an agent exposes to x402 buyers and where the money goes.
#
# A seller publishes a resource, advertises payment requirements in a 402, and
# receives USDC on settlement. That receipt is forwarded to the agent's splitter,
# which repays the vault its share automatically.
#
# Run: ./scripts/demo-seller.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-runway-config.sh
. "$SCRIPT_DIR/lib-runway-config.sh"

echo "Demo Seller ($NETWORK)"
banner

RESOURCE="${RUNWAY_URL}/api/x402/resource"
SELL_ENDPOINT="${RUNWAY_URL}/api/demo/sell"

echo "Published resource"
echo "  url        $RESOURCE"
echo "  price      $(usdc_fmt "$(cast call "$USDC" "decimals()(uint8)" --rpc-url "$RPC_URL" >/dev/null 2>&1 && echo "${RUNWAY_DEMO_PRICE:-100000}")") USDC"
echo

echo "Discovery document (what a buyer fetches first)"
echo "  GET $SELL_ENDPOINT"
echo
HDR=$(mktemp); BODY=$(mktemp)
trap 'rm -f "$HDR" "$BODY"' EXIT
STATUS=$(curl -sS -D "$HDR" -o "$BODY" -w '%{http_code}' -H "Accept: application/json" "$SELL_ENDPOINT" || true)

if [ "$STATUS" != "402" ]; then
  echo "  expected HTTP 402, got $STATUS" >&2
  head -c 400 "$BODY" >&2; echo >&2
  exit 1
fi

python3 - "$BODY" <<'PY'
import json, sys
with open(sys.argv[1]) as fh:
    doc = json.load(fh)
accepts = (doc.get('accepts') or [{}])[0]
for label, key in (('resource','resource'), ('network','network'), ('asset','asset'),
                   ('maxAmountRequired','maxAmountRequired'), ('mimeType','mimeType'),
                   ('description','description')):
    v = accepts.get(key)
    if v not in (None, ''):
        print(f'  {label:18} {v}')
scheme = doc.get('scheme') or {}
if isinstance(scheme, dict):
    for k in ('network', 'maxAmountRequired', 'resource'):
        if scheme.get(k) not in (None, ''):
            print(f'  scheme.{k:12} {scheme[k]}')
PY
echo
echo "  HTTP $STATUS, payment required: correct for x402."
echo

echo "Where the payment goes"
printf "  %-22s %s\n" "settles into" "${SPLITTER}"
printf "  %-22s %s\n" "agent" "$(_j .roles.agent.address)"
printf "  %-22s %s\n" "vault" "$VAULT"
echo
echo "  On settle() the vault takes its share of outstanding debt, capped at what it is"
echo "  owed; the agent keeps the rest. Both are computed on-chain, not by the seller."
echo

echo "Current state"
BAL=$(cast call "$USDC" "balanceOf(address)" "$SPLITTER" --rpc-url "$RPC_URL" | strip)
UNSET=$(cast call "$SPLITTER" "getUnsettledRevenue()(uint256)" --rpc-url "$RPC_URL" | strip)
CLAIM=$(cast call "$SPLITTER" "getAgentOwed()(uint256)" --rpc-url "$RPC_URL" | strip)
OWED=$(cast call "$SPLITTER" "getDebtOwed()(uint256)" --rpc-url "$RPC_URL" | strip)
printf "  %-22s %s\n" "splitter balance" "$(usdc_fmt "$BAL") USDC"
printf "  %-22s %s\n" "unsettled" "$(usdc_fmt "$UNSET") USDC"
printf "  %-22s %s\n" "agent claimable" "$(usdc_fmt "$CLAIM") USDC"
printf "  %-22s %s\n" "owed to vault" "$(usdc_fmt "$OWED") USDC"
echo
echo "  see the contract: $EXPLORER/address/$SPLITTER"
echo "  buy it:          SETTLE=0 ./scripts/demo-buyer.sh"
echo "  settle it:       ./scripts/keeper.sh"