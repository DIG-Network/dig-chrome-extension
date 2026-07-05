# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org) and
[Conventional Commits](https://www.conventionalcommits.org).

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


