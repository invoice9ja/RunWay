#!/bin/bash

# Demo Seller - x402 protected endpoint simulator
# Run: ./demo-seller.sh

set -e

# Never hardcode a key. Load it from the environment or an untracked .env.
if [ -z "${RUNWAY_PRIVATE_KEY:-}" ] && [ -f "$(dirname "$0")/../.env" ]; then
  set -a; . "$(dirname "$0")/../.env"; set +a
fi
: "${RUNWAY_PRIVATE_KEY:?Set RUNWAY_PRIVATE_KEY (or add it to .env) before running this script}"

RPC_URL="https://sepolia.base.org"
PRIVATE_KEY="${RUNWAY_PRIVATE_KEY:-}"
SPLITTER_ADDRESS="0x96030e714e14b848445b40dfc327d828a3f474f6"
USDC_ADDRESS="0x036CbD53842c5426634e7929541eC2318f3dCF7e"
PORT=3001

echo "Starting Demo Seller on port $PORT"
echo "Splitter: $SPLITTER_ADDRESS"
echo "USDC: $USDC_ADDRESS"

# Simple HTTP server using netcat/socat or python
# For now, just show the endpoint info
echo ""
echo "=== Demo Seller Endpoints ==="
echo "GET  http://localhost:$PORT/health"
echo "GET  http://localhost:$PORT/.well-known/x402"
echo "GET  http://localhost:$PORT/api/extract (requires x402 payment)"
echo "POST http://localhost:$PORT/api/process (requires x402 payment)"
echo ""
echo "Payment required: 100000 USDC (0.1 USDC)"
echo "Pay to: $SPLITTER_ADDRESS"
echo "Asset: USDC ($USDC_ADDRESS)"
echo ""
echo "Note: This is a demo. In production, use a proper x402 facilitator."
echo ""
echo "To test with cast:"
echo "  cast send $SPLITTER_ADDRESS \"\" --value 0 --rpc-url https://sepolia.base.org --private-key <key> --data <calldata>"
echo ""
echo "Or use the demo buyer script to generate traffic."
echo ""
echo "Waiting for demo buyer to send payments..."

# Keep running
while true; do
  sleep 60
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Demo seller running..."
done