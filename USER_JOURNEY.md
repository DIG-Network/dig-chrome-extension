# DIG Network Extension — User Journey

This is the end-to-end journey of a person using the extension, the surfaces they touch at
each step, and where the extension hands off to the rest of the DIG ecosystem (DIGHUb, a
local dig-node, the native DIG Browser). It complements `ARCHITECTURE.md` (which describes
the read pipeline) by tracing the *user's* path, not the data path.

> The extension brings the DIG content layer to any Chromium browser (Chrome / Edge /
> Brave). The native **DIG Browser** does the same thing built in (no extension); this
> extension is the bridge for everyone who isn't on it yet.

---

## 1. Install

- **How:** load the packaged extension (Chrome Web Store / Edge Add-ons, or "Load unpacked"
  on the built `dist/` folder during development).
- **What happens:** on a fresh install (`onInstalled` with `reason === 'install'`) the
  background SW opens the **welcome page** in a new tab.
- **Surface:** `welcome.html`.

## 2. Onboard (welcome page)

- **Goal:** show the user how to DO the one thing the extension is for, immediately.
- **Surfaces / affordances (`welcome.html` + `welcome.js`):**
  - **Try it** — a copyable example `chia://` address and an **"Open a new tab to browse"**
    action that lands on DIG Home (the app directory).
  - Funnels to **Visit DIG Network** (`dig.net`), **Read the docs** (`docs.dig.net`), and a
    soft upsell to the **native DIG Browser** (releases page).
- **Hand-off:** dig.net / docs.dig.net / the DIG Browser releases page. Funnel destinations
  are centralised in `links.mjs` so every surface points at the same URLs.

## 3. Browse / DIG Home (new tab)

- The extension overrides the **new-tab page** with **DIG Home** — a white, minimal app
  directory plus a search⇄app-store switcher (ported from the native browser's NTP).
- **Surfaces:** `newtab.html` / `newtab.css` / `newtab.js`; the app directory + omnibox
  classifier come from `apps.mjs`.
- The omnibox/search box routes a **capsule** (`storeId:rootHash`) or a `chia://…` address
  to the DIG read path; anything else searches the web (DuckDuckGo).
- **Hand-off:** the **Publish** button → `hub.dig.net/new` (DIGHUb); web search → DuckDuckGo.

## 4. Pair a wallet (optional, for dapps)

- A user pairs a Chia wallet over **WalletConnect → Sage** so dapps can use `window.chia`.
- **Surface:** the **popup** wallet panel (`popup.html` + `popup-wallet.js`), driven by the
  WalletConnect transport in `wallet-wc.js` (the live relay session runs in the popup page;
  an MV3 service worker can't hold a relay socket).
- **Flow:** *Connect wallet* → a pairing link the user scans/pastes in Sage → on approval
  the panel shows the connected address and **XCH** + **$DIG** balances (the $DIG row is
  the DIG CAT, `a406d3a9…832f81`).
- **Per-origin consent:** when a site calls `window.chia.connect()` and the popup is closed,
  the background SW records the origin as *pending*, sets a **toolbar attention badge**, and
  fires a **notification** naming the site. The user opens the popup, reviews the request
  under **Connection requests**, and Allows/Denies it. Approved origins are remembered.
- **Hand-off:** Sage Wallet (over the WalletConnect/Reown relay). The project id used to
  pair is configured in **DIG settings** (the options page) or baked at build time.

## 5. Open `chia://` content

Multiple entry points, all converging on the same verified read path:

- Type/paste a `chia://…` address in the **browser address bar**.
- Use the **`dig` omnibox keyword** (type `dig` then a query/address).
- Click a `chia://` link on any page (the content scripts rewrite/intercept it).
- Use the popup's **"Open a chia:// address"** box.

The background service worker (`background.js`) intercepts the navigation, fetches
ciphertext + a Merkle inclusion proof from the **upstream DIG RPC** (`rpc.dig.net` by
default, or a local **dig-node** if configured), then **verifies + decrypts on this device**
using the SRI-pinned `dig_client` WASM, and renders the result.

- **Surface:** `dig-viewer.html` / `dig-viewer.js` (the render page).
- **Verified view:** a green banner — **"Verified on Chia"** — when the content is
  Merkle-proven against its on-chain root; a red **"Verification failed"** banner otherwise.
  The same canonical label/tooltip appears on the popup's verified line and the toolbar
  badge.
- **If it can't load:** a branded, white-theme error page ("This DIG page couldn't be
  loaded") with a plain-language cause and a recovery action (**Try again** / **Go to DIG
  Home**). Internal failure strings (e.g. decrypt/decoy/proof errors) are never shown — they
  are mapped to friendly causes (`error-page.mjs`).

## 6. Verified status at a glance

- **Toolbar badge:** a ✓ (verified) / ! (failed) badge per tab, plus a global ● attention
  badge when a wallet connection request is pending.
- **Popup verified line:** mirrors the active tab's verification state (`popup-wallet.js`).
- **Viewer banner:** in-page verified/failed banner (`dig-viewer.js`).

## 7. Settings (the one settings home)

All configuration lives on the **options page** (`options.html` / `options.js`), reached
from the popup's **"DIG settings"** link. The popup itself stays a product surface (no
config controls).

