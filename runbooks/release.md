# Runbook — releasing the DIG Chrome extension (nightly cron + manual dispatch)

How this extension is built and released. Releases are **batched to a nightly cron + manual
dispatch** (#596, epic #590), NOT cut on every merge to `main`. The normative contract is `SPEC.md`
§19. This is the JS / Chrome-Web-Store adaptation of the ecosystem's reference nightlies system
(`DIG-Network/dig-updater`).

## TL;DR

- Releases are **NOT cut on merge to `main`**. They are batched to a **nightly cron at midnight UTC**
  plus **manual dispatch** (`nightly-release.yml`).
- **Stable** (`vX.Y.Z`): cut automatically when the `package.json` version was bumped (detected as
  "the `vX.Y.Z` tag doesn't exist yet"), or on demand. `prerelease: false`, marked `latest`. The
  `v*` tag fires `deploy.yml` (zip on the GitHub Release) + `publish-chrome-web-store.yml` (Web Store).
- **Nightly**: built every night from `main` HEAD as a **pre-release** zip under a dated tag
  `nightly-YYYYMMDD` + a rolling `nightly` tag. `prerelease: true`, never `latest`. Keeps the newest
  14 dated nightlies. **Sideload only — never pushed to the Chrome Web Store.**

## Prerequisites / credentials

- **`RELEASE_TOKEN`** — an org-level classic PAT (the ecosystem release token). Both channels no-op
  with a warning if it is absent. Used to push the changelog commit past branch protection and to
  push tags that trigger downstream workflows (`GITHUB_TOKEN` cannot do either). Set org-wide, or per
  repo under Settings → Secrets → Actions.
- **`CHROME_*`** (stable Web-Store publish only) — `CHROME_EXTENSION_ID`, `CHROME_CLIENT_ID`,
  `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN`. When absent, `publish-chrome-web-store.yml` skips
  gracefully (green) and the downloadable zip on the GitHub Release is the install path. The nightly
  channel needs NONE of these (it never touches the Web Store).

## If nightlies silently stop — check for the 60-day cron auto-disable

GitHub disables a `schedule:` trigger after **60 days of no repo activity** on a public repo, with
**no automatic re-enable** — and since this cron is the *only* automatic release trigger (there is
no more push-to-main tagger), a quiet repo can go dark with no error anywhere. If nightlies (or a
long-overdue stable release) stop appearing:

```bash
gh api repos/DIG-Network/dig-chrome-extension/actions/workflows/nightly-release.yml --jq .state
# "disabled_inactivity" means GitHub turned it off — re-enable it:
gh workflow enable nightly-release.yml --repo DIG-Network/dig-chrome-extension
```

Any repo activity (a merged PR, a manual dispatch) resets the 60-day counter, so this normally only
bites a repo that goes fully quiet for two months.

## Cut a STABLE release (the normal path)

1. In your feature PR, bump `.version` in `package.json` per SemVer (the version-increment CI gate
   requires the bump). Merge the PR (squash) as usual.
2. Nothing releases on merge. At the next **midnight UTC** the `nightly-release.yml` cron runs its
   **stable** job: it sees the new version has no `vX.Y.Z` tag, regenerates `CHANGELOG.md` with
   git-cliff, commits `chore(release): vX.Y.Z` to `main`, tags it, and pushes with `RELEASE_TOKEN`.
3. The pushed `v*` tag fires `deploy.yml` (builds + packages the zip, attaches it to the stable
   GitHub Release) and `publish-chrome-web-store.yml` (uploads + publishes to the Web Store when the
   `CHROME_*` secrets are set).

### Cut a stable release NOW (don't wait for midnight)

Actions → **Nightly + stable release** → **Run workflow** → `channel: stable` (or `both`) → Run.
Same logic as the cron, on demand.

### Re-cut / re-release the current version (e.g. after a failed build)

Actions → **Nightly + stable release** → **Run workflow** → `channel: stable`, **`force: true`** →
Run. `force` bypasses the skip-if-tagged guard and moves the existing `vX.Y.Z` tag onto a fresh
changelog commit (`main` is never force-pushed), re-firing `deploy.yml`.

`force` is guarded, not a blanket override (R1): it REFUSES (non-zero exit, clear error) when the tag
already has a PUBLISHED release AND currently points at a different commit than this run would build
— that combination would silently overwrite a shipped release's zip/Web-Store build with different
code under the same version. It only proceeds for a same-commit retry (the failed-build case above)
or a tag with no published release yet. If you actually need to ship new code, bump `package.json`
and let a normal (non-force) run cut the next version instead.

## Cut a NIGHTLY on demand

Actions → **Nightly + stable release** → **Run workflow** → `channel: nightly` (or `both`) → Run. It
builds `main` HEAD, packages the zip, publishes/refreshes today's `nightly-YYYYMMDD` pre-release,
moves the rolling `nightly` tag to it, and prunes old nightlies.

## How nightlies work (details)

- **Version string:** `X.Y.Z-nightly.YYYYMMDD.<shortsha>` synthesized at build time (nothing is
  committed). Stamped into `package.json` in the CI workspace only, so `build.js` + Vite carry it into
  the manifest `version_name`, `__APP_VERSION__`, `agent-surface.json`, and the zip name; the manifest
  `version` keeps the Chrome-valid dotted base (`SPEC.md` §13). As a semver prerelease it sorts below
  the plain `X.Y.Z`.
- **Install:** download the zip from the GitHub pre-release, unzip, and load it unpacked
  (`chrome://extensions` → Developer mode → Load unpacked). Nightlies are **sideload only** — they are
  never published to the Chrome Web Store.
- **Tags:** an immutable dated `nightly-YYYYMMDD` (history) + a force-moved rolling `nightly` (always
  the newest — the stable "latest nightly" download URL:
  `https://github.com/DIG-Network/dig-chrome-extension/releases/download/nightly/...`).
- **Retention:** the newest **14** dated nightlies + the rolling `nightly` are kept; older dated
  pre-releases and their tags are pruned together (`gh release delete --cleanup-tag`). Tune via the
  `KEEP_NIGHTLIES` env in `nightly-release.yml`. `v*` stable releases are never pruned.
- **Idempotent:** a same-day re-run refreshes today's release instead of erroring.

## Verify a release went live

- **Stable:** `gh release view vX.Y.Z --repo DIG-Network/dig-chrome-extension` — the
  `dig-network-extension-vX.Y.Z.zip` asset attached, `prerelease: false`, marked latest. Watch the
  build: `gh run watch <id>`.
- **Nightly:** `gh release view nightly --repo DIG-Network/dig-chrome-extension` (rolling) or
  `gh release view nightly-YYYYMMDD` — `prerelease: true`, the nightly zip attached.

## Workflows

| File | Trigger | Role |
|---|---|---|
| `nightly-release.yml` | midnight-UTC cron + `workflow_dispatch` | Orchestrator: stable (changelog + tag) + nightly (build + pre-release zip + prune). |
| `deploy.yml` | `push: tags: v*` (+ dispatch canary) | Builds + packages the zip and attaches it to the stable Release for a `vX.Y.Z` tag. |
| `publish-chrome-web-store.yml` | `push: tags: v*` (+ dispatch) | Uploads + publishes the stable zip to the Chrome Web Store (no-op without the `CHROME_*` secrets). |
| `ci.yml` | PR + push to main | The full lint/typecheck/test/coverage/build gate (pre-merge). |

## Local build (dev)

```bash
npm ci
npm run allow-scripts        # re-run the reviewed install-script allowlist (esbuild/@swc)
npm run build                # node build.js -> dist/
npm run build:zip            # + dig-network-extension-v<version>.zip
npm run test:node            # the build/wiring assertion suite (includes the workflow-shape guard)
```
