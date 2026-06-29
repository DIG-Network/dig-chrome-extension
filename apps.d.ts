// Type declarations for apps.mjs — the DIG Home app directory + omnibox classifier.

/** One DIG Home app-directory entry. `dig:true` marks an on-DIG-Network destination. */
export interface DigApp {
  name: string;
  host: string;
  url: string;
  glyph: string;
  blurb: string;
  chip: string;
  dig?: boolean;
}
export const DIG_APPS: readonly DigApp[];

export interface FooterLink { label: string; url: string }
export const DIG_HOME_FOOTER_LINKS: readonly FooterLink[];

export const WEB_SEARCH_URL: string;

/** Classify an omnibox value: a chia:// address, an http(s) URL/domain, or a web search. */
export function classifyOmnibox(v: string): 'dig' | 'url' | 'search';
/** Resolve a classified omnibox value to the destination URL to navigate to. */
export function omniboxTarget(v: string): string;
