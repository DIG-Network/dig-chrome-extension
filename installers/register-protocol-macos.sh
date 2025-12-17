#!/bin/bash
# Script to register dig:// protocol handler on macOS
# Run: chmod +x register-protocol-macos.sh && ./register-protocol-macos.sh

echo "Registering dig:// protocol handler on macOS..."

# Find Chrome/Edge/Brave
CHROME_PATH=""
if [ -d "/Applications/Google Chrome.app" ]; then
    CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
elif [ -d "/Applications/Google Chrome Canary.app" ]; then
    CHROME_PATH="/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
elif [ -d "/Applications/Microsoft Edge.app" ]; then
    CHROME_PATH="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
elif [ -d "/Applications/Brave Browser.app" ]; then
    CHROME_PATH="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
elif [ -d "$HOME/Applications/Google Chrome.app" ]; then
    CHROME_PATH="$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
elif [ -d "$HOME/Applications/Brave Browser.app" ]; then
    CHROME_PATH="$HOME/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
fi

if [ -z "$CHROME_PATH" ]; then
    echo "ERROR: Could not find Chrome/Edge/Brave installation."
    echo "Please install Chrome, Edge, or Brave browser first."
    exit 1
fi

if [ ! -f "$CHROME_PATH" ]; then
    echo "ERROR: Browser executable not found at: $CHROME_PATH"
    exit 1
fi

echo "Found browser: $CHROME_PATH"

# Create the Info.plist for the protocol handler
APP_NAME="DIG Protocol Handler"
APP_DIR="$HOME/Library/Application Support/$APP_NAME"
mkdir -p "$APP_DIR/Contents"

# Create Info.plist
cat > "$APP_DIR/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>com.dig.network.protocol</string>
    <key>CFBundleName</key>
    <string>$APP_NAME</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleExecutable</key>
    <string>handler.sh</string>
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key>
            <string>DIG Network Protocol</string>
            <key>CFBundleURLSchemes</key>
            <array>
                <string>dig</string>
            </array>
        </dict>
    </array>
</dict>
</plist>
EOF

# Create handler script
cat > "$APP_DIR/Contents/handler.sh" <<EOF
#!/bin/bash
# Protocol handler script
exec "$CHROME_PATH" "\$@"
EOF

chmod +x "$APP_DIR/Contents/handler.sh"

# Register with Launch Services
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP_DIR"

if [ $? -eq 0 ]; then
    echo ""
    echo "✓ Successfully registered dig:// protocol handler!"
    echo "  Protocol: dig://"
    echo "  Handler: $CHROME_PATH"
    echo ""
    echo "Note: The DIG Network Extension must be installed in your browser"
    echo "      for dig:// URLs to work properly."
    echo ""
    echo "Test it by opening: dig://test/example"
else
    echo "ERROR: Failed to register protocol handler"
    exit 1
fi

