import { test } from 'vitest';
import assert from 'node:assert/strict';
import { digDnsIndicatorView } from '@/lib/dig-dns-status';

test('unknown phase (or no snapshot yet) renders neutral "checking" copy', () => {
  assert.deepEqual(digDnsIndicatorView(undefined), { tone: 'neutral', labelId: 'resolver.digdns.status.unknown' });
  assert.deepEqual(digDnsIndicatorView(null), { tone: 'neutral', labelId: 'resolver.digdns.status.unknown' });
  assert.deepEqual(digDnsIndicatorView({ phase: 'unknown' }), { tone: 'neutral', labelId: 'resolver.digdns.status.unknown' });
});

test('direct phase renders a good/positive tone', () => {
  assert.deepEqual(digDnsIndicatorView({ phase: 'direct' }), { tone: 'good', labelId: 'resolver.digdns.status.direct' });
});

test('proxy phase renders a warn tone (the proxy fallback is actively covering)', () => {
  assert.deepEqual(digDnsIndicatorView({ phase: 'proxy' }), { tone: 'warn', labelId: 'resolver.digdns.status.proxy' });
});

test('unavailable phase renders a neutral "not detected" tone', () => {
  assert.deepEqual(digDnsIndicatorView({ phase: 'unavailable' }), { tone: 'neutral', labelId: 'resolver.digdns.status.unavailable' });
});

test('an unrecognized phase value falls back to the unknown view (defensive)', () => {
  // @ts-expect-error deliberately passing a bad phase to prove the fallback
  assert.deepEqual(digDnsIndicatorView({ phase: 'bogus' }), { tone: 'neutral', labelId: 'resolver.digdns.status.unknown' });
});
