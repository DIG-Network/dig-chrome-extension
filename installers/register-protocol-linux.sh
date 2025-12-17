#!/bin/bash
# Script to register dig:// protocol handler on Linux
# Run: chmod +x register-protocol-linux.sh && ./register-protocol-linux.sh

echo "Registering dig:// protocol handler on Linux..."

# Find Chrome/Edge/Brave
CHROME_PATH=""
if command -v google-chrome &> /dev/null; then
    CHROME_PATH=$(which google-chrome)
elif command -v chromium-browser &> /dev/null; then
    CHROME_PATH=$(which chromium-browser)
elif command -v chromium &> /dev/null; then
    CHROME_PATH=$(which chromium)
elif command -v microsoft-edge &> /dev/null; then
    CHROME_PATH=$(which microsoft-edge)
elif command -v brave-browser &> /dev/null; then
    CHROME_PATH=$(which brave-browser)
elif [ -f "/usr/bin/google-chrome" ]; then
    CHROME_PATH="/usr/bin/google-chrome"
elif [ -f "/usr/bin/chromium" ]; then
    CHROME_PATH="/usr/bin/chromium"
elif [ -f "/usr/bin/brave-browser" ]; then
    CHROME_PATH="/usr/bin/brave-browser"
fi

if [ -z "$CHROME_PATH" ]; then
    echo "ERROR: Could not find Chrome/Chromium/Edge/Brave installation."
    echo "Please install Chrome, Chromium, Edge, or Brave browser first."
    exit 1
fi

echo "Found browser: $CHROME_PATH"

# Create .desktop file
DESKTOP_DIR="$HOME/.local/share/applications"
mkdir -p "$DESKTOP_DIR"

cat > "$DESKTOP_DIR/dig-protocol-handler.desktop" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=DIG Protocol Handler
Comment=Handler for dig:// protocol URLs
Exec=$CHROME_PATH %u
Terminal=false
NoDisplay=true
MimeType=x-scheme-handler/dig;
EOF

# Update desktop database
update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true

# Register with xdg-mime (if available)
if command -v xdg-mime &> /dev/null; then
    xdg-mime default dig-protocol-handler.desktop x-scheme-handler/dig
fi

echo ""
echo "✓ Successfully registered dig:// protocol handler!"
echo "  Protocol: dig://"
echo "  Handler: $CHROME_PATH"
echo ""
echo "Note: The DIG Network Extension must be installed in your browser"
echo "      for dig:// URLs to work properly."
echo ""
echo "Test it by opening: dig://test/example"
echo ""
echo "You may need to log out and log back in for the changes to take effect."

