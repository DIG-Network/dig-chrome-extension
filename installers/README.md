# DIG Protocol Handler Installation

This directory contains scripts to register the `chia://` protocol handler at the OS level. This allows `chia://` URLs to work system-wide, not just within the browser extension.

## Important Notes

1. **Browser Extension Required**: Even after registering the protocol handler, you still need the DIG Network Browser Extension installed in your browser for `chia://` URLs to work properly.

2. **How It Works**: 
   - OS-level registration tells the system to open `chia://` URLs in your browser
   - The browser extension then intercepts these URLs and redirects them to `localhost:8080`
   - This eliminates "scheme does not have a registered handler" errors

3. **Security**: These scripts modify system settings. Review them before running.

## Installation by Platform

### Windows

**Option 1: PowerShell (Recommended)**
```powershell
# Run PowerShell as Administrator
# Right-click PowerShell -> "Run as Administrator"
cd installers
.\register-protocol-windows.ps1
```

**Option 2: Batch Script**
```cmd
# Right-click register-protocol-windows.bat -> "Run as Administrator"
```

**Manual Registration (Alternative)**
1. Open Registry Editor (`regedit`)
2. Navigate to `HKEY_CURRENT_USER\Software\Classes`
3. Create new key: `chia`
4. Set default value to: `URL:chia Protocol`
5. Create string value: `URL Protocol` (leave empty)
6. Create key: `chia\shell\open\command`
7. Set default value to: `"C:\Path\To\Chrome.exe" "%1"`

### macOS

```bash
chmod +x installers/register-protocol-macos.sh
./installers/register-protocol-macos.sh
```

**Manual Registration (Alternative)**
1. Create `~/Library/Application Support/DIG Protocol Handler/Contents/Info.plist`
2. Add protocol handler configuration
3. Register with `lsregister`

### Linux

```bash
chmod +x installers/register-protocol-linux.sh
./installers/register-protocol-linux.sh
```

**Manual Registration (Alternative)**
1. Create `~/.local/share/applications/dig-protocol-handler.desktop`
2. Add `x-scheme-handler/chia` MIME type
3. Run `update-desktop-database`
4. Run `xdg-mime default dig-protocol-handler.desktop x-scheme-handler/chia`

## Testing

After installation, test the protocol handler:

1. **In Browser**: Open `chia://test/example` in your browser's address bar
2. **From Terminal**: 
   - Windows: `start chia://test/example`
   - macOS: `open chia://test/example`
   - Linux: `xdg-open chia://test/example`

## Uninstallation

### Windows

**Option 1: PowerShell Script (Recommended)**
```powershell
# Run PowerShell as Administrator
# Right-click PowerShell -> "Run as Administrator"
cd installers
.\deregister-protocol-windows.ps1
```

**Option 2: Batch Script**
```cmd
# Right-click deregister-protocol-windows.bat -> "Run as Administrator"
```

**Option 3: Manual Removal**
```powershell
# Run PowerShell as Administrator
Remove-Item "HKCU:\Software\Classes\chia" -Recurse -Force
```

### macOS
```bash
rm -rf "$HOME/Library/Application Support/DIG Protocol Handler"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$HOME/Library/Application Support/DIG Protocol Handler"
```

### Linux
```bash
rm ~/.local/share/applications/dig-protocol-handler.desktop
update-desktop-database ~/.local/share/applications
```

## Troubleshooting

**"Scheme does not have a registered handler" still appears**
- Make sure you ran the installer script as Administrator (Windows) or with appropriate permissions
- Restart your browser after installation
- On Linux, you may need to log out and log back in

**Protocol handler doesn't work**
- Verify the browser extension is installed and enabled
- Check that the browser path in the registry/desktop file is correct
- Try uninstalling and reinstalling the protocol handler

**Browser doesn't open chia:// URLs**
- Check that the browser path is correct in the registry/desktop file
- Verify the browser extension is installed
- Check browser console for errors

