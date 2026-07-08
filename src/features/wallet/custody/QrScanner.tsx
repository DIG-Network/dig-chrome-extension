import { useEffect, useRef, useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { decodeQrFromImageData, classifyCameraError, isCameraSupported, type CameraErrorKind } from '@/lib/qrScan';

type Phase = 'requesting' | 'scanning' | 'error';

const ERROR_MESSAGE_ID: Record<CameraErrorKind, string> = {
  'permission-denied': 'send.scan.error.permissionDenied',
  'not-found': 'send.scan.error.notFound',
  unsupported: 'send.scan.error.unsupported',
  unknown: 'send.scan.error.unknown',
};

/**
 * QR camera scanner (#107) — scans a recipient address (or an `offer1…` string) via the device
 * camera and reports the decoded text to `onScan`. FULLSCREEN-ONLY by convention (the caller gates
 * it, mirroring clawback's `full`-only advanced options, §145): a live camera preview needs more
 * room than the compact popup, and Chrome extension popups can lose the permission prompt if the
 * user's OS dialog steals focus and closes the popup.
 *
 * Camera lifecycle: request → scanning (live `<video>` + a `requestAnimationFrame` decode loop over
 * an offscreen `<canvas>` frame capture, via the pure {@link decodeQrFromImageData}) → on a decode,
 * stop the camera and call `onScan` once. Every exit path — decode success, Cancel, or unmount —
 * stops every camera track; the camera is NEVER left running once this component is gone. Camera
 * access failures (denied / no device / no camera API at all) render a graceful, actionable error
 * state (Cancel always works) instead of a blank/broken scanner.
 */
export function QrScanner({ onScan, onClose }: { onScan: (text: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const stoppedRef = useRef(false);
  const [phase, setPhase] = useState<Phase>('requesting');
  const [errorKind, setErrorKind] = useState<CameraErrorKind>('unknown');

  /** Release the camera NOW — called from the effect cleanup (unmount) AND directly from Cancel
   * (defense in depth: a privacy-sensitive resource like a live camera must not depend solely on
   * unmount timing to turn off; Cancel stops it immediately, whatever the parent does afterward). */
  function stopCamera() {
    stoppedRef.current = true;
    if (rafIdRef.current != null) cancelAnimationFrame(rafIdRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  useEffect(() => {
    stoppedRef.current = false;

    function tick() {
      if (stoppedRef.current) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.readyState >= 2 && video.videoWidth > 0) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const text = decodeQrFromImageData(ctx.getImageData(0, 0, canvas.width, canvas.height));
          if (text) {
            stopCamera();
            onScan(text);
            return;
          }
        }
      }
      if (!stoppedRef.current) rafIdRef.current = requestAnimationFrame(tick);
    }

    if (!isCameraSupported()) {
      setErrorKind('unsupported');
      setPhase('error');
      return stopCamera;
    }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(
      (stream) => {
        if (stoppedRef.current) {
          stream.getTracks().forEach((t) => t.stop()); // unmounted while the permission prompt was up
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play?.().catch(() => {
            /* autoplay rejection is harmless — the frame loop still reads whatever is available */
          });
        }
        setPhase('scanning');
        rafIdRef.current = requestAnimationFrame(tick);
      },
      (err: unknown) => {
        if (stoppedRef.current) return;
        setErrorKind(classifyCameraError(err));
        setPhase('error');
      },
    );

    return stopCamera;
    // Deliberately empty: this effect requests the camera exactly ONCE on mount. `onScan` is only
    // ever invoked from inside THIS SAME effect run (never a stale closure survives past a decode,
    // since `stopCamera()` runs first and tears the loop down); re-running on every parent
    // re-render (a new inline arrow function identity) would restart the camera stream needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="dig-card" data-testid="qr-scanner" role="dialog" aria-labelledby="qr-scanner-title">
      <h2 className="dig-heading" id="qr-scanner-title" style={{ marginTop: 0 }}>
        <FormattedMessage id="send.scan.title" />
      </h2>

      {phase === 'requesting' && (
        <div className="dig-state" role="status" aria-live="polite" data-state="loading" data-testid="qr-scanner-requesting">
          <FormattedMessage id="send.scan.requesting" />
        </div>
      )}

      {phase === 'scanning' && (
        <>
          <p className="dig-muted" style={{ marginTop: 0 }}>
            <FormattedMessage id="send.scan.hint" />
          </p>
          <div className="dig-qr-scan-preview" style={{ position: 'relative', borderRadius: 8, overflow: 'hidden' }}>
            {/* A live camera preview, not media content — no captions/subtitles apply. */}
            <video ref={videoRef} data-testid="qr-scanner-video" muted playsInline style={{ width: '100%', display: 'block' }} />
          </div>
          <canvas ref={canvasRef} style={{ display: 'none' }} aria-hidden="true" />
        </>
      )}

      {phase === 'error' && (
        <div className="dig-state" role="alert" data-state="error" data-testid="qr-scanner-error">
          <p>
            <FormattedMessage id={ERROR_MESSAGE_ID[errorKind]} />
          </p>
        </div>
      )}

      <button
        type="button"
        className="dig-btn dig-btn--block"
        data-testid="qr-scanner-cancel"
        onClick={() => {
          stopCamera();
          onClose();
        }}
        style={{ marginTop: 12 }}
      >
        <FormattedMessage id="send.scan.cancel" />
      </button>
    </div>
  );
}
