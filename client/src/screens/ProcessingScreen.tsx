export interface ProcessingScreenProps {
  phase: 'finishing' | 'stitching';
  pendingUploads: number;
  stitchMessage: string | null;
  stitchProgress: number;
}

const STAGE_LABELS: Record<string, string> = {
  decode: 'Leyendo fotos',
  features: 'Buscando puntos en común',
  matching: 'Emparejando fotos',
  bundle: 'Ajustando geometría',
  exposure: 'Igualando exposición',
  render: 'Generando la esfera',
  xmp: 'Guardando metadatos',
};

export function ProcessingScreen({ phase, pendingUploads, stitchMessage, stitchProgress }: ProcessingScreenProps) {
  const label =
    phase === 'finishing'
      ? `Subiendo ${pendingUploads} foto${pendingUploads === 1 ? '' : 's'} restante${pendingUploads === 1 ? '' : 's'}…`
      : (stitchMessage ?? STAGE_LABELS.decode);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-neutral-950 px-6 text-center text-white">
      <div className="h-10 w-10 animate-spin rounded-full border-4 border-neutral-700 border-t-white" />
      <p className="text-sm text-neutral-300">{label}</p>
      {phase === 'stitching' && (
        <div className="h-1.5 w-64 overflow-hidden rounded-full bg-neutral-800">
          <div
            className="h-full bg-white transition-all"
            style={{ width: `${Math.round(stitchProgress * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}
