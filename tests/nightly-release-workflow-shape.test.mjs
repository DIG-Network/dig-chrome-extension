/**
 * Shape guard for the professional nightlies release system (#596, epic #590).
 *
 * This repo converted from "tag-and-release-on-every-merge-to-main" to a nightly cron + manual
 * dispatch orchestrator (`.github/workflows/nightly-release.yml`), stack-adapted for the JS /
 * Chrome-Web-Store extension. These tests pin the load-bearing shape so a careless edit — or a
 * copy that drifts from the validated dig-updater reference — cannot silently revert the release
 * model or reintroduce a footgun:
 *
 *   1. The tagger NO LONGER triggers on push-to-main (the whole point of #590 — releases are
 *      batched to a nightly cron + manual dispatch instead of firing per merge).
 *   2. It DOES trigger on a midnight-UTC `schedule` cron and on `workflow_dispatch`, with the
 *      `channel` (stable|nightly|both) + `force` inputs.
 *   3. The STABLE channel keeps its idempotency keystone: skip cutting `vX.Y.Z` when that tag
 *      already exists (an unchanged version = the tag exists = a no-op), and pins `ref: main`.
 *   4. `force` is guarded (R1): it refuses to move a PUBLISHED release's tag onto a different
 *      commit — a same-commit re-cut or a no-release tag-repair is still allowed.
 *   5. The NIGHTLY channel publishes a `prerelease: true` GitHub release under BOTH a dated
 *      `nightly-YYYYMMDD` tag and a force-moved rolling `nightly` tag, is never `latest`, prunes
 *      old dated nightlies to a retention window, and is GitHub-zip-ONLY — it MUST NOT publish to
 *      the Chrome Web Store (review latency + would ship unstable to every user).
 *   6. Both channels no-op cleanly without RELEASE_TOKEN (a warning, never a half-release).
 *   7. The STABLE build/publish (deploy.yml + web-store publish) is tag-triggered, NOT on every
 *      merge to main — coherent with #590 ("nothing releases on merge").
 *
 * The guard reads the workflows as text (not a YAML parser) on purpose: the invariants are about
 * the literal trigger/step shape a maintainer reads, it has no external dependency, and it fails
 * with a message pointing at the exact line to fix.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Read a workflow file under `.github/workflows/` as text. */
function workflow(name) {
  const path = join(ROOT, '.github', 'workflows', name);
  return readFileSync(path, 'utf8');
}

/** The nightly + manual-dispatch release ORCHESTRATOR — the converted on-merge tagger. */
const nightlyRelease = () => workflow('nightly-release.yml');

/**
 * Extract a single job's body from a workflow: the lines from `  <job>:` (a 2-space-indented key
 * under `jobs:`) up to the next 2-space-indented job key. Used to assert an invariant against ONE
 * job's steps without being tripped by header prose or a sibling job.
 */
function jobBlock(wf, job) {
  const lines = [];
  let inJob = false;
  for (const line of wf.split('\n')) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(line)) {
      // A 2-space-indented job key: enter our job, or (if we were in it) stop at the next sibling.
      if (line.trimEnd() === `  ${job}:`) {
        inJob = true;
        continue;
      }
      if (inJob) break;
    }
    if (inJob) lines.push(line);
  }
  return lines.join('\n');
}

/**
 * Extract a workflow's top-level `on:` trigger block: the lines from `on:` (exclusive) up to the
 * next top-level key (a column-0, non-comment `word:` such as `jobs:`/`concurrency:`). Everything
 * nested under `on:` stays; sibling top-level keys are excluded.
 */
function triggersBlock(wf) {
  const lines = [];
  let inOn = false;
  for (const line of wf.split('\n')) {
    if (line.trimStart() === 'on:' && !line.startsWith(' ')) {
      inOn = true;
      continue;
    }
    if (inOn) {
      const isTopLevelKey =
        line.length > 0 && !line.startsWith(' ') && !line.startsWith('#') && line.includes(':');
      if (isTopLevelKey) break;
      lines.push(line);
    }
  }
  return lines.join('\n');
}

test('the tagger no longer triggers on push to main', () => {
  const on = triggersBlock(nightlyRelease());
  assert.ok(
    !on.includes('push:'),
    `nightly-release.yml still declares a \`push:\` trigger — #590 removed push-to-main so releases ` +
      `are cut by the nightly cron + manual dispatch, NOT on every merge. \`on:\` block:\n${on}`,
  );
});

