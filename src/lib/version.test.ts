import { describe, it, expect } from 'vitest';
import { appVersion, versionLabel, publishVersionGlobal } from '@/lib/version';

describe('version', () => {
  it('reads the build-injected version', () => {
    expect(appVersion()).toBe('0.0.0-test');
    expect(versionLabel()).toBe('v0.0.0-test');
  });

  it('publishes the version to window.__APP_VERSION__', () => {
    publishVersionGlobal();
    expect((window as unknown as { __APP_VERSION__: string }).__APP_VERSION__).toBe('0.0.0-test');
  });
});
