import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderWithProviders } from '@/test/harness';
import { QrScanner } from '@/features/wallet/custody/QrScanner';

vi.mock('jsqr', () => ({ default: vi.fn() }));
import jsQR from 'jsqr';

/** A fake MediaStream with a single video track whose `.stop()` is spy-able. */
function fakeStream() {
  const stop = vi.fn();
  return { stream: { getTracks: () => [{ stop }] } as unknown as MediaStream, stop };
}

/** Stub requestAnimationFrame onto a macrotask (`setTimeout(…, 0)`) instead of real frame timing —
 * fast and deterministic under `waitFor`'s real-timer polling, and (unlike calling the callback
 * synchronously) never recurses the scan loop onto itself before an unmount/stop can be observed. */
function stubRaf() {
  const orig = window.requestAnimationFrame;
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0) as unknown as number) as typeof window.requestAnimationFrame;
  return () => {
    window.requestAnimationFrame = orig;
  };
}

/** jsdom has no real canvas rendering — stub 2D context + video dimensions so the capture loop runs. */
function stubCanvasAndVideo() {
  const getImageData = vi.fn(() => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }) as ImageData);
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn(), getImageData })) as never;
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 640 });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 480 });
  Object.defineProperty(HTMLVideoElement.prototype, 'readyState', { configurable: true, get: () => 4 });
  HTMLVideoElement.prototype.play = vi.fn(() => Promise.resolve());
}

let restoreRaf: () => void;
beforeEach(() => {
  restoreRaf = stubRaf();
  stubCanvasAndVideo();
});
afterEach(() => {
  restoreRaf();
  vi.restoreAllMocks();
  // @ts-expect-error test cleanup
  delete navigator.mediaDevices;
});

describe('QrScanner (#107)', () => {
  it('requests the camera, scans, and calls onScan when a code decodes', async () => {
    const { stream } = fakeStream();
    const getUserMedia = vi.fn(() => Promise.resolve(stream));
    Object.assign(navigator, { mediaDevices: { getUserMedia } });
    vi.mocked(jsQR).mockReturnValue({ data: 'xch1scannedaddress' } as never);

    const onScan = vi.fn();
    renderWithProviders(<QrScanner onScan={onScan} onClose={() => {}} />);

    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    await waitFor(() => expect(onScan).toHaveBeenCalledWith('xch1scannedaddress'));
  });

  it('stops every camera track when it unmounts (never leaves the camera running)', async () => {
    const { stream, stop } = fakeStream();
    const getUserMedia = vi.fn(() => Promise.resolve(stream));
    Object.assign(navigator, { mediaDevices: { getUserMedia } });
    vi.mocked(jsQR).mockReturnValue(null); // never decodes — stays "scanning" until unmount

    const { unmount } = renderWithProviders(<QrScanner onScan={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    act(() => unmount());
    expect(stop).toHaveBeenCalled();
  });

  it('shows a graceful permission-denied state and lets the user cancel', async () => {
    const getUserMedia = vi.fn(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));
    Object.assign(navigator, { mediaDevices: { getUserMedia } });

    const onClose = vi.fn();
    renderWithProviders(<QrScanner onScan={() => {}} onClose={onClose} />);

    expect(await screen.findByTestId('qr-scanner-error')).toBeInTheDocument();
    expect(screen.getByTestId('qr-scanner-error')).toHaveTextContent(/camera/i);
    fireEvent.click(screen.getByTestId('qr-scanner-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows a graceful no-camera-found state', async () => {
    const getUserMedia = vi.fn(() => Promise.reject(new DOMException('none', 'NotFoundError')));
    Object.assign(navigator, { mediaDevices: { getUserMedia } });
    renderWithProviders(<QrScanner onScan={() => {}} onClose={() => {}} />);
    expect(await screen.findByTestId('qr-scanner-error')).toBeInTheDocument();
  });

  it('shows the unsupported state without ever calling getUserMedia when the camera API is absent', async () => {
    // @ts-expect-error simulate no camera API at all (older/locked-down context)
    delete navigator.mediaDevices;
    renderWithProviders(<QrScanner onScan={() => {}} onClose={() => {}} />);
    expect(await screen.findByTestId('qr-scanner-error')).toBeInTheDocument();
  });

  it('Cancel closes the scanner while actively scanning too', async () => {
    const { stream, stop } = fakeStream();
    Object.assign(navigator, { mediaDevices: { getUserMedia: vi.fn(() => Promise.resolve(stream)) } });
    vi.mocked(jsQR).mockReturnValue(null);
    const onClose = vi.fn();
    renderWithProviders(<QrScanner onScan={() => {}} onClose={onClose} />);
    fireEvent.click(await screen.findByTestId('qr-scanner-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalled(); // closing mid-scan still stops the camera
  });
});
