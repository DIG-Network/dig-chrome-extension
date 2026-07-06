import { describe, it, expect } from 'vitest';
import { buildFramingBypassRule, APPVIEW_FRAMING_RULE_ID, FRAMED_HOST } from '@/lib/framing-rule';

describe('buildFramingBypassRule (#66)', () => {
  it('strips X-Frame-Options + CSP for on.dig.net sub-frames only', () => {
    const rule = buildFramingBypassRule();
    expect(rule.id).toBe(APPVIEW_FRAMING_RULE_ID);
    expect(rule.condition.requestDomains).toEqual([FRAMED_HOST]);
    // Never a top-level navigation — only iframe embeds, so the strip cannot weaken a real page load.
    expect(rule.condition.resourceTypes).toEqual(['sub_frame']);
    const removed = rule.action.responseHeaders.map((h) => h.header);
    expect(removed).toContain('x-frame-options');
    expect(removed).toContain('content-security-policy');
    expect(rule.action.responseHeaders.every((h) => h.operation === 'remove')).toBe(true);
  });

  it('pins the rule to a specific tab when one is given (tight scoping)', () => {
    expect(buildFramingBypassRule(7).condition.tabIds).toEqual([7]);
  });

  it('omits tabIds for the popup context (no tab: undefined or -1)', () => {
    expect(buildFramingBypassRule().condition.tabIds).toBeUndefined();
    expect(buildFramingBypassRule(-1).condition.tabIds).toBeUndefined();
  });
});
