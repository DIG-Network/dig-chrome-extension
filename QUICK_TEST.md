# Quick RPC Server Test

## Simple curl Command (Copy & Paste)

### Test styles.css (Raw URN - No Encryption)

```bash
curl -X POST http://localhost:3141/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "getContent",
    "params": {
      "urn": "urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/styles.css"
    },
    "id": 1
  }'
```

### Test index.html

```bash
curl -X POST http://localhost:3141/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "getContent",
    "params": {
      "urn": "urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/index.html"
    },
    "id": 1
  }'
```

### Pretty Print with jq

```bash
curl -X POST http://localhost:3141/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "getContent",
    "params": {
      "urn": "urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/styles.css"
    },
    "id": 1
  }' | jq '.'
```

### Test Decoy Response (Non-existent content)

```bash
curl -X POST http://localhost:3141/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "getContent",
    "params": {
      "urn": "urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/nonexistent.txt"
    },
    "id": 2
  }' | jq '.'
```

## Expected Response Format

The response will contain a `dataUrl` field with the content as a data URL:

```json
{
  "jsonrpc": "2.0",
  "result": {
    "dataUrl": "data:text/css;base64,LyogRElHIE5ldHdvcmsgVGVzdCBTdHlsZXNoZWV0ICov..."
  },
  "id": 1
}
```

