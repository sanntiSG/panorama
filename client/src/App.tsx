import { useEffect, useRef, useState } from 'react';
import { cameraFov, generateCapturePlan, type CameraModel, type CapturePlan, type PlanTarget, type Quat, type StitchResult } from '@panorama/shared';
import { useCamera } from './capture/useCamera.js';
import { useOrientation, currentScreenAngle } from './capture/useOrientation.js';
import { useStability } from './capture/useStability.js';
import { useSimulatedOrientation } from './sim/useSimulatedOrientation.js';
import { captureFrame } from './capture/frameGrabber.js';
import { buildCameraModel, saveCalibratedFocal } from './capture/cameraCalibration.js';
import { computeRoll } from './capture/targeting.js';
import { queueShot } from './storage/session.js';
import { UploadQueue } from './net/uploader.js';
import { createSession, startStitch, subscribeStitchEvents } from './net/api.js';
import type { PermissionFailureReason } from './capture/useOrientation.js';
import { SetupScreen } from './screens/SetupScreen.js';
import { CaptureScreen } from './screens/CaptureScreen.js';
import { ProcessingScreen } from './screens/ProcessingScreen.js';
import { ResultScreen } from './screens/ResultScreen.js';

type Phase = 'setup' | 'capturing' | 'finishing' | 'stitching' | 'result' | 'error';

/** Fractional overlap between adjacent shots the capture plan targets. See shared/plan/capturePlan.ts. */
const OVERLAP = 0.35;

function orientationErrorMessage(reason: PermissionFailureReason | undefined): string {
  switch (reason) {
    case 'denied':
      return 'El permiso de orientación fue denegado. Actívalo en Ajustes → Safari (o Ajustes de esta web) → Movimiento y orientación, y recarga la página.';
    case 'gesture':
      return 'No se pudo pedir el permiso de orientación a tiempo. Vuelve a tocar "Comenzar".';
    case 'unsupported':
      return 'Este navegador no tiene sensor de orientación. Prueba el "modo simulador" para usar la app desde un ordenador.';
    default:
      return 'Se necesita acceso al sensor de orientación para guiar la captura.';
  }
}

