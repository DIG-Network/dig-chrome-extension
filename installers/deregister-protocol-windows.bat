@echo off
REM Batch script to deregister dig:// protocol handler on Windows
REM Run as Administrator: Right-click -> "Run as Administrator"

echo Deregistering dig:// protocol handler...

REM Check for admin privileges
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo ERROR: This script must be run as Administrator.
    echo Right-click the file and select "Run as Administrator"
    pause
    exit /b 1
)

REM Remove protocol handler
reg query "HKCU\Software\Classes\dig" >nul 2>&1
if %errorLevel% equ 0 (
    reg delete "HKCU\Software\Classes\dig" /f >nul
    if %errorLevel% equ 0 (
        echo.
        echo Successfully deregistered dig:// protocol handler!
        echo.
        echo Note: You may need to restart your browser for changes to take effect.
    ) else (
        echo ERROR: Failed to remove protocol handler
        pause
        exit /b 1
    )
) else (
    echo.
    echo Protocol handler not found. It may have already been removed.
)

pause

