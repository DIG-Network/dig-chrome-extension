import { useCallback, useEffect, useState } from 'react';
import { storageGet, storageSet } from '@/lib/messaging';

/**
 * Read + write a single `chrome.storage.local` key as React state, staying live to external
 * changes via `chrome.storage.onChanged` (so the popup and `app.html` converge — §3.4). Returns
 * `[value, setValue, ready]`; `ready` flips true after the initial read so callers can render a
 * loading state until the durable value is known.
 */
export function useStorageValue<T>(key: string, fallback: T): [T, (v: T) => void, boolean] {
  const [value, setValue] = useState<T>(fallback);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    void storageGet<Record<string, T>>(key).then((out) => {
      if (!live) return;
      if (out[key] !== undefined) setValue(out[key] as T);
      setReady(true);
    });
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return () => { live = false; };
    const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== 'local' || !(key in changes)) return;
      setValue((changes[key].newValue as T) ?? fallback);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(listener);
    };
    // fallback is intentionally not a dep (a stable literal at call sites).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const set = useCallback(
    (v: T) => {
      setValue(v);
      void storageSet({ [key]: v });
    },
    [key],
  );

  return [value, set, ready];
}
