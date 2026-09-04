# Contributing to the DIG Network Browser Extension

A Chromium (MV3) browser extension that brings the DIG Network experience to any browser:
verified + decrypted `chia://` resolution, a self-custody `window.chia` wallet backed by an
offscreen key vault, a DIG-branded new-tab page, and a Control Panel that talks to a local
dig-node.

**This version of the extension is being deprecated in favor of a future replacement.** It is
not actively receiving new feature work — do not open a PR that adds a new capability or
redesigns an existing surface without checking with a maintainer first. Bug reports and
security issues are still welcome and will still be addressed: the extension is installed and
in use, and a real defect in code people are running does not stop mattering because a
replacement is planned.

## Reporting an issue

File at [github.com/DIG-Network/dig-chrome-extension/issues](https://github.com/DIG-Network/dig-chrome-extension/issues).
Include:

- **Observed vs. expected behavior.**
- **Repro steps.**
- **Browser + version**, and **which extension surface** it happened in — popup, options
  page, background service worker, a content script, the offscreen vault, or the `dig-viewer`
  page.

This repo has no `SECURITY.md`, so there is no separate private-disclosure channel today —
file security-sensitive findings (key handling in the offscreen vault, message-router
interception, `chia://` resolution/verification) as a regular issue, but say plainly in the
title/body that it's security-sensitive so it gets triaged first.

## Prerequisites

- **Node 20** (matches every CI workflow's `actions/setup-node`).
- `npm ci` installs with `ignore-scripts=true` set in `.npmrc` (supply-chain lockdown). Run
  `npm run allow-scripts` right after install — it re-runs only the reviewed script allowlist
  (`allowed-install-scripts.json`, mainly esbuild's native setup) that `vite`/`vitest` need.

To load the extension for local dev in Chrome/Edge/Brave:

1. `npm run build` (produces `dist/`).
2. Open `chrome://extensions/` (or `edge://extensions/`).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the `dist` folder.

## Build & test

```bash
npm ci
npm run allow-scripts

npm run build        # node build.js — runs `vite build` internally (dist-web/, the React
                      # popup/options/viewer surfaces), then esbuild-bundles the MV3 service
                      # worker + window.chia provider, and copies everything into dist/
npm run build:zip    # build + package a sideload .zip
npm run typecheck     # tsc -p tsconfig.json --noEmit
npm run lint          # eslint src
npm run test:coverage # test:node (node --test tests/*.test.mjs — build/wiring assertions)
                       # + test:web (vitest run --coverage over src/, gated at >=80%
                       # lines/branches/functions/statements by vitest.config.ts thresholds)
```

## The gate (`.github/workflows/ci.yml`, must pass before a PR merges)

Three required jobs run on every PR to `main`:

- **`test + coverage (Node 20)`** — `npm run allow-scripts && npm run lint && npm run typecheck
  && npm run test:coverage`.
- **`build (Node 20)`** — `npm run allow-scripts && npm run build`.
- **`sw-harness (Node 20)`** — `npm run allow-scripts`, `npx playwright install --with-deps
  chromium`, `npm run build`, then `npm run test:sw` (`playwright test
  --config=playwright.sw.config.ts`): the only gate that loads the **built** unpacked
  extension in a real headless-free Chromium and verifies the MV3 module service worker
  actually registers and its runtime module graph (dig_client wasm, the offscreen vault,
  the message router, `chia://` interception) loads.

Commit messages and the PR title are linted by `commitlint.yml` (`commitlint.config.mjs`,
extending `@commitlint/config-conventional`) — Conventional Commits are enforced.

## PR conventions

- **Conventional Commits** (`feat:`, `fix:`, `docs:`, …) — `commitlint.yml` enforces both
  individual commit messages and the PR title.
- **Bump the version.** `ensure-version-increment.yml` requires `package.json`'s `version` to
  strictly increase over `main` on every PR (there is no `Cargo.toml` in this repo, so only
  `package.json` is checked). You do **not** need to hand-edit `manifest.json`'s `version`
  field to match — `build.js` injects `package.json`'s version into the built
  `dist/manifest.json` at build time (and derives the CRX's dotted/nightly version scheme
  from it), so the source-tree `manifest.json` version is informational only.
- **`main` is protected** — GitHub Flow only: branch, PR, every required check green, zero
  unresolved review threads, then squash-merge. No direct pushes.

## How a merge ships

Releases are **not** cut on every merge to `main` — `nightly-release.yml` batches them:

- A **midnight-UTC cron** builds a nightly pre-release zip from `main` HEAD (sideload-only,
  never published to the Chrome Web Store) and, in the **same run**, can also cut a **stable**
  `vX.Y.Z` tag+release if `package.json`'s version changed since the last tag — the `stable`
  job's condition matches both `schedule` and a manual `channel: stable`/`both` dispatch, so a
  version bump merged to `main` can go out as a stable release automatically at the next
  nightly, not only via manual dispatch.
- A pushed `v*` tag triggers `deploy.yml` (builds the sideload zip + a self-hosted signed CRX3,
  attaches both to the GitHub Release, and publishes the CRX + Omaha `updates.xml` to
  `updates.dig.net/ext/stable/` for force-installed auto-update) and
  `publish-chrome-web-store.yml` (packages a store-valid zip and uploads/publishes it to the
  Chrome Web Store via the official CLI). The Chrome Web Store publish step **skips
  gracefully** rather than failing when the `CHROME_*` OAuth secrets aren't provisioned — this
  is live, real publishing infrastructure, not dormant scaffolding, even while the extension
  version itself is being deprecated.
