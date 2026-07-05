# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org) and
[Conventional Commits](https://www.conventionalcommits.org).

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
- Goby/CHIP-0002/Sage-WC2 compatibility (loroco parity)


