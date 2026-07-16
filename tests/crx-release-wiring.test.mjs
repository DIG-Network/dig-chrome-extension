/**
 * Shape guard for the CRX3 self-update publish wiring in the release workflows (#607, WU-1 of #602).
 * The nightly channel (nightly-release.yml) and the stable channel (deploy.yml, on a v* tag) each
 * pack+sign a self-hosted CRX3 and publish it + its Omaha updates.xml to updates.dig.net/ext/<channel>/
 * (hosting provisioned by #608). These invariants keep that wiring from silently regressing:
 *
 *   • signing + publish live in a job bound to the `release` GitHub ENVIRONMENT — the tightest OIDC
 *     binding: EXT_NIGHTLY_CRX_KEY is a release-env secret and the deploy role trusts
 *     `environment:release`, so ONLY that gated job can sign or publish;
 *   • each channel packs its OWN channel's CRX (`--crx --channel nightly|stable`);
 *   • the role/bucket/distribution come from CI variables (UPDATES_EXT_DEPLOY_ROLE / UPDATES_BUCKET
 *     / UPDATES_CF_DISTRIBUTION_ID) — never hardcoded;
 *   • the publish follows the runbook order: the immutable CRX FIRST, then updates.xml LAST, then a
 *     CloudFront invalidation — so the manifest never points at a missing CRX.
 *
 * Read as text (not a YAML parser) on purpose. Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = (name) => readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8');

/** Each channel's signing+publish workflow and the channel token its CRX pack uses. */
const CHANNELS = [
  { name: 'nightly-release.yml', channel: 'nightly' },
  { name: 'deploy.yml', channel: 'stable' },
];

test('each channel packs a signed CRX3 for its OWN channel', () => {
  for (const { name, channel } of CHANNELS) {
    assert.match(
      workflow(name),
      new RegExp(`build\\.js --crx --channel ${channel}`),
      `${name} must pack the CRX with --channel ${channel}`,
    );
  }
});

test('signing + publish are bound to the `release` GitHub environment (tightest OIDC binding)', () => {
  for (const { name } of CHANNELS) {
    assert.ok(workflow(name).includes('environment: release'), `${name} must gate signing/publish on environment: release`);
  }
});

test('the signing key is required inside the gated job (a missing release-env secret errors, never a silent skip)', () => {
  for (const { name } of CHANNELS) {
    const wf = workflow(name);
    assert.ok(wf.includes('EXT_NIGHTLY_CRX_KEY'), `${name} must reference the EXT_NIGHTLY_CRX_KEY release-env secret`);
    assert.match(
      wf,
      /if \[ -z "\$EXT_NIGHTLY_CRX_KEY" \][\s\S]*?::error::[\s\S]*?exit 1/,
      `${name} must fail with an ::error:: when the signing key is absent in the gated job`,
    );
  }
});

test('the deploy role / bucket / distribution come from CI variables, not hardcoded', () => {
  for (const { name } of CHANNELS) {
    const wf = workflow(name);
    assert.ok(wf.includes('vars.UPDATES_EXT_DEPLOY_ROLE'), `${name} must assume vars.UPDATES_EXT_DEPLOY_ROLE`);
    assert.ok(wf.includes('vars.UPDATES_BUCKET'), `${name} must use vars.UPDATES_BUCKET`);
    assert.ok(wf.includes('vars.UPDATES_CF_DISTRIBUTION_ID'), `${name} must invalidate vars.UPDATES_CF_DISTRIBUTION_ID`);
    assert.ok(wf.includes('id-token: write'), `${name} must grant id-token: write for OIDC role assumption`);
  }
});

test('the publish follows the runbook: CRX first (immutable), updates.xml last (short-TTL), then invalidate', () => {
  for (const { name, channel } of CHANNELS) {
    const wf = workflow(name);
    const crxIdx = wf.indexOf('"$CRX" "s3://');
    const xmlIdx = wf.indexOf('updates.xml "s3://');
    assert.ok(crxIdx > -1 && xmlIdx > -1, `${name} must upload both the CRX and updates.xml to S3`);
    assert.ok(crxIdx < xmlIdx, `${name} must upload the CRX BEFORE updates.xml (manifest never points at a missing CRX)`);
    assert.ok(
      wf.includes('max-age=31536000, immutable') && wf.includes('application/x-chrome-extension'),
      `${name} must serve the CRX immutable with the chrome-extension content type`,
    );
    assert.ok(
      wf.includes('max-age=60, must-revalidate') && wf.includes('text/xml'),
      `${name} must serve updates.xml short-TTL as text/xml`,
    );
    assert.ok(wf.includes(`/ext/${channel}/*`), `${name} must invalidate /ext/${channel}/* on CloudFront`);
    assert.ok(wf.includes(`ext/${channel}/`), `${name} must publish under the ext/${channel}/ prefix`);
  }
});

test('the automated sideload nightly stays UNgated (only the CRX publish job is release-gated)', () => {
  const wf = workflow('nightly-release.yml');
  // The `nightly` build job publishes the sideload zip on cron with no environment gate; the
  // separate `nightly-publish-crx` job carries environment: release.
  assert.match(wf, /nightly-publish-crx:/, 'a dedicated gated CRX-publish job must exist');
  assert.match(wf, /needs: nightly/, 'the gated job must depend on the ungated nightly build job');
});
