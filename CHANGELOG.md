# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org) and
[Conventional Commits](https://www.conventionalcommits.org).

## [1.55.0] - 2026-07-07

### Features
- **collectibles:** NFT detail image opens an XL lightbox on click (#78)

## [1.54.0] - 2026-07-07

### Features
- **home:** Open a chia:// address or DIG URN from the home screen (#172) (#77)

## [1.53.0] - 2026-07-07

### Features
- **branding:** DIG Mark manifest icons + per-page tab favicons (#76)

## [1.52.0] - 2026-07-07

### Features
- **dig-dns:** Self-healing .dig proxy fallback via chrome.proxy PAC (#175) (#75)

## [1.51.0] - 2026-07-07

### Features
- **wallet:** Activity = local transaction log (MetaMask-style), not on-chain scan (#74)

## [1.50.0] - 2026-07-07

### Features
- **wallet:** Sticky ViewHeader back button + dedicated Receive screen (#166) (#73)

## [1.49.0] - 2026-07-07

### Features
- **wallet:** Redesign the multi-wallet switcher (#72)

## [1.48.2] - 2026-07-07

### Bug Fixes
- **wallet:** Popup no horizontal scroll + hide Identity tab in compact (#71)

## [1.48.1] - 2026-07-07

### Bug Fixes
- **wallet:** Reset RTK Query cache on active-wallet/index change (#70)

## [1.48.0] - 2026-07-07

### Features
- **wallet:** Order Assets/CAT list by value + add a live filter with autocomplete (#69)

## [1.47.0] - 2026-07-07

### Features
- **wallet:** Single active derivation index model, retire multi-index sweep (#68)

## [1.46.0] - 2026-07-07

### Features
- **collectibles:** Cache remote NFT art locally so a 2nd view never re-fetches (#159) (#67)

## [1.45.0] - 2026-07-07

### Features
- **wallet:** Show the Chia leaf logo for XCH instead of a monogram

## [1.44.0] - 2026-07-07

### Features
- **wallet:** Keep the wallet unlocked for the session, not just per popup open (#65)

## [1.43.2] - 2026-07-07

### Bug Fixes
- **wallet:** Resolve real CAT ticker in Activity, not the generic fallback

## [1.43.1] - 2026-07-07

### Bug Fixes
- **collectibles:** Render remote/ipfs NFT art instead of a monogram placeholder (#63)

## [1.43.0] - 2026-07-07

### Features
- **wallet:** $ / XCH swap toggle on the Home balance widget

## [1.42.0] - 2026-07-07

### Features
- **wallet:** NFT offers with CHIP-0011 royalty; drag-and-drop offer accept (#61)

## [1.41.2] - 2026-07-07

### Bug Fixes
- **wallet:** Coinset RpcClient construction — use the static factory, not new (#148) (#60)

## [1.41.1] - 2026-07-06

### Bug Fixes
- **build:** Sync manifest version from package.json + default dig-node port to 9778 (#139, #132) (#59)

## [1.41.0] - 2026-07-06

### Features
- **identity:** DID management (create/list/transfer/profile/NFT-owner-assign) (#58)

## [1.40.0] - 2026-07-06

### Features
- **collectibles:** Mint NFTs (CHIP-0007 metadata + royalty) (#57)

## [1.39.0] - 2026-07-06

### Features
- **wallet:** Multiple keys / wallet switcher (#90) (#56)

## [1.38.0] - 2026-07-06

### Features
- **wallet:** Coin control — list / select / split / combine (#91) (#55)

## [1.37.2] - 2026-07-06

### Bug Fixes
- **wallet:** Allow api.coinset.org host in manifest CSP + host_permissions (#122) (#54)

## [1.37.1] - 2026-07-06

### Bug Fixes
- **control:** Re-parity the dig-node control interface + clarify the node is required for full use (#53)

## [1.37.0] - 2026-07-06

### Features
- **wallet:** CAT auto-discovery + token metadata (name/ticker/icon) (#52)

## [1.36.0] - 2026-07-06

### Features
- **wallet:** Address book / contacts (#88) (#51)

## [1.35.0] - 2026-07-06

### Features
- **wallet:** Price feed + fiat portfolio value (#86) (#50)

## [1.34.0] - 2026-07-06

### Features
- **wallet:** Wire the full window.chia method surface through the self-custody vault (#49)

## [1.33.0] - 2026-07-06

### Features
- **wallet:** Adopt chia-provider v0.2.0 (CHIP-0002 codes, boolean connect, events) (#48)

## [1.32.0] - 2026-07-06

### Features
- **wallet:** Remove all WalletConnect support (pure window.chia injector) (#47)

## [1.31.1] - 2026-07-06

### Bug Fixes
- **wallet:** Forward assetId in SW prepareSend so a CAT sends as the CAT (#46)

## [1.31.0] - 2026-07-06

### Features
- **wallet:** Granular revocable permissions + Connected-sites UI (#67 P0-4) (#45)

## [1.30.0] - 2026-07-06

### Features
- **wallet:** Phishing / malicious-origin protection before connect & sign (#67 P0-2) (#44)

## [1.29.1] - 2026-07-06

### Bug Fixes
- **ux:** Send copy bug, modal focus-trap, undefined CSS classes (#53 audit polish) (#43)

## [1.29.0] - 2026-07-06

### Features
- **wallet:** Anti-drainer spend-risk heuristics + high-risk approve gate (#67 P0-3) (#42)

## [1.28.7] - 2026-07-06

### CI
- Publish to Chrome Web Store on version tags, skipping gracefully when creds unset (#41)

## [1.28.6] - 2026-07-06

### Bug Fixes
- **appview:** Render on.dig.net dApps in-window via a framing-bypass DNR rule (#66) (#40)

## [1.28.5] - 2026-07-06

### Features
- **build:** Supply-chain lockdown for dependency install scripts (deny + allowlist) (#39)

## [1.28.4] - 2026-07-06

### Bug Fixes
- **wallet:** Render recovery-phrase reveal in a closed shadow root (DOM-scrape protection) (#38)

## [1.28.3] - 2026-07-06

### Bug Fixes
- **app:** Batch RTK notifications on microtask tick to end rAF-after-teardown test flake (#37)

## [1.28.2] - 2026-07-06

### Refactor
- Complete §6.4 reorg — migrate root modules to src/, bundle the MV3 SW (#68) (#36)

## [1.28.1] - 2026-07-05

### Refactor
- Consolidate legacy root modules into src/ (§6.4, #68) (#35)

## [1.28.0] - 2026-07-05

### Refactor
- **entry:** Build the injected provider + store interceptor as TS entries (#34)

## [1.27.0] - 2026-07-05

### Refactor
- **entry:** Build DIG Home (new tab) as a TS entry under src/ (#33)

## [1.26.0] - 2026-07-05

### Refactor
- **entry:** Build the DIG Viewer page as a TS entry under src/ (#31)

## [1.25.0] - 2026-07-05

### Refactor
- **entry:** Build the DIG settings (options) page as a TS entry under src/ (#29)

## [1.24.0] - 2026-07-05

### Refactor
- **entry:** Build the welcome page as a TS entry under src/ (#28)

## [1.23.0] - 2026-07-05

### Refactor
- Remove dead legacy vanilla popup (superseded by the React shell) (#27)

## [1.22.2] - 2026-07-05

### Bug Fixes
- **apps:** Render launcher icons as borderless phone-style tiles (#26)

## [1.22.1] - 2026-07-05

### Bug Fixes
- **wallet:** Derive getLockState purely from storage (no offscreen round-trip) (#25)

## [1.22.0] - 2026-07-05

### Features
- **wallet:** SW-summoned dApp walletRpc approval window (self-custody signing) (#24)

## [1.21.0] - 2026-07-05

### Features
- NFTs + Collectibles — list, detail, and transfer the wallet's NFTs (#56) (#23)

## [1.20.0] - 2026-07-05

### Features
- **i18n:** Add the 13 non-English wallet locale catalogs (#22)

## [1.19.0] - 2026-07-05

### Features
- In-window dApp app-view + inline bug-report entry (#65 Part B.2) (#21)

## [1.18.0] - 2026-07-05

### Features
- Mobile-OS shell — Home launcher + sticky phone nav + Network grouping (#65 Part B) (#20)

## [1.17.0] - 2026-07-05

### Features
- Native dApp launcher from /store.json — replace the Apps iframe (#65) (#19)

## [1.16.0] - 2026-07-05

### Features
- Trade offers — make/inspect/take/cancel with two-party simulator proof (#56) (#18)

## [1.15.0] - 2026-07-05

### Features
- Activity indexer §4.3 — reconstructed ledger in the Activity tab (#56) (#17)

## [1.14.0] - 2026-07-05

### Features
- CAT send — lineage reconstruction + asset picker (#56) (#16)

## [1.13.0] - 2026-07-05

### Features
- XCH Send flow — prepare/approve/confirm + optimistic polling (#56) (#15)

## [1.12.0] - 2026-07-05

### Features
- XCH send construction core — build + decode + simulator-validated (#56) (#14)

## [1.11.0] - 2026-07-05

### Features
- Signing spike — own-spend + from_coin_spends signing via shipped wasm (#56) (#13)

## [1.10.0] - 2026-07-05

### Features
- Read-only HD-scan balances (Sage → custody) via offscreen wasm + coinset (#56) (#12)

## [1.9.0] - 2026-07-05

### Features
- Self-custody onboarding + unlock UI + landing gate (#56) (#11)

## [1.8.0] - 2026-07-05

### Features
- Offscreen keystore vault + SW custody routing + unlock/auto-lock (#56) (#10)

## [1.7.0] - 2026-07-05

### Features
- Custody core - DIGWX1 keystore, BIP-39, both-scheme HD derivation (#56) (#9)

## [1.6.0] - 2026-07-05

### Features
- Dual-layout React shell — wallet Phase 0 (Balances & Intents) + Apps tab (#56, #59) (#8)

## [1.5.1] - 2026-07-05

### Bug Fixes
- Fully URL-decode the dig-viewer urn query param (#55) (#7)

## [1.5.0] - 2026-07-05

### Features
- Resolve store relative links/assets via an in-page interceptor (#55) (#6)

## [1.4.1] - 2026-07-05

### CI
- Attach release zip from repo-root path (was dist/*.zip, matched nothing) (#5)

## [1.4.0] - 2026-07-05

### Features
- Full DIG Browser wallet parity in the Wallet tab (#4)

## [1.3.0] - 2026-07-05

### Features
- Dark-theme 4-tab popup (Resolver · Wallet · Shield · Control Panel) (#3)

## [1.2.0] - 2026-07-04

### Bug Fixes
- Pure-RPC-consumer SoC — remove content caching, fix custom-node override (#2)

## [1.1.1] - 2026-07-04

### CI
- Release = downloadable build archive (.zip) on tag; Chrome Web Store publish manual until hooked up (#230)- Add PR quality gates (test/coverage/build) [#230] (#1)

## [1.1.0] - 2026-07-04

### Features
- More robust dig:// handling- Working concept- Prototype 2- Use the real rpc.dig.net dig.getContent protocol + client-side WASM decryption- Complete rpc.dig.net coverage — page-context fetch bridge + private-store salt + endpoint-keyed cache- **rpc:** Rpc.dig.net integration updates across framework + docs- Dig.local-preferred local-node resolution + install prompt module (TDD)- Prefer reachable dig-node in fetch path + surface install prompt

### Bug Fixes
- **ext:** Navigation + default fully on rpc.dig.net; drop dead localhost/dig.local content+probe paths; rebuild dist

### Refactor
- Remove dead Framework subsystem; unify parseURN; fix ARCHITECTURE.md

### Documentation
- Add USER_JOURNEY.md (install → onboard → wallet → chia:// → verified → settings)

### Testing
- Coverage for buildCapabilities + dig-urn base36 codec (pre-existing WIP)

### CI
- Add deployment workflow- Publish to Chrome Web Store on v* tag (chrome-webstore-upload-cli)- Enforce version increment in PRs (package.json / Cargo.toml)- Enforce Conventional Commits with commitlint on PRs- Enforce Conventional Commits with commitlint on PRs- Release automation + auto-publish on version tag (#230 auto-publish-everything)

### Chores
- **ext:** Manifest description reflects rpc.dig.net (no longer localhost)- **changelog:** Add git-cliff config for Conventional-Commit changelog

### Background
- Branded error pages, event-driven nav, wallet-attention badge

### Copy
- Dig-companion → dig-node, store id → capsule, welcome "Try it"

### Dig-urn
- Clarify rooted URN = pinned capsule, rootless = latest (doc-only)

### Harden
- **ext:** Bridge validates event.source + dig:// scheme; pass endpoint into fetchContentViaRPC (TOCTOU); robust salt strip

### Merge
- Rpc.dig.net integration (feat/rpc-dig-net)

### Popup
- Demote to a product surface; brand the viewer; $DIG + verified label

### Window.chia
- Goby/CHIP-0002/Sage-WC2 compatibility


