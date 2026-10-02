#!/usr/bin/env bash
# Keeper - settles unsettled revenue on every registered splitter.
#
# settle() splits whatever arrived since the last settlement: the lender's share
# is capped at what the vault is owed and repaid on-chain, the remainder becomes
# the agent's claimable balance. It is permissionless, so the keeper only needs
# gas, not a vault role.
#
# The hosted app runs this same logic on a daily cron at noon UTC (Vercel Hobby
# caps cron at daily). Use this script to settle on demand.
#
# Run: ./scripts/keeper.sh              # settle anything at or above threshold
#      THRESHOLD=0 ./scripts/keeper.sh  # settle everything
#      ./scripts/keeper.sh --dry-run    # report only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-runway-config.sh
. "$SCRIPT_DIR/lib-runway-config.sh"

THRESHOLD="${THRESHOLD:-100000}"   # 0.1 USDC
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 1 ;;
  esac
done

require_key RUNWAY_PRIVATE_KEY "The keeper signs settle() and needs gas."

echo "Keeper ($NETWORK)"
banner
echo "  threshold  $(usdc_fmt "$THRESHOLD") USDC"
[ "$DRY_RUN" = "1" ] && echo "  mode       dry run, no transactions"
echo

COUNT_RAW=$(cast call "$FACTORY" "splittersCount()(uint256)" --rpc-url "$RPC_URL" 2>/dev/null | strip || true)
if [ -z "$COUNT_RAW" ]; then
  COUNT_RAW=$(cast call "$FACTORY" "getSplittersCount()(uint256)" --rpc-url "$RPC_URL" | strip)
fi
COUNT=$(python3 -c "print(int('$COUNT_RAW'))")
echo "Registered splitters: $COUNT"
echo

LIST=$(cast call "$FACTORY" "getAllSplitters()(address[])" --rpc-url "$RPC_URL")
mapfile -t SPLITTERS < <(printf '%s' "$LIST" | grep -oE '0x[0-9a-fA-F]{40}')

SETTLED=0
SKIPPED=0

for S in "${SPLITTERS[@]}"; do
  AGENT=$(cast call "$S" "agent()(address)" --rpc-url "$RPC_URL" 2>/dev/null | strip || echo "0x0")
  BAL=$(cast call "$S" "getBalance()(uint256)" --rpc-url "$RPC_URL" 2>/dev/null | strip || echo 0)
  UNSETTLED=$(cast call "$S" "getUnsettledRevenue()(uint256)" --rpc-url "$RPC_URL" 2>/dev/null | strip || echo 0)
  OWED=$(cast call "$S" "getDebtOwed()(uint256)" --rpc-url "$RPC_URL" 2>/dev/null | strip || echo 0)

  printf "  %s agent %s\n" "$S" "${AGENT:0:10}"
  printf "      balance %s  unsettled %s  owed to vault %s\n" \
    "$(usdc_fmt "$BAL")" "$(usdc_fmt "$UNSETTLED")" "$(usdc_fmt "$OWED")"

  if [ "$UNSETTLED" = "0" ]; then
    echo "      nothing unsettled"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  if ! gte "$UNSETTLED" "$THRESHOLD"; then
    echo "      below threshold, skipping"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  if [ "$DRY_RUN" = "1" ]; then
    echo "      would settle $(usdc_fmt "$UNSETTLED") USDC"
    continue
  fi

  TX=$(cast send "$S" "settle()" --rpc-url "$RPC_URL" --private-key "$RUNWAY_PRIVATE_KEY" 2>&1 || true)
  if printf '%s' "$TX" | grep -q "status *1"; then
    HASH=$(printf '%s' "$TX" | grep -oE '0x[0-9a-fA-F]{64}' | head -1)
    echo "      settled, tx ${HASH:0:18}…  $EXPLORER/tx/$HASH"
    SETTLED=$((SETTLED + 1))
  else
    echo "      settle FAILED:"
    printf '%s\n' "$TX" | sed 's/^/        /' | head -4
  fi
done

echo
echo "settled $SETTLED, skipped $SKIPPED"
if [ "$SETTLED" -gt 0 ]; then
  echo
  echo "Agent can withdraw its share:"
  echo "  cast send $SPLITTER \"withdraw()\" --rpc-url $RPC_URL --private-key \$AGENT_PRIVATE_KEY"
fi