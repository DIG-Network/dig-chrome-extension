import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression: the Chrome Web Store upload was rejected because the manifest `description` was
 * 167 characters — the CWS hard cap is 132. (An earlier upload also died on port-bearing match
 * patterns, guarded separately in `manifest-match-pattern-ports.test.ts`.)
 *
 * This test pins EVERY CWS/Chrome manifest string-field limit so the next upload can't hit another
 * cap silently. It reads the SOURCE `manifest.json` — the file the store zip ships (build.js only
 * injects `version`/`version_name` at build time, never `name`/`description`), so the source copy
 * is exactly what the CWS validator sees for these fields.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifestSource = readFileSync(join(ROOT, "manifest.json"), "utf8");
const manifest = JSON.parse(manifestSource) as {
  name: string;
  short_name?: string;
  description: string;
  version: string;
  default_locale?: string;
};

/** True iff every character is 7-bit ASCII — no multi-byte/mojibake bytes (e.g. a UTF-8 em-dash). */
function isAscii(text: string): boolean {
  return [...text].every((char) => char.charCodeAt(0) <= 0x7f);
}

/** Chrome requires `version` be 1–4 dot-separated integers, each in [0, 65535]. */
function isValidChromeVersion(version: string): boolean {
  const parts = version.split(".");
  if (parts.length < 1 || parts.length > 4) return false;
  return parts.every((part) => /^\d+$/.test(part) && Number(part) <= 65535);
}

describe("manifest CWS field limits", () => {
  it("description is non-empty and within the 132-char CWS cap", () => {
    expect(manifest.description.length).toBeGreaterThan(0);
    expect(
      manifest.description.length,
      `description is ${manifest.description.length} chars; CWS max is 132`,
    ).toBeLessThanOrEqual(132);
  });

  it("description is clean 7-bit ASCII (no mojibake em-dash bytes)", () => {
    // The old copy carried a UTF-8 em-dash that rendered as a bad byte in the store listing.
    expect(isAscii(manifest.description)).toBe(true);
  });

  it("name is non-empty and within the 45-char CWS cap", () => {
    expect(manifest.name.length).toBeGreaterThan(0);
    expect(
      manifest.name.length,
      `name is ${manifest.name.length} chars; CWS max is 45`,
    ).toBeLessThanOrEqual(45);
  });

  it("short_name, when present, is within the 12-char CWS cap", () => {
    if (manifest.short_name === undefined) return;
    expect(
      manifest.short_name.length,
      `short_name is ${manifest.short_name.length} chars; CWS max is 12`,
    ).toBeLessThanOrEqual(12);
  });

  it("version is 1–4 dot-separated integers each ≤ 65535 (the store build uses plain semver)", () => {
    expect(
      isValidChromeVersion(manifest.version),
      `manifest version "${manifest.version}" is not a valid 1–4 part Chrome version`,
    ).toBe(true);
  });

  it("default_locale is present iff the manifest uses __MSG_ placeholders", () => {
    const usesMessages = manifestSource.includes("__MSG_");
    if (usesMessages) {
      expect(
        manifest.default_locale,
        "manifest uses __MSG_ placeholders but declares no default_locale",
      ).toBeTruthy();
    } else {
      expect(
        manifest.default_locale,
        "manifest declares default_locale but uses no __MSG_ placeholders",
      ).toBeUndefined();
    }
  });
});
