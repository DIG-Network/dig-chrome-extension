# PowerShell script to deregister dig:// protocol handler on Windows
# Run as Administrator: Right-click PowerShell -> "Run as Administrator"

Write-Host "Deregistering dig:// protocol handler..." -ForegroundColor Cyan

# Registry path
$regPath = "HKCU:\Software\Classes\dig"

try {
    # Check if the protocol handler exists
    if (Test-Path $regPath) {
        # Remove the entire protocol handler registry key
        Remove-Item -Path $regPath -Recurse -Force
        
        Write-Host "✓ Successfully deregistered dig:// protocol handler!" -ForegroundColor Green
        Write-Host "  Removed: $regPath" -ForegroundColor Gray
    } else {
        Write-Host "⚠ Protocol handler not found. It may have already been removed." -ForegroundColor Yellow
        Write-Host "  Path checked: $regPath" -ForegroundColor Gray
    }
    
} catch {
    Write-Host "ERROR: Failed to deregister protocol handler" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Note: You may need to restart your browser for changes to take effect." -ForegroundColor Yellow

