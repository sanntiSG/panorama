import { useCallback, useEffect, useRef, useState } from 'react';

export type CameraStatus = 'idle' | 'requesting' | 'ready' | 'error';

export interface CameraInfo {
  width: number;
  height: number;
}

interface WakeLockSentinelLike {
  release: () => Promise<void>;
}

/**
 * Owns the rear-camera MediaStream and (best-effort) the screen wake lock so
 * the display doesn't sleep mid-capture. `videoRef` must be attached to a
 * `<video playsInline muted>` element — `playsInline` is required or iOS
 * takes the video fullscreen and the reticle overlay breaks.
 */
export function useCamera() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const [status, setStatus] = useState<CameraStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<CameraInfo | null>(null);

  const acquireWakeLock = useCallback(async () => {
    try {
      const nav = navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> } };
      wakeLockRef.current = (await nav.wakeLock?.request('screen')) ?? null;
    } catch {
      // Not fatal — iOS < 16.4 or a low-power mode can refuse this.
    }
  }, []);

  const start = useCallback(async () => {
    setStatus('requesting');
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 4032 },
          height: { ideal: 3024 },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings();
      setInfo({
        width: settings?.width ?? videoRef.current?.videoWidth ?? 0,
        height: settings?.height ?? videoRef.current?.videoHeight ?? 0,
      });
      setStatus('ready');
      await acquireWakeLock();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }, [acquireWakeLock]);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
    setStatus('idle');
  }, []);

  useEffect(() => () => stop(), [stop]);

  // iOS releases the wake lock when the tab is backgrounded; re-acquire on return.
  useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState === 'visible' && status === 'ready' && !wakeLockRef.current) {
        void acquireWakeLock();
      }
    }
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [status, acquireWakeLock]);

  return { videoRef, start, stop, status, error, info };
}
