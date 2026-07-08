import { describe, it, expect, vi, afterEach } from 'vitest';
import { decodeQrFromImageData, classifyCameraError, isCameraSupported } from '@/lib/qrScan';

vi.mock('jsqr', () => ({
  default: vi.fn(),
}));

import jsQR from 'jsqr';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('decodeQrFromImageData (#107)', () => {
  it('returns the decoded text when jsQR finds a code', () => {
    vi.mocked(jsQR).mockReturnValue({ data: 'xch1recipient' } as never);
    const imageData = { data: new Uint8ClampedArray(4), width: 1, height: 1 } as ImageData;
    expect(decodeQrFromImageData(imageData)).toBe('xch1recipient');
  });

  it('returns null when no code is found in the frame', () => {
    vi.mocked(jsQR).mockReturnValue(null);
    const imageData = { data: new Uint8ClampedArray(4), width: 1, height: 1 } as ImageData;
    expect(decodeQrFromImageData(imageData)).toBeNull();
  });
});

describe('classifyCameraError (#107)', () => {
  it('classifies a permission-denied DOMException', () => {
    expect(classifyCameraError(new DOMException('denied', 'NotAllowedError'))).toBe('permission-denied');
    expect(classifyCameraError(new DOMException('denied', 'SecurityError'))).toBe('permission-denied');
  });

  it('classifies a no-camera-found DOMException', () => {
    expect(classifyCameraError(new DOMException('none', 'NotFoundError'))).toBe('not-found');
    expect(classifyCameraError(new DOMException('none', 'OverconstrainedError'))).toBe('not-found');
  });

  it('classifies anything else as unknown', () => {
    expect(classifyCameraError(new Error('boom'))).toBe('unknown');
    expect(classifyCameraError('not an error')).toBe('unknown');
    expect(classifyCameraError(undefined)).toBe('unknown');
  });
});

describe('isCameraSupported (#107)', () => {
  it('is true when getUserMedia exists', () => {
    Object.assign(navigator, { mediaDevices: { getUserMedia: vi.fn() } });
    expect(isCameraSupported()).toBe(true);
  });

  it('is false when mediaDevices is absent', () => {
    Object.assign(navigator, { mediaDevices: undefined });
    expect(isCameraSupported()).toBe(false);
  });
});
