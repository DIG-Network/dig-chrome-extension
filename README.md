# DIG Network Browser Extension

A Chromium/Firefox (MV3) browser extension that brings the **DIG Network experience to any
browser** — feature-parity-tracking the native [DIG Browser](https://github.com/DIG-Network/DIG_Browser).
It resolves `chia://` content (verified + decrypted), overrides the new-tab page with DIG
Home, injects a `window.chia` wallet, and shows a verified badge.

## DIG experience (parity with the native DIG Browser)

- **DIG Home (new-tab page)**: a white/minimal DIG Home with the ecosystem app directory
  (DIGHUb, XCH Annuity, TibetSwap, Docs), a Search ⇄ App Store switcher, and a DuckDuckGo
  web-search fallback. Ported from the native browser's NTP.
- **`window.chia` provider**: dapps get a CHIP-0002 `window.chia` on every page — the same
  surface the native browser injects. Extensions can't run an in-process wallet, so it's
  brokered over **WalletConnect → Sage**, with per-origin connect consent.
- **Verified badge**: a `chia://` page that is Merkle-verified against its on-chain root
  shows a green "Verified" badge (toolbar + popup + an in-page banner); verification
  failure shows a distinct red state.
- **Wallet panel** (popup): balance, connect/disconnect (WalletConnect → Sage), and a
  "Get DIG ↗" link.
- **DIG settings** (options page): local cache usage/clear, the dig-companion host
  (`localhost:8080`) with a "companion not running" affordance, the upstream RPC endpoint,
  and the WalletConnect project id.

> Some native-browser features are **impossible in MV3** and stay browser-only: network-stack
> `chia://` scheme interception (the extension renders via an in-extension viewer instead),
> a truly in-process wallet, browser-layer privacy, and a native `chrome://settings` DIG
> section.

## Resolution features

- **Toggle Control**: Activate or deactivate the extension with a simple toggle switch
- **Comprehensive Protocol Interception**: Automatically intercepts ALL `chia://` protocol requests when active, including:
  - Image tags (`<img src="chia://...">`)
  - Script tags (`<script src="chia://...">`)
  - Stylesheet links (`<link href="chia://...">`)
  - Video/Audio sources
  - Iframe sources
  - CSS `url()` references (inline styles and `<style>` tags)
  - Fetch API requests (`fetch('chia://...')`)
  - XMLHttpRequest calls
  - Link navigation (`<a href="chia://...">`)
  - Any other DOM resource requests
- **Localhost Redirection**: Redirects all intercepted requests to `http://localhost:8080`
- **DIG Network Branding**: Uses the official DIG Network colors and styling (dark purple background, magenta/purple gradients)

## Installation

### Browser Extension Installation

1. Build the extension:
```bash
npm run build
```

2. Install in your browser:
   - Open Chrome/Edge/Brave
   - Go to `chrome://extensions/` (or `edge://extensions/`)
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the `dist` folder

### OS-Level Protocol Handler (Optional)

To register `chia://` as a system-wide protocol handler (eliminates "scheme does not have a registered handler" errors), see the [installers/README.md](installers/README.md) directory.

**Note**: The browser extension will work without OS-level registration, but you may see error messages. OS-level registration is optional but recommended for a better user experience.

### Quick Start

1. **Build the extension:**
   ```bash
   npm run build
   ```

2. **Install in your browser:**
   - Open Chrome/Edge/Brave (or any Chromium-based browser)
   - Navigate to `chrome://extensions/` (or `edge://extensions/` for Edge)
   - Enable "Developer mode" (toggle in the top right)
   - Click "Load unpacked"
   - Select the `dist` folder created by the build script

### Build Scripts

- `npm run build` - Validates and prepares the extension in the `dist/` folder
- `npm run build:zip` - Builds the extension and creates a zip file for distribution
- `npm run server` - Starts the Express test server (recommended)
- `npm run server:stub` - Starts the simple stub server (alternative)
- `npm run generate-icons` - Generates icon placeholder files (icons should be created using `create-icons.html`)

The build script will:
- ✅ Validate all required extension files
- ✅ Check for icons (optional, but recommended)
- ✅ Copy all files to a `dist/` directory ready for installation
- ✅ Optionally create a zip file for distribution

## Usage

1. **Install and start the test server** (required for testing):
   ```bash
   # First time: Install server dependencies
   cd server
   npm install
   cd ..
   
   # Start the server
   npm run server
   ```
   This starts the Express test server on `http://localhost:8080`.

2. **Activate the extension**:
   - Click the extension icon in your browser toolbar
   - Toggle the switch to "Active"

3. **Test the protocol interception**:
   - **Quick test**: Open `test.html` in your browser (after building, it's in the `dist/` folder)
   - **Manual test**: Navigate to a `chia://` URL (e.g., `chia://example.com/image.png`)
   - The extension will redirect it to `http://localhost:8080/example.com/image.png`

### Test Page

The project includes `test.html` - a comprehensive test page that exercises `chia://` protocol in:
- Image tags (`<img>`, `<picture>`, `srcset`)
- Script tags (`<script>`)
- Stylesheet links (`<link>`)
- CSS `url()` references
- Fetch API calls
- XMLHttpRequest
- Video/Audio elements
- Iframes
- Dynamic content creation

Open `test.html` in your browser and check the Developer Tools (F12) Network tab to see all `chia://` requests being redirected to `localhost:8080`.

## Test Server

The extension uses the **Express Test Server** located in the `server/` folder. This is the recommended and default server for testing.

### Express Test Server (Default)

Start the server with:
```bash
npm run server
```

Or manually:
```bash
cd server
npm install  # First time only
npm start
```

The Express server:
- Handles all `/test/*` routes from the test page
- Returns appropriate responses based on file type (images, CSS, JS, JSON, HTML)
- Includes proper CORS headers
- Logs all requests for debugging
- Runs on `http://localhost:8080` (matching the extension configuration)

### Alternative: Simple Stub Server

For a minimal alternative, you can use the simple stub server:
```bash
npm run server:stub
# or
node stub-server.js
```

The stub server provides basic placeholder responses but has limited functionality compared to the Express server.

## Development

### Project Structure

```
dig-browser-extension/
├── manifest.json          # Extension manifest (Manifest V3)
├── popup.html             # Extension popup UI
├── popup.css              # Popup styling with DIG branding
├── popup.js               # Popup logic and toggle handling
├── background.js          # Service worker for protocol interception
├── content.js             # Content script to intercept chia:// links
├── stub-server.js         # Simple stub server (alternative to Express server)
├── server/                # Express test server (recommended)
│   ├── server.js         # Main Express server
│   ├── package.json      # Server dependencies
│   └── README.md         # Server documentation
├── create-icons.html      # Tool to generate extension icons
├── package.json           # Node.js dependencies and scripts
├── icons/                 # Extension icons (generate using create-icons.html)
└── README.md             # This file
```

### Generating Icons

To generate the extension icons:
1. Open `create-icons.html` in your browser
2. Click "Download All Icons"
3. Save the downloaded files as `icon16.png`, `icon48.png`, and `icon128.png` in the `icons/` directory

### Customization

- **Change localhost port**: Edit `LOCALHOST_PORT` in `background.js` and `content.js`, and update `PORT` in `server/server.js`
- **Modify server responses**: Edit `server/server.js` to customize responses for different file types

## Notes

- The extension uses Manifest V3 (Chrome's latest extension format)
- Protocol interception works by redirecting navigation attempts to `chia://` URLs
- The Express test server is provided for testing purposes and should be replaced with the actual DIG Network server implementation

## Branding

The extension uses DIG Network's official branding:
- **Primary Background**: Deep indigo/dark purple gradient (#1a0a2e → #0f3460)
- **Accent Colors**: Magenta to purple gradient (#FF00FF → #9D4EDD)
- **Text**: White on dark background
- **Logo**: Stylized "D" in hexagonal outline with gradient
# dig-chrome-extension