test('the tagger triggers on a midnight-UTC cron and on manual dispatch', () => {
  const on = triggersBlock(nightlyRelease());
  assert.ok(on.includes('schedule:'), `nightly-release.yml must trigger on a \`schedule:\` cron.\n${on}`);
  assert.ok(
    on.includes('0 0 * * *'),
    `the nightly cron must be \`0 0 * * *\` (midnight UTC — GitHub cron is UTC).\n${on}`,
  );
  assert.ok(
    on.includes('workflow_dispatch:'),
    `nightly-release.yml must support \`workflow_dispatch:\` so a maintainer can cut a release on demand.\n${on}`,
  );
});

test('manual dispatch exposes the channel + force inputs', () => {
  const on = triggersBlock(nightlyRelease());
  assert.ok(on.includes('channel:'), `workflow_dispatch must expose a \`channel\` input (stable|nightly|both).\n${on}`);
  assert.ok(on.includes('force:'), `workflow_dispatch must expose a \`force\` input (re-cut a stable release).\n${on}`);
});

test('the stable job pins ref: main and keeps the skip-if-already-tagged guard', () => {
  const wf = nightlyRelease();
  // Pinning `ref: main` makes the `HEAD:main` push unambiguous — the changelog commit + tag can
  // only ever land on main HEAD (opus hardening the fan-out copies carry).
  assert.ok(wf.includes('ref: main'), 'the stable checkout must pin `ref: main`');
  // The idempotency keystone: an unchanged version means `vX.Y.Z` already exists, so the run must
  // skip cutting it. Both the tag-existence check and the skip signal must survive the conversion.
  assert.ok(wf.includes('refs/tags/$TAG'), 'the stable job must still check whether the version tag already exists');
  assert.ok(wf.includes('skip=true'), 'the stable job must still short-circuit (skip=true) when the tag already exists');
});

test('the stable job reads the version from package.json (JS stack)', () => {
  const wf = nightlyRelease();
  // This is the JS/web-store stack — the version source of truth is package.json, not Cargo.toml.
  assert.ok(wf.includes('package.json'), 'the stable job must resolve the version from package.json');
});

test('force re-cut refuses to move a PUBLISHED release onto a different commit (R1)', () => {
  const wf = nightlyRelease();
  // Supply-chain guard: `force=true` may re-cut the SAME commit (a failed-build retry) or repair a
  // tag with no published release, but must NEVER silently move an existing PUBLISHED release's tag
  // onto a DIFFERENT commit — that overwrites shipped artifacts with unreviewed code under the same
  // version. The force branch must resolve both commits, check for a published (non-draft) release,
  // and refuse with a non-zero exit when both are true.
  assert.ok(
    wf.includes('TAG_COMMIT') && wf.includes('HEAD_COMMIT'),
    'the force branch must resolve both the existing tag commit and this run target commit to compare them',
  );
  assert.ok(
    wf.includes('gh release view "$TAG"') && wf.includes('isDraft'),
    'the force branch must check for a PUBLISHED (non-draft) release via `gh release view ... --json isDraft`',
  );
  assert.ok(
    wf.includes('IS_PUBLISHED_RELEASE') && wf.includes('TAG_COMMIT" != "$HEAD_COMMIT'),
    'the force branch must refuse specifically when the release is published AND the tag commit differs from target',
  );
  assert.ok(
    wf.includes('::error::refusing to force-move'),
    'the refusal must surface as an `::error::` annotation, not a silent skip',
  );
});

test('the nightly job publishes a dated + a rolling pre-release', () => {
  const wf = nightlyRelease();
  assert.ok(wf.includes('--prerelease'), 'the nightly job must publish a GitHub PRE-release (`--prerelease`)');
  assert.ok(
    wf.includes('nightly-$DATE') || wf.includes('nightly-${DATE}'),
    'the nightly job must publish under a DATED tag `nightly-YYYYMMDD` (built from $DATE)',
  );
  assert.ok(wf.includes('refs/tags/nightly'), 'the nightly job must force-move a ROLLING `nightly` tag to the newest build');
});