- **dig-node host** (`server.host`) — point the extension at a local **dig-node** to resolve
  `chia://` content locally instead of the hosted RPC. Default **`localhost:8080`** (the
  dig-node port), with a reachability check. An explicitly-configured custom host wins
  ENTIRELY over the `dig.local`/`localhost` ladder. (One name, one default, one parser,
  shared via `server-config.mjs`.) The extension does not cache resolved content — every read
  re-verifies and re-decrypts; caching is a dig-node job.
- **DIG RPC endpoint** — the upstream used when no dig-node is configured (`rpc.dig.net`).
  Verification + decryption always happen on this device regardless.
- **Wallet** — the WalletConnect / Reown project id used to pair Sage.

---

## Hand-off map

| From this extension | To | Why |
|---|---|---|
| Welcome page, popup Resources, DIG Home Publish | **hub.dig.net (DIGHUb)** | Explore + publish capsules |
| `chia://` reads | **rpc.dig.net** (or a local **dig-node**) | Ciphertext + Merkle proofs (verified/decrypted locally) |
| Wallet panel (`window.chia`) | **Sage** (WalletConnect → Reown relay) | Signing / balances |
| Welcome + options soft upsell | **native DIG Browser** | The built-in experience that supersedes the extension |
| Welcome / footers | **dig.net**, **docs.dig.net** | Learn + marketing |

## Key surfaces

| Surface | Files | Role |
|---|---|---|
| Welcome | `welcome.html`, `welcome.js` | First-run onboarding + Try it |
| DIG Home (new tab) | `newtab.html`, `newtab.css`, `newtab.js`, `apps.mjs` | App directory + omnibox |
| Popup | `popup.html`, `popup.js`, `popup-wallet.js`, `popup.css` | Product surface: verified line, wallet, open chia://, settings link |
| Viewer | `dig-viewer.html`, `dig-viewer.js` | Renders verified content; branded loading/error states |
| Settings | `options.html`, `options.js`, `options.css` | The one settings home: dig-node host, RPC, wallet |
| Background SW | `background.js` | Intercept + verify + decrypt; badges; error pages |
| Shared modules | `links.mjs`, `dig-urn.mjs`, `server-config.mjs`, `error-page.mjs`, `wallet-broker.mjs`, `wallet-methods.mjs` | Single sources of truth (links, URN parsing, dig-node host, error page, wallet consent/methods) |

## Canonical terminology (per `SYSTEM.md`)

- **`chia://`** — what a user types/clicks to open verified DIG content (the user-facing
  scheme; do not surface `dig://`).
- **DIGHUb** — the hub wordmark.
- **$DIG** — the token (use the sigil on first reference).
- **capsule** — one immutable generation of a store (`storeId:rootHash`); the unit a rooted
  address names.
- **dig-node** — the local resolver (renamed from dig-companion).
