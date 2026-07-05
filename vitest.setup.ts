import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// The shared <BugReportButton> patches console.* to capture logs; in jsdom that recurses on React
// dev warnings. It's third-party (covered by @dignetwork/components' own tests), so stub it to a
// no-op for the unit env — the app-shell tests still assert it mounts via App.tsx importing it.
vi.mock('@dignetwork/components', () => ({ BugReportButton: () => null }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// The popup surface calls window.close() after pop-out / opening a chia:// URL; jsdom's real
// window.close() tears down the document and breaks subsequent tests. Stub it to a no-op.
try {
  Object.defineProperty(window, 'close', { value: () => {}, writable: true, configurable: true });
} catch {
  /* ignore */
}

/**
 * Minimal `chrome.*` stub for the extension surfaces under test. Individual tests override pieces
 * of it (e.g. sendMessage responses) via vi.spyOn / reassignment. Kept intentionally small — the
 * RTK Query baseQuery + storage-sync middleware are what actually exercise it.
 */
type Listener = (...args: unknown[]) => void;
function makeEvent() {
  const listeners = new Set<Listener>();
  return {
    addListener: (fn: Listener) => listeners.add(fn),
    removeListener: (fn: Listener) => listeners.delete(fn),
    hasListener: (fn: Listener) => listeners.has(fn),
    _emit: (...args: unknown[]) => listeners.forEach((fn) => fn(...args)),
  };
}

const store: Record<string, unknown> = {};
const chromeStub = {
  runtime: {
    id: 'test-extension',
    lastError: undefined as undefined | { message: string },
    getURL: (p: string) => `chrome-extension://test-extension/${p}`,
    sendMessage: vi.fn((_msg: unknown, cb?: (r: unknown) => void) => {
      if (cb) cb({ success: true });
      return Promise.resolve({ success: true });
    }),
    onMessage: makeEvent(),
    openOptionsPage: vi.fn(),
    getManifest: () => ({ version: '0.0.0-test' }),
  },
  storage: {
    local: {
      get: vi.fn((keys?: unknown) => {
        if (keys == null) return Promise.resolve({ ...store });
        if (typeof keys === 'string') return Promise.resolve({ [keys]: store[keys] });
        if (Array.isArray(keys)) {
          const out: Record<string, unknown> = {};
          for (const k of keys) out[k] = store[k];
          return Promise.resolve(out);
        }
        return Promise.resolve({ ...store });
      }),
      set: vi.fn((obj: Record<string, unknown>) => {
        Object.assign(store, obj);
        return Promise.resolve();
      }),
      remove: vi.fn((k: string) => {
        delete store[k];
        return Promise.resolve();
      }),
    },
    session: {
      get: vi.fn(() => Promise.resolve({})),
      set: vi.fn(() => Promise.resolve()),
    },
    onChanged: makeEvent(),
  },
  tabs: {
    create: vi.fn(() => Promise.resolve({ id: 1 })),
    query: vi.fn(() => Promise.resolve([])),
    update: vi.fn(() => Promise.resolve({})),
  },
};

// @ts-expect-error — assign the partial stub onto the global for the extension code under test.
globalThis.chrome = chromeStub;
