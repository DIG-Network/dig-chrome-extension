@echo off
REM Batch script to register chia:// protocol handler on Windows
REM Run as Administrator: Right-click -> "Run as Administrator"

echo Registering chia:// protocol handler...

REM Check for admin privileges
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo ERROR: This script must be run as Administrator.
    echo Right-click the file and select "Run as Administrator"
    pause
    exit /b 1
)

REM Find Chrome/Edge/Brave
set CHROME_PATH=
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    set CHROME_PATH=%ProgramFiles%\Google\Chrome\Application\chrome.exe
) else if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
    set CHROME_PATH=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
) else if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" (
    set CHROME_PATH=%LocalAppData%\Google\Chrome\Application\chrome.exe
) else if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
    set CHROME_PATH=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe
) else if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
    set CHROME_PATH=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe
) else if exist "%LocalAppData%\Microsoft\Edge\Application\msedge.exe" (
    set CHROME_PATH=%LocalAppData%\Microsoft\Edge\Application\msedge.exe
) else if exist "%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe" (
    set CHROME_PATH=%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe
) else if exist "%LocalAppData%\BraveSoftware\Brave-Browser\Application\brave.exe" (
    set CHROME_PATH=%LocalAppData%\BraveSoftware\Brave-Browser\Application\brave.exe
)

if "%CHROME_PATH%"=="" (
    echo ERROR: Could not find Chrome/Edge/Brave installation.
    echo Please install Chrome, Edge, or Brave browser first.
    pause
    exit /b 1
)

echo Found browser: %CHROME_PATH%

REM Register protocol handler
reg add "HKCU\Software\Classes\chia" /ve /d "URL:chia Protocol" /f >nul
reg add "HKCU\Software\Classes\chia" /v "URL Protocol" /t REG_SZ /d "" /f >nul
reg add "HKCU\Software\Classes\chia\shell\open\command" /ve /d "\"%CHROME_PATH%\" --new-window \"%%1\"" /f >nul

if %errorLevel% equ 0 (
    echo.
    echo Successfully registered chia:// protocol handler!
    echo.
    echo Note: The DIG Network Extension must be installed in your browser
    echo       for chia:// URLs to work properly.
    echo.
    echo Test it by opening: chia://test/example
) else (
    echo ERROR: Failed to register protocol handler
    pause
    exit /b 1
)

pause

