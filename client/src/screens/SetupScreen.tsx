export interface SetupScreenProps {
  onStart: () => void;
  starting: boolean;
  error: string | null;
  simulatorMode: boolean;
  onToggleSimulator: (value: boolean) => void;
}

export function SetupScreen({ onStart, starting, error, simulatorMode, onToggleSimulator }: SetupScreenProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-neutral-950 px-6 text-center text-white">
      <h1 className="text-2xl font-semibold">Panorama 360°</h1>
      <p className="max-w-sm text-sm text-neutral-400">
        Gira lentamente sobre tu propio eje. Sigue los círculos: se ponen verdes y disparan solos cuando apuntas bien.
        Mantén el teléfono nivelado (sin inclinarlo hacia los lados) y evita objetos muy cercanos (menos de 2 metros)
        para que la unión final salga limpia.
      </p>

      <label className="flex items-center gap-2 text-sm text-neutral-300">
        <input
          type="checkbox"
          checked={simulatorMode}
          onChange={(e) => onToggleSimulator(e.target.checked)}
          className="h-4 w-4"
        />
        Modo simulador de escritorio (arrastra para rotar, sin giroscopio)
      </label>

      <button
        onClick={onStart}
        disabled={starting}
        className="rounded-full bg-white px-8 py-3 text-base font-medium text-black disabled:opacity-50"
      >
        {starting ? 'Preparando…' : 'Comenzar'}
      </button>

      {error && <p className="max-w-sm text-sm text-red-400">{error}</p>}
    </div>
  );
}
