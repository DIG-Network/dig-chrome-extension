import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression: the Chrome Web Store upload was rejected with
 *   "The manifest defines an invalid url: http://localhost:* (port-wildcard path)"
 * for every loopback `host_permissions` pattern that carried a port — the `http://localhost:*`,
 * `http://127.0.0.1:*`, `http://127.0.0.5:*` variants (and their `ws://` twins).
 *
 * Chrome match patterns MUST NOT contain a port — a match pattern is `<scheme>://<host>/<path>`,
 * and it already matches the host on EVERY port. The self-hosted nightly `.crx` loaded anyway
 * (Chrome is lenient at load time), but the CWS validator is strict and refused the upload.
 *
 * This test pins the invariant so a port can never creep back into a match pattern and silently
 * break the next CWS upload. Match patterns live in `host_permissions`, `content_scripts[].matches`,
 * `web_accessible_resources[].matches`, and `externally_connectable.matches`; the CSP `connect-src`
 * (which legitimately DOES carry ports) is deliberately NOT checked here.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(
  readFileSync(join(ROOT, "manifest.json"), "utf8"),
) as {
  host_permissions?: string[];
  content_scripts?: Array<{ matches?: string[] }>;
  web_accessible_resources?: Array<{ matches?: string[] }>;
  externally_connectable?: { matches?: string[] };
};

/** A Chrome match pattern carries a port iff its host segment contains a colon. */
function patternHasPort(pattern: string): boolean {
  if (pattern === "<all_urls>") return false;
  const withoutScheme = pattern.replace(/^[^:]+:\/\//, "");
  const host = withoutScheme.split("/")[0];
  return host.includes(":");
}

/** Every match pattern in the manifest, tagged with where it came from (for a readable failure). */
function allMatchPatterns(): Array<{ location: string; pattern: string }> {
  const patterns: Array<{ location: string; pattern: string }> = [];
  for (const p of manifest.host_permissions ?? []) {
    patterns.push({ location: "host_permissions", pattern: p });
  }
  for (const p of manifest.externally_connectable?.matches ?? []) {
    patterns.push({ location: "externally_connectable.matches", pattern: p });
  }
  (manifest.content_scripts ?? []).forEach((cs, i) => {
    for (const p of cs.matches ?? [])
      patterns.push({ location: `content_scripts[${i}].matches`, pattern: p });
  });
  (manifest.web_accessible_resources ?? []).forEach((war, i) => {
    for (const p of war.matches ?? [])
      patterns.push({
        location: `web_accessible_resources[${i}].matches`,
        pattern: p,
      });
  });
  return patterns;
}

describe("manifest match patterns (CWS validity)", () => {
  it("contains no match pattern with a port (Chrome/CWS reject them)", () => {
    const offenders = allMatchPatterns()
      .filter(({ pattern }) => patternHasPort(pattern))
      .map(({ location, pattern }) => `${location}: ${pattern}`);
    expect(
      offenders,
      `port-bearing match patterns are invalid for the CWS upload:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("still covers the loopback dig-node hosts the extension dials", () => {
    // http://127.0.0.1:9778 (control) and http://127.0.0.5:80|8053 (dig-dns gateway) are matched by
    // their port-less host_permissions entries; ws control is matched by the ws:// twins.
    const hosts = manifest.host_permissions ?? [];
    expect(hosts).toContain("http://127.0.0.1/*");
    expect(hosts).toContain("http://127.0.0.5/*");
    expect(hosts).toContain("http://localhost/*");
    expect(hosts).toContain("ws://127.0.0.1/*");
    expect(hosts).toContain("ws://127.0.0.5/*");
  });
});
