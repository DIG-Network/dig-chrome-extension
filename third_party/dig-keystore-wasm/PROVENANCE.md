# Vendored `@dignetwork/dig-keystore-wasm` — provenance + refresh instructions

This directory is a **vendored copy** of `dig-keystore`'s `wasm-pack build --target bundler
--release` output (`wasm/pkg/` in [DIG-Network/dig-keystore](https://github.com/DIG-Network/dig-keystore)),
consumed by this repo as a `file:` dependency:

```json
"@dignetwork/dig-keystore-wasm": "file:./third_party/dig-keystore-wasm"
```

It lives under `third_party/` (git-TRACKED) rather than `vendor/` — this repo's `vendor/` is
reserved for `scripts/bundle-walletconnect.js`'s generated, gitignored build artifact (see
`.gitignore`); this directory is committed source (a pinned external build), not regenerated
by this repo's own build.

## Why vendored instead of an npm/git dependency

`dig-keystore-wasm` is a Rust crate compiled to wasm — unlike `@dignetwork/chia-provider`
(plain ESM, consumable straight from a `github:` git dependency with no build step),
consuming it as a git dependency would require every install (dev machine AND this repo's
own standalone CI, which clones `DIG-Network/dig-chrome-extension` alone — no sibling
`dig-keystore` checkout) to run a Rust + `wasm-pack` toolchain just to `npm install`. That's
too heavy for a pure JS/TS repo's CI. Vendoring the already-built bundler output (same shape
as `chia-wallet-sdk-wasm`'s published package — `.wasm` + wasm-bindgen JS glue + `.d.ts`,
which Vite's existing `wasm()` + `topLevelAwait()` plugins already handle, see
`vite.config.ts`) needs zero extra toolchain and works identically for every consumer.

This is a temporary stopgap (dig_ecosystem #147 Phase B) pending the real npm publish of
`@dignetwork/dig-keystore-wasm` (blocked on an org-admin one-time bootstrap publish — see
dig-keystore's `SPEC.md` §16.4 / dig_ecosystem #70). Once that publishes, swap the `file:`
dependency above for a normal semver range and delete this directory.

## Provenance of the current vendored build

| Field | Value |
|---|---|
| Source repo | https://github.com/DIG-Network/dig-keystore |
| Source commit | `f70337e343fee3515f42f8560e218eaf2d463d72` (branch `feat/wasm-seal-strong`, PR [#4](https://github.com/DIG-Network/dig-keystore/pull/4)) |
| `dig-keystore-wasm` version | 0.2.0 |
| Build command | `cd wasm && npm run build:bundler` (`wasm-pack build . --target bundler --release --no-opt`) |
| Exports | `init`, `seal`, `sealStrong`, `open`, `verifyPassword`, `sealWithSeed` (test-fixture-only, see its own doc comment) |

## Refreshing this vendor copy

When `dig-keystore-wasm` gains a new export/fix needed here, or once PR #4 above merges to
`dig-keystore` `main`:

1. In `modules/crates/dig-keystore` (or a fresh checkout), fast-forward to the desired
   commit/tag.
2. `cd wasm && npm run build:bundler` — produces `wasm/pkg/`.
3. Copy `wasm/pkg/{dig_keystore_wasm.d.ts,dig_keystore_wasm.js,dig_keystore_wasm_bg.js,dig_keystore_wasm_bg.wasm,dig_keystore_wasm_bg.wasm.d.ts,package.json}`
   over this directory's copies (keep this repo's `PROVENANCE.md`; re-apply the `"private": true`
   tweak to the copied `package.json` if it's missing — the upstream build always emits
   `publishConfig.access:"public"` since it doesn't know it's being vendored).
4. Update the provenance table above (new source commit + version).
5. `npm install` here to refresh `node_modules/@dignetwork/dig-keystore-wasm`, then re-run
   the digwx1/vault test suites + a Playwright unlock/sign smoke pass before shipping.