test('the nightly release is never marked latest', () => {
  const wf = nightlyRelease();
  assert.ok(
    wf.includes('--latest=false'),
    'nightly releases must pass `--latest=false` — only a stable release may move `latest`',
  );
  assert.ok(!wf.includes('--latest=true'), 'the nightly job must never mark a release `latest`');
});

test('the nightly job carries the synthesized semver-prerelease version', () => {
  const wf = nightlyRelease();
  // `X.Y.Z-nightly.YYYYMMDD.<shortsha>` sorts below the plain `X.Y.Z`, so a nightly never outranks
  // the stable release of the same version.
  assert.ok(wf.includes('-nightly.'), 'the nightly version must be a semver prerelease (`X.Y.Z-nightly.YYYYMMDD.<sha>`)');
});

test('the nightly job prunes to a retention window (tag + release together)', () => {
  const wf = nightlyRelease();
  assert.ok(wf.includes('KEEP_NIGHTLIES'), 'the nightly job must define a `KEEP_NIGHTLIES` retention count');
  assert.ok(
    wf.includes('--cleanup-tag'),
    'pruning must delete BOTH the GitHub release and its git tag (`gh release delete --cleanup-tag`)',
  );
});

test('nightly retention lists releases in an un-swallowed statement (A3)', () => {
  const wf = nightlyRelease();
  // A real `gh release list` failure (auth/API/network) must red the step, not be masked into a
  // silent empty-prune. The listing runs as its own statement; only the downstream grep no-match is
  // tolerated (`|| [ $? -eq 1 ]`).
  assert.ok(
    wf.includes('gh release list') && wf.includes('|| [ $? -eq 1 ]'),
    'the prune must list releases in its own un-swallowed statement + tolerate only the grep no-match',
  );
});

test('the nightly channel is GitHub-zip-only — never publishes to the Chrome Web Store', () => {
  // Ext adaptation (#596): a nightly is the GitHub pre-release ZIP for sideload ONLY. Auto-publishing
  // a nightly to the Chrome Web Store would ship unstable code to every user (and eat review latency),
  // so the NIGHTLY job must never invoke the web-store publisher. Scoped to the `nightly` job body so
  // header prose documenting the STABLE path's `publish-chrome-web-store.yml` isn't a false positive.
  const nightlyJob = jobBlock(nightlyRelease(), 'nightly');
  assert.ok(nightlyJob.length > 0, 'the workflow must define a `nightly` job');
  assert.ok(
    !nightlyJob.includes('chrome-webstore-upload') && !nightlyJob.includes('publish-chrome-web-store'),
    'the nightly job must NOT publish to the Chrome Web Store — it is a GitHub pre-release ZIP for sideload only',
  );
  assert.ok(
    nightlyJob.includes('--prerelease'),
    'the nightly job must publish its pre-release via a GitHub release (`--prerelease`), not the Web Store',
  );
});

test('both channels no-op without RELEASE_TOKEN', () => {
  const wf = nightlyRelease();
  assert.ok(wf.includes('RELEASE_TOKEN'), 'the release orchestrator must gate on RELEASE_TOKEN');
  assert.ok(wf.includes('::warning::'), 'a missing RELEASE_TOKEN must degrade to a clear `::warning::` no-op');
});

test('the old on-merge tagger workflow (release.yml) is gone', () => {
  // The tagger was CONVERTED + RENAMED to nightly-release.yml; a lingering push:main release.yml
  // would re-tag on every merge and defeat #590.
  assert.throws(
    () => workflow('release.yml'),
    /ENOENT|no such file/i,
    'release.yml (the old push:main tagger) must be removed — it was converted to nightly-release.yml',
  );
});

test('the stable build/publish (deploy.yml) is tag-triggered, not on every merge to main', () => {
  const on = triggersBlock(workflow('deploy.yml'));
  // #590 coherence: nothing builds/publishes on merge. deploy.yml builds + attaches the release zip
  // on a `v*` tag (+ a manual-dispatch canary); it must NOT trigger on a push to a branch.
  assert.ok(on.includes('tags:') && on.includes('v*'), `deploy.yml must still build + attach the zip on a \`v*\` tag.\n${on}`);
  assert.ok(
    !on.includes('branches:'),
    `deploy.yml must NOT trigger on a push to a branch (#590 batches releases to the nightly cron + tags).\n${on}`,
  );
});
