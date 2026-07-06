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
  surface the native browser injects. It is backed by the extension's own **self-custody wallet**:
  connect + reads are served from the offscreen key vault and sign requests are approved in a
  dedicated window, with per-origin connect consent. There is no WalletConnect. The provider is
  **self-describing**: `window.chia.version`, `window.chia.info`
  (`{ isDIG, transport, edition }`), `window.chia.methods`, and a local
  `request({ method:'chip0002_getMethods' })` introspection call; thrown errors use the
  standard wallet codes (`4001`/`4100`/`4200`/`4900`).
- **Verified badge**: a `chia://` page that is Merkle-verified against its on-chain root
  shows a green "Verified" badge (toolbar + popup + an in-page banner); verification
  failure shows a distinct red state.
- **Toolbar actions — Wallet · Shield · Control Panel** (popup): the popup leads with a
  three-action toolbar mirroring the native DIG Browser's toolbar, each switching to its panel:
  - **Wallet** — the self-custody wallet: create/import a 24-word phrase, unlock, then balances
    (XCH + $DIG + tracked CATs), send/receive, trade, and collectibles — all signed locally in the
    offscreen vault. The extension equivalent of the browser's docked `dig://wallet`.
  - **Shield** — the **DIG Shields** surface for the active tab: the aggregate verified/failed
    verdict, the capsule (`storeId:rootHash`) disclosure, and the **per-resource proof ledger**
    (#134) — each resolved resource's inclusion-proof verdict grouped **Verified (N) / Failed
    (M)**. Execution proofs are kept honest (a mock/absent proof is never shown as verified — the
    read path fetches inclusion only). The ledger model (`dig-ledger.mjs`) is a byte-mirror of the
    browser's `dig/shields/dig_ledger.mjs`.
  - **Control Panel** — your dig-node, the extension equivalent of the browser's `dig://control`.
    It detects a local dig-node (`dig.local` → `localhost:<port>`) and shows either **node status**
    (when reachable) or an **install landing** (when not). The catalogued `control.*` RPCs
    (`control.status`/`config.*`/`cache.*`/`hostedStores.*`/`sync.*`) and detection order match the
    dig-node control contract exactly. The mutating control surface is gated by an on-disk control
    token an MV3 extension can't read, so full node management deep-links to the native DIG Browser;
    when no local node is present, reads transparently fall back to `rpc.dig.net` (stated honestly).
- **DIG settings** (options page): the dig-node host (`localhost:9778`, or an explicitly
  configured custom host that wins entirely over the auto ladder) with a "dig-node not
  running" affordance and the upstream RPC endpoint. The extension does not cache resolved
  content — caching is a dig-node job.

> Some native-browser features are **impossible in MV3** and stay browser-only: network-stack
> `chia://` scheme interception (the extension renders via an in-extension viewer instead),
> a truly in-process wallet, browser-layer privacy, and a native `chrome://settings` DIG
> section.

## Machine-readable / agent surface

The extension ships stable, versioned, machine-consumable contracts (see
[`ARCHITECTURE.md`](./ARCHITECTURE.md) → "Machine-readable contracts"):

- **`dist/agent-surface.json`** (`web_accessible_resource`) — one self-describing index of
  the message protocol, the `ACTIONS` list, the wallet method surface, the error-code
  catalogue, and the provider surface. Generated from source at build time (can't drift).
  Also printable with `node build.js --json`.
- **Message catalogue** (`messages.mjs`): the frozen `ACTIONS` enum + typed request/response
  DTOs; the `getCapabilities` action returns the full self-description.
- **Error codes** (`error-codes.mjs`): every loader failure returns
  `{ success:false, code, message }` with a stable `DIG_ERR_*` code; the four canonical codes
  match docs.dig.net `error-codes.json` `dig-loader`. The viewer also exposes the code as
  `document.documentElement[data-dig-error]`.
- **`data-testid` + ARIA** on the popup, options, and viewer surfaces so an agent can drive
  and assert on them deterministically.
- **TypeScript declarations** (`*.d.ts`) for the shared `.mjs` modules (`package.json` →
  `types`).

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
- ✅ Bundle the injected `window.chia` provider + the MV3 service worker
- ✅ Optionally create a zip file for distribution

The extension is a **self-custody wallet** — it holds its own key in the offscreen vault and signs
locally. There is no WalletConnect: no vendored SignClient, no relay, and no project id to configure.

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
├── popup.html             # Extension popup UI (React shell entry — src/entries/popup.tsx)
├── app.html               # Full-page wallet UI (React shell entry — src/entries/app.tsx)
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
