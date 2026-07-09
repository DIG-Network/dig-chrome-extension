/**
 * Trigger a client-side file download of in-memory text (#115 keystore backup export) via a blob
 * URL + a synthetic `<a download>` click. No `chrome.downloads` permission is needed — this is the
 * same approach any web page uses. The object URL is revoked on the next tick so the browser has
 * time to start the download before the blob is freed. `injected` is a DI seam for unit tests
 * (jsdom has no real download); production passes nothing and uses the DOM.
 */
export function downloadTextFile(
  filename: string,
  text: string,
  mime = 'application/json',
  injected?: {
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
    click?: (a: HTMLAnchorElement) => void;
  },
): void {
  const createObjectURL = injected?.createObjectURL ?? ((b: Blob) => URL.createObjectURL(b));
  const revokeObjectURL = injected?.revokeObjectURL ?? ((u: string) => URL.revokeObjectURL(u));
  const url = createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  (injected?.click ?? ((el: HTMLAnchorElement) => el.click()))(a);
  a.remove();
  setTimeout(() => revokeObjectURL(url), 0);
}
