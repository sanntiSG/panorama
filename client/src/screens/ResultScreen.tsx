import type { StitchResult } from '@panorama/shared';
import { SphereViewer } from '../viewer/SphereViewer.js';
import { apiUrl } from '../net/api.js';

export interface ResultScreenProps {
  result: StitchResult;
  onReset: () => void;
}

export function ResultScreen({ result, onReset }: ResultScreenProps) {
  const outputUrl = apiUrl(result.outputFile);
  return (
    <div className="relative h-full w-full bg-black">
      <SphereViewer imageUrl={outputUrl} />

      <div className="pointer-events-none absolute left-2 top-2 z-20 rounded bg-black/60 px-3 py-1.5 text-xs text-neutral-300">
        {result.width}×{result.height} · focal {result.focalPx.toFixed(0)}px · residual {result.meanResidualPx.toFixed(2)}px
        {result.uncoveredFraction > 0.001 && (
          <> · <span className="text-amber-400">{(result.uncoveredFraction * 100).toFixed(1)}% sin cobertura</span></>
        )}
      </div>

      <div className="absolute bottom-4 left-0 right-0 z-20 flex items-center justify-center gap-3">
        <a
          href={outputUrl}
          download
          className="rounded-full bg-white px-5 py-2 text-sm font-semibold text-black"
        >
          Descargar
        </a>
        <button onClick={onReset} className="rounded-full bg-black/60 px-5 py-2 text-sm font-medium text-white">
          Nueva panorámica
        </button>
      </div>
    </div>
  );
}
