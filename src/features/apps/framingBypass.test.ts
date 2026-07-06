import { describe, it, expect, vi, afterEach } from 'vitest';
import { isFramedDigHost, enableFramingBypass, disableFramingBypass } from '@/features/apps/framingBypass';

afterEach(() => vi.restoreAllMocks());

describe('isFramedDigHost (#66)', () => {
  it('matches on.dig.net and its subdomains', () => {
    expect(isFramedDigHost('https://on.dig.net/')).toBe(true);
    expect(isFramedDigHost('https://hashtunes.on.dig.net/x')).toBe(true);
    expect(isFramedDigHost('https://a.b.on.dig.net')).toBe(true);
  });

  it('rejects non-on.dig.net hosts and lookalikes', () => {
    expect(isFramedDigHost('https://dig.net/')).toBe(false);
    expect(isFramedDigHost('https://hub.dig.net/')).toBe(false);
    expect(isFramedDigHost('https://evilon.dig.net/')).toBe(false); // subdomain of dig.net, not on.dig.net
    expect(isFramedDigHost('https://on.dig.net.attacker.com/')).toBe(false);
    expect(isFramedDigHost('https://example.com/')).toBe(false);
  });

  it('is safe on empty / malformed input', () => {
    expect(isFramedDigHost('')).toBe(false);
    expect(isFramedDigHost(null)).toBe(false);
    expect(isFramedDigHost(undefined)).toBe(false);
    expect(isFramedDigHost('not a url')).toBe(false);
  });
});

describe('enable/disableFramingBypass (#66)', () => {
  function mockSend(reply: unknown) {
    const fn = vi.fn((_msg: unknown, cb?: (r: unknown) => void) => {
      if (cb) cb(reply);
      return Promise.resolve(reply);
    });
    (chrome.runtime as unknown as { sendMessage: typeof fn }).sendMessage = fn;
    return fn;
  }

  it('enable sends the install request and returns true on success', async () => {
    const send = mockSend({ success: true });
    await expect(enableFramingBypass()).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'appViewFraming', enable: true }),
      expect.any(Function),
    );
  });

  it('enable returns false when the SW declines', async () => {
    mockSend({ success: false });
    await expect(enableFramingBypass()).resolves.toBe(false);
  });

  it('disable sends the remove request (best-effort)', async () => {
    const send = mockSend({ success: true });
    await disableFramingBypass();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'appViewFraming', enable: false }),
      expect.any(Function),
    );
  });
});
