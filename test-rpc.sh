#!/bin/bash

# Test script for DIG Network RPC Server
# This script demonstrates how to call the RPC server with curl

# RPC Server endpoint
RPC_URL="http://localhost:3141/rpc"

# Test URN (example from the server)
TEST_URN="urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/styles.css"

echo "Testing DIG Network RPC Server"
echo "================================"
echo ""
echo "Test URN: $TEST_URN"
echo ""

# Calculate SHA-256 hash of the URN
# Note: In a real implementation, you'd use a proper SHA-256 function
# For this example, we'll use openssl or a Node.js one-liner
echo "Calculating SHA-256 hash of URN..."
URN_HASH=$(echo -n "$TEST_URN" | openssl dgst -sha256 -hex | cut -d' ' -f2)

if [ -z "$URN_HASH" ]; then
    # Fallback: use Node.js if openssl is not available
    URN_HASH=$(node -e "const crypto = require('crypto'); console.log(crypto.createHash('sha256').update('$TEST_URN').digest('hex'))")
fi

echo "URN Hash: $URN_HASH"
echo ""

# Make JSON-RPC request
echo "Making RPC call..."
echo ""

curl -X POST "$RPC_URL" \
  -H "Content-Type: application/json" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"method\": \"getContent\",
    \"params\": {
      \"content\": \"$URN_HASH\"
    },
    \"id\": 1
  }" | jq '.'

echo ""
echo ""
echo "=========================================="
echo "Example with different URNs:"
echo "=========================================="
echo ""

# Example 2: index.html
TEST_URN2="urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/index.html"
URN_HASH2=$(echo -n "$TEST_URN2" | openssl dgst -sha256 -hex | cut -d' ' -f2)
if [ -z "$URN_HASH2" ]; then
    URN_HASH2=$(node -e "const crypto = require('crypto'); console.log(crypto.createHash('sha256').update('$TEST_URN2').digest('hex'))")
fi

echo "Test 2 - index.html:"
echo "URN: $TEST_URN2"
echo "Hash: $URN_HASH2"
echo ""

curl -X POST "$RPC_URL" \
  -H "Content-Type: application/json" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"method\": \"getContent\",
    \"params\": {
      \"content\": \"$URN_HASH2\"
    },
    \"id\": 2
  }" | jq '.'

echo ""
echo ""
echo "=========================================="
echo "Example with non-existent content (decoy):"
echo "=========================================="
echo ""

# Example 3: Non-existent content (will return decoy)
FAKE_HASH="0000000000000000000000000000000000000000000000000000000000000000"

echo "Test 3 - Non-existent content (decoy response):"
echo "Hash: $FAKE_HASH"
echo ""

curl -X POST "$RPC_URL" \
  -H "Content-Type: application/json" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"method\": \"getContent\",
    \"params\": {
      \"content\": \"$FAKE_HASH\"
    },
    \"id\": 3
  }" | jq '.'

echo ""
echo "Done!"

