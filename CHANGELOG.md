# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org) and
[Conventional Commits](https://www.conventionalcommits.org).

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


