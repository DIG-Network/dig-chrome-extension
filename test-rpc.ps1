# PowerShell script to test DIG Network RPC Server
# Run with: powershell -ExecutionPolicy Bypass -File test-rpc.ps1

$RPC_URL = "http://localhost:3141/rpc"

# Test URN
$TEST_URN = "urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/styles.css"

Write-Host "Testing DIG Network RPC Server" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Test URN: $TEST_URN"
Write-Host ""

# Calculate SHA-256 hash using .NET
function Get-SHA256Hash {
    param([string]$InputString)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($InputString)
    $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
    return ($hash | ForEach-Object { $_.ToString("x2") }) -join ""
}

$URN_HASH = Get-SHA256Hash -InputString $TEST_URN
Write-Host "URN Hash: $URN_HASH"
Write-Host ""

# Make JSON-RPC request
Write-Host "Making RPC call..." -ForegroundColor Yellow
Write-Host ""

$body = @{
    jsonrpc = "2.0"
    method = "getContent"
    params = @{
        content = $URN_HASH
    }
    id = 1
} | ConvertTo-Json -Compress

try {
    $response = Invoke-RestMethod -Uri $RPC_URL -Method Post -Body $body -ContentType "application/json"
    $response | ConvertTo-Json -Depth 10
} catch {
    Write-Host "Error: $_" -ForegroundColor Red
    $_.Exception.Response
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Example with index.html:" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

$TEST_URN2 = "urn:dig:chia:17f89f9af15a046431342694fd2c6df41be8736287e97f6af8327945e59054fb/index.html"
$URN_HASH2 = Get-SHA256Hash -InputString $TEST_URN2

Write-Host "URN: $TEST_URN2"
Write-Host "Hash: $URN_HASH2"
Write-Host ""

$body2 = @{
    jsonrpc = "2.0"
    method = "getContent"
    params = @{
        content = $URN_HASH2
    }
    id = 2
} | ConvertTo-Json -Compress

try {
    $response2 = Invoke-RestMethod -Uri $RPC_URL -Method Post -Body $body2 -ContentType "application/json"
    $response2 | ConvertTo-Json -Depth 10
} catch {
    Write-Host "Error: $_" -ForegroundColor Red
}

Write-Host ""
Write-Host "Done!" -ForegroundColor Green


