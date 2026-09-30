#!/bin/bash

# Simple Keeper using cast
# Run: ./keeper.sh

set -e

# Never hardcode a key. Load it from the environment or an untracked .env.
if [ -z "${RUNWAY_PRIVATE_KEY:-}" ] && [ -f "$(dirname "$0")/../.env" ]; then
  set -a; . "$(dirname "$0")/../.env"; set +a
fi
: "${RUNWAY_PRIVATE_KEY:?Set RUNWAY_PRIVATE_KEY (or add it to .env) before running this script}"

NETWORK="base-sepolia"
RPC_URL="https://sepolia.base.org"
PRIVATE_KEY="${RUNWAY_PRIVATE_KEY:-}"
FACTORY_ADDRESS="0xC278850c7194a8ecD8b81A223847F995Ad56fCdf"
SETTLE_THRESHOLD=100000  # 0.1 USDC (6 decimals) - lowered for testing
INTERVAL=300  # 5 minutes in seconds

echo "Starting Keeper on base-sepolia"
echo "Factory: $FACTORY_ADDRESS"
echo "Settle threshold: $SETTLE_THRESHOLD USDC"
echo "Poll interval: ${INTERVAL}s"

settle_all() {
  echo ""
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Checking splitters..."
  
  # Get splitter count
  COUNT=$(cast call $FACTORY_ADDRESS "getSplittersCount()" --rpc-url https://sepolia.base.org 2>/dev/null)
  COUNT_DEC=$(cast --to-dec $COUNT)
  echo "Splitter count: $COUNT_DEC"
  
  if [ "$COUNT_DEC" -eq 0 ]; then
    echo "No splitters found"
    return
  fi
  
  # Get all splitters - parse the hex output
  SPLITTERS_RAW=$(cast call $FACTORY_ADDRESS "getAllSplitters()" --rpc-url https://sepolia.base.org 2>/dev/null)
  # Extract the last 40 hex chars (address) from the hex output
  # The output is hex-encoded, we need to get the last 40 chars and add 0x prefix
  SPLITTER_HEX=$(echo "$SPLITTERS_RAW" | sed 's/.*\([a-fA-F0-9]\{40\}\)$/\1/')
  SPLITTER_ADDR="0x$SPLITTER_HEX"
  echo "Splitter address: $SPLITTER_ADDR"
  
  if [ -z "$SPLITTER_ADDR" ] || [ "$SPLITTER_ADDR" = "0x" ]; then
    echo "Could not parse splitter address"
    return
  fi
  
  # Check unsettled revenue
  UNSETTLED_RAW=$(cast call $SPLITTER_ADDR "getUnsettledRevenue()" --rpc-url https://sepolia.base.org 2>/dev/null)
  UNSETTLED=$(cast --to-dec $UNSETTLED_RAW)
  
  BALANCE_RAW=$(cast call $SPLITTER_ADDR "getBalance()" --rpc-url https://sepolia.base.org 2>/dev/null)
  BALANCE=$(cast --to-dec $BALANCE_RAW)
  
  echo "Splitter: $SPLITTER_ADDR, balance: $BALANCE, unsettled: $UNSETTLED"
  
  if [ "$UNSETTLED" -ge "$SETTLE_THRESHOLD" ]; then
    echo "Settling $SPLITTER_ADDR: $UNSETTLED unsettled"
    # Use cast to send the settle transaction
    cast send $SPLITTER_ADDR "settle()" --private-key $PRIVATE_KEY --rpc-url https://sepolia.base.org
    echo "✓ Settled"
  elif [ "$UNSETTLED" -gt 0 ]; then
    echo "Skipping: $UNSETTLED USDC below threshold"
  fi
}

# Run immediately
settle_all

# Then run on interval
while true; do
  sleep 300
  settle_all
done