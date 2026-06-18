# PowerShell script to register dig:// protocol handler on Windows
# Run as Administrator: Right-click PowerShell -> "Run as Administrator"

Write-Host "Registering dig:// protocol handler..." -ForegroundColor Cyan

# Get the path to Chrome/Edge/Brave
$chromePaths = @(
    "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "${env:LocalAppData}\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "${env:LocalAppData}\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles}\BraveSoftware\Brave-Browser\Application\brave.exe",
    "${env:LocalAppData}\BraveSoftware\Brave-Browser\Application\brave.exe"
)

$chromePath = $null
foreach ($path in $chromePaths) {
    if (Test-Path $path) {
        $chromePath = $path
        break
    }
}

if (-not $chromePath) {
    Write-Host "ERROR: Could not find Chrome/Edge/Brave installation." -ForegroundColor Red
    Write-Host "Please install Chrome, Edge, or Brave browser first." -ForegroundColor Yellow
    exit 1
}

Write-Host "Found browser: $chromePath" -ForegroundColor Green

# Registry path
$regPath = "HKCU:\Software\Classes\dig"

try {
    # Create the protocol key
    if (-not (Test-Path $regPath)) {
        New-Item -Path $regPath -Force | Out-Null
    }
    
    # Set default value
    Set-ItemProperty -Path $regPath -Name "(Default)" -Value "URL:dig Protocol" -Type String
    
    # Set URL Protocol
    Set-ItemProperty -Path $regPath -Name "URL Protocol" -Value "" -Type String
    
    # Create shell\open\command structure
    $commandPath = "$regPath\shell\open\command"
    if (-not (Test-Path $commandPath)) {
        New-Item -Path $commandPath -Force | Out-Null
    }
    
    # Set command to open URL in browser
    # Use --new-window to ensure it opens in a new window if Chrome is already running
    # The browser extension will intercept the dig:// URL and redirect it
    $command = "`"$chromePath`" --new-window `"%1`""
    Set-ItemProperty -Path $commandPath -Name "(Default)" -Value $command -Type String
    
    Write-Host "✓ Successfully registered dig:// protocol handler!" -ForegroundColor Green
    Write-Host "  Protocol: dig://" -ForegroundColor Gray
    Write-Host "  Handler: $chromePath" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Note: The DIG Network Extension must be installed in your browser" -ForegroundColor Yellow
    Write-Host "      for dig:// URLs to work properly." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Test it by opening: dig://test/example" -ForegroundColor Cyan
    
} catch {
    Write-Host "ERROR: Failed to register protocol handler" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

