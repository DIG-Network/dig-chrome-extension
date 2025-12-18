# DIG Network RPC Server - Test Examples

This document provides example curl commands to test the DIG Network RPC server.

## Prerequisites

1. Start the server: `npm start` (runs on `localhost:3141`)
2. Have `curl` installed (or use PowerShell on Windows)

## Basic Test

### Example 1: Request styles.css

First, calculate the SHA-256 hash of the URN:

```bash
# Using openssl
echo -n "urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/styles.css" | openssl dgst -sha256 -hex

# Or using Node.js
node -e "const crypto = require('crypto'); console.log(crypto.createHash('sha256').update('urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/styles.css').digest('hex'))"
```

Then make the RPC call:

```bash
curl -X POST http://localhost:3141/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "getContent",
    "params": {
      "content": "YOUR_HASH_HERE"
    },
    "id": 1
  }'
```

### Example 2: Pre-calculated hash for styles.css

The SHA-256 hash of `urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/styles.css` is:

```
a1b2c3d4e5f6... (calculate this)
```

```bash
curl -X POST http://localhost:3141/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "getContent",
    "params": {
      "content": "a1b2c3d4e5f6..."
    },
    "id": 1
  }'
```

## Quick Test Scripts

### Bash (Linux/Mac)

Run the provided `test-rpc.sh` script:

```bash
chmod +x test-rpc.sh
./test-rpc.sh
```

### PowerShell (Windows)

Run the provided `test-rpc.ps1` script:

```powershell
powershell -ExecutionPolicy Bypass -File test-rpc.ps1
```

## Manual curl Examples

### Test 1: Request existing content (styles.css)

```bash
# Calculate hash first
URN="urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/styles.css"
HASH=$(echo -n "$URN" | openssl dgst -sha256 -hex | cut -d' ' -f2)

# Make request
curl -X POST http://localhost:3141/rpc \
  -H "Content-Type: application/json" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"method\": \"getContent\",
    \"params\": {
      \"content\": \"$HASH\"
    },
    \"id\": 1
  }"
```

### Test 2: Request index.html

```bash
URN="urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/index.html"
HASH=$(echo -n "$URN" | openssl dgst -sha256 -hex | cut -d' ' -f2)

curl -X POST http://localhost:3141/rpc \
  -H "Content-Type: application/json" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"method\": \"getContent\",
    \"params\": {
      \"content\": \"$HASH\"
    },
    \"id\": 2
  }"
```

### Test 3: Request non-existent content (returns decoy)

```bash
# Use a fake hash that doesn't exist
FAKE_HASH="0000000000000000000000000000000000000000000000000000000000000000"

curl -X POST http://localhost:3141/rpc \
  -H "Content-Type: application/json" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"method\": \"getContent\",
    \"params\": {
      \"content\": \"$FAKE_HASH\"
    },
    \"id\": 3
  }"
```

## Expected Response Format

### Success Response

```json
{
  "jsonrpc": "2.0",
  "result": {
    "blob": "base64-encoded-content-here",
    "proof": "base64-encoded-proof-here"
  },
  "id": 1
}
```

### Error Response

```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32602,
    "message": "Invalid params",
    "data": "content parameter is required"
  },
  "id": 1
}
```

## Testing with jq (Pretty Print)

If you have `jq` installed, pipe the response through it for better formatting:

```bash
curl -X POST http://localhost:3141/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "getContent",
    "params": {
      "content": "YOUR_HASH_HERE"
    },
    "id": 1
  }' | jq '.'
```

## Notes

- The RPC server returns base64-encoded content in the `blob` field
- For non-existent content, a decoy blob is returned (privacy-preserving)
- The `proof` field contains a Merkle proof (mock implementation for testing)
- All content is returned as plaintext base64 (encryption skipped for testing)