export default function App() {
  const [phase, setPhase] = useState<Phase>('setup');
  const [simulatorMode, setSimulatorMode] = useState(false);
  const [showHud, setShowHud] = useState(true);
  const [starting, setStarting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const camera = useCamera();
  const realOrientation = useOrientation();
  const stability = useStability();
  const simOrientation = useSimulatedOrientation(camera.videoRef.current);
  const orientation = simulatorMode ? simOrientation : realOrientation;

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [plan, setPlan] = useState<CapturePlan | null>(null);
  const [camModel, setCamModel] = useState<CameraModel | null>(null);
  const [capturedIds, setCapturedIds] = useState<Set<string>>(new Set());
  const uploadQueueRef = useRef<UploadQueue | null>(null);
  const [pendingUploads, setPendingUploads] = useState(0);
  const [stitchMessage, setStitchMessage] = useState<string | null>(null);
  const [stitchProgress, setStitchProgress] = useState(0);
  const [result, setResult] = useState<StitchResult | null>(null);
  /** Simulator mode has no real stability sensor — a stable `true` ref stands in for it (ReticleLayer reads `.current` each frame; a fresh literal every render would work by coincidence here, but a real ref is the correct pattern). */
  const alwaysStableRef = useRef(true);

  // --- Setup -> capturing: once the camera reports its real resolution and
  // a session exists, build the camera model (with any previously
  // calibrated focal length) and generate the capture plan from it.
  useEffect(() => {
    if (camera.status === 'ready' && camera.info && camera.info.width > 0 && sessionId && !plan) {
      const cam = buildCameraModel(camera.info.width, camera.info.height);
      const { hFov, vFov } = cameraFov(cam);
      setCamModel(cam);
      setPlan(generateCapturePlan(hFov, vFov, OVERLAP));
      setPhase('capturing');
    }
  }, [camera.status, camera.info, sessionId, plan]);

  // --- capturing -> finishing, once every target has a shot.
  useEffect(() => {
    if (phase === 'capturing' && plan && capturedIds.size >= plan.targets.length) {
      setPhase('finishing');
    }
  }, [phase, plan, capturedIds]);

  // --- finishing -> stitching, once the upload queue has drained.
  useEffect(() => {
    if (phase !== 'finishing' || !sessionId) return;
    if (pendingUploads > 0) return;
    let cancelled = false;
    void (async () => {
      try {
        await startStitch(sessionId);
        if (!cancelled) setPhase('stitching');
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : String(err));
          setPhase('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, sessionId, pendingUploads]);

  // --- stitching: subscribe to server-sent progress.
  useEffect(() => {
    if (phase !== 'stitching' || !sessionId) return;
    return subscribeStitchEvents(sessionId, (event) => {
      if (event.stage === 'done') {
        setResult(event.result);
        if (camModel) saveCalibratedFocal(event.result.focalPx, camModel.width);
        setPhase('result');
      } else if (event.stage === 'error') {
        setErrorMsg(event.message);
        setPhase('error');
      } else {
        setStitchMessage(event.message);
        setStitchProgress(event.progress);
      }
    });
  }, [phase, sessionId, camModel]);

  async function handleStart() {
    setErrorMsg(null);
    setStarting(true);
    try {
      if (!window.isSecureContext) {
        setErrorMsg(
          'Esta página no se sirve de forma segura (HTTPS) — la cámara y los sensores de movimiento no van a funcionar. Usa "npm run local" o "npm run dev" y abre la URL https:// que imprime.',
        );
        return;
      }

      if (!simulatorMode) {
        // Debe pedirse ANTES que camera.start(): en iOS, el prompt de
        // getUserMedia espera a que el usuario toque "Permitir" en un
        // diálogo del sistema, y para cuando esa promesa resuelve ya se
        // perdió la "activación de usuario" que requestPermission()
        // necesita — pedirlo después siempre fallaba, aunque el usuario
        // nunca hubiera dicho que no. Motion se pide justo después, dentro
        // del mismo gesto (no hace falta un segundo toque).
        const orientationResult = await realOrientation.requestPermission();
        if (!orientationResult.ok) {
          setErrorMsg(orientationErrorMessage(orientationResult.reason));
          return;
        }
        // Best-effort: the stability gate degrades gracefully (locks purely
        // on angle/roll) if motion permission is denied.
        await stability.requestPermission();
      }

      await camera.start();

      const session = await createSession(OVERLAP);
      setSessionId(session.id);
      const queue = new UploadQueue(session.id);
      queue.onPendingChange(setPendingUploads);
      uploadQueueRef.current = queue;
    } catch (err) {
      // Apaga la cámara si algo falló a mitad de camino (p. ej. no se pudo
      // crear la sesión) — si no, el stream sigue vivo y la luz de cámara
      // se queda encendida aunque hayamos vuelto a la pantalla de setup.
      camera.stop();
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  async function handleLockFire(target: PlanTarget, quatAtCapture: Quat) {
    if (!sessionId || !camModel || !camera.videoRef.current) return;
    try {
      const blob = await captureFrame(camera.videoRef.current);
      await queueShot(
        sessionId,
        {
          targetId: target.id,
          quat: quatAtCapture,
          screenAngle: currentScreenAngle(),
          capturedAt: Date.now(),
          cam: camModel,
        },
        blob,
      );
      setCapturedIds((prev) => new Set(prev).add(target.id));
      uploadQueueRef.current?.enqueueAndKick();
    } catch (err) {
      // A single missed shot shouldn't stop the session — the reticle for
      // that target simply stays active and the user can re-aim at it.
      console.error('capture failed', err);
    }
  }

  function handleFinishEarly() {
    setPhase('finishing');
  }

  function handleReset() {
    uploadQueueRef.current?.dispose();
    uploadQueueRef.current = null;
    camera.stop();
    setSessionId(null);
    setPlan(null);
    setCamModel(null);
    setCapturedIds(new Set());
    setPendingUploads(0);
    setStitchMessage(null);
    setStitchProgress(0);
    setResult(null);
    setErrorMsg(null);
    setPhase('setup');
  }

  useEffect(() => () => uploadQueueRef.current?.dispose(), []);

  if (phase === 'setup') {
    return (
      <SetupScreen
        onStart={handleStart}
        starting={starting}
        error={errorMsg ?? camera.error}
        simulatorMode={simulatorMode}
        onToggleSimulator={setSimulatorMode}
      />
    );
  }

  if ((phase === 'capturing' || phase === 'finishing') && plan && camModel) {
    if (phase === 'finishing') {
      return <ProcessingScreen phase="finishing" pendingUploads={pendingUploads} stitchMessage={null} stitchProgress={0} />;
    }
    const roll = orientation.sample ? computeRoll(orientation.sample.quat) : 0;
    return (
      <CaptureScreen
        videoRef={camera.attachVideo}
        plan={plan}
        camModel={camModel}
        quatRef={orientation.quatRef}
        isStableRef={simulatorMode ? alwaysStableRef : stability.isStableRef}
        capturedIds={capturedIds}
        onLockFire={handleLockFire}
        showHud={showHud}
        onToggleHud={() => setShowHud((v) => !v)}
        debugSample={orientation.sample}
        rollDeg={(roll * 180) / Math.PI}
        isStable={simulatorMode ? true : stability.isStable}
        jerk={stability.jerk}
        onFinishEarly={handleFinishEarly}
        simulatorMode={simulatorMode}
        pendingUploads={pendingUploads}
      />
    );
  }

  if (phase === 'stitching') {
    return (
      <ProcessingScreen phase="stitching" pendingUploads={0} stitchMessage={stitchMessage} stitchProgress={stitchProgress} />
    );
  }

  if (phase === 'result' && result) {
    return <ResultScreen result={result} onReset={handleReset} />;
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-neutral-950 px-6 text-center text-white">
      <p className="text-sm text-red-400">{errorMsg ?? 'Algo salió mal.'}</p>
      <button onClick={handleReset} className="rounded-full bg-white px-5 py-2 text-sm font-semibold text-black">
        Volver a intentar
      </button>
    </div>
  );
}
