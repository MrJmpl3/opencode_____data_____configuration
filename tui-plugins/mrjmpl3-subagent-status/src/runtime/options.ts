export type StaleRunningProbePolicy = {
  baseBackoffMs: number;
  maxBackoffMs: number;
  maxAttempts: number;
  refreshIntervalMs: number;
};

export interface SubagentStatusStaleRunningProbePolicyOptions {
  /**
   * Backoff base para volver a sondear una sesion que sigue figurando como
   * running. Si llega un valor invalido, se reemplaza por el minimo seguro.
   */
  baseBackoffMs?: number;
  /**
   * Tope del backoff exponencial para no dejar probes zombies ni tampoco
   * castigar demasiado una sesion que todavia no emitio evidencia terminal.
   */
  maxBackoffMs?: number;
  /**
   * Cantidad maxima de probes extra antes de dejar de insistir hasta que haya
   * nueva actividad visible en la sesion.
   */
  maxAttempts?: number;
  /**
   * Intervalo del loop de reconciliacion que revisa si conviene disparar esos
   * probes de running stale.
   */
  refreshIntervalMs?: number;
}

export interface SubagentStatusPersistenceOptions {
  /**
   * Ruta explicita del snapshot persistido. Sirve para fijar el archivo desde
   * `tui.json` en vez de depender de convenciones externas o variables de
   * entorno.
   */
  statePath?: string;
  /**
   * Cuando es true, el runtime intenta cargar el ultimo snapshot al iniciar.
   * Cuando es false o falta, arranca desde un estado vacio.
   */
  preserveStateOnStartup?: boolean;
}

export interface SubagentStatusRecoveryOptions {
  /**
   * Ruta explicita a la base SQLite de OpenCode usada para recovery.
   * El plugin no lee configuracion propia desde ENV: la unica entrada valida
   * es este objeto `options` recibido desde el tuple del plugin.
   */
  sqliteDatabasePath?: string;
}

/**
 * Forma publica del objeto `options` que acompana al plugin en `tui.json`.
 *
 * Ejemplo de la entrada completa:
 * `[
 *   "/abs/path/to/mrjmpl3-subagent-status",
 *   {
 *     staleRunningProbePolicy: { refreshIntervalMs: 120000 },
 *     persistence: { statePath: "/tmp/subagent-status.json" },
 *     recovery: { sqliteDatabasePath: "/tmp/opencode.db" }
 *   }
 * ]`
 *
 * Opencode entrega ese segundo elemento como `options: unknown`; por eso este
 * modulo define la forma esperada y la normaliza explicitamente en un solo
 * borde. No existe una via soportada de configuracion especifica del plugin
 * por variables de entorno.
 */
export interface SubagentStatusPluginOptions {
  staleRunningProbePolicy?: SubagentStatusStaleRunningProbePolicyOptions;
  persistence?: SubagentStatusPersistenceOptions;
  recovery?: SubagentStatusRecoveryOptions;
}

/**
 * Alias util para quien quiera tipar una entrada completa del array `plugin`
 * en `tui.json`: el primer elemento es el spec/ruta del plugin y el segundo es
 * exactamente el objeto que este modulo sabe normalizar.
 */
export type SubagentStatusPluginConfigEntry = readonly [pluginSpec: string, options: SubagentStatusPluginOptions];

export interface ResolvedSubagentStatusPluginOptions {
  staleRunningProbePolicy: StaleRunningProbePolicy;
  persistence: {
    statePath?: string;
    preserveStateOnStartup: boolean;
  };
  recovery: {
    sqliteDatabasePath?: string;
  };
}

export const DEFAULT_STALE_RUNNING_PROBE_POLICY: StaleRunningProbePolicy = {
  baseBackoffMs: 60_000,
  maxBackoffMs: 5 * 60_000,
  maxAttempts: 4,
  refreshIntervalMs: 60_000,
};

const MIN_BACKOFF_MS = 1_000;
const MIN_REFRESH_INTERVAL_MS = 1_000;
const MAX_MAX_ATTEMPTS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringOption(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function numberOption(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function integerOption(value: unknown): number | undefined {
  const parsed = numberOption(value);
  return parsed === undefined ? undefined : Math.floor(parsed);
}

/**
 * Normaliza el payload crudo que llega desde `plugin: [[spec, options]]`.
 * Mantener esta conversion en un unico lugar evita que el runtime tenga que
 * adivinar formas parciales o volver a introducir configuracion via ENV.
 */
export function normalizeSubagentStatusPluginOptions(options: unknown): ResolvedSubagentStatusPluginOptions {
  const pluginOptions = isRecord(options) ? options : {};
  const staleRunningProbePolicy = isRecord(pluginOptions.staleRunningProbePolicy)
    ? pluginOptions.staleRunningProbePolicy
    : {};
  const persistence = isRecord(pluginOptions.persistence) ? pluginOptions.persistence : {};
  const recovery = isRecord(pluginOptions.recovery) ? pluginOptions.recovery : {};

  const baseBackoffMs = Math.max(
    MIN_BACKOFF_MS,
    numberOption(staleRunningProbePolicy.baseBackoffMs) ?? DEFAULT_STALE_RUNNING_PROBE_POLICY.baseBackoffMs,
  );
  const maxBackoffMs = Math.max(
    baseBackoffMs,
    numberOption(staleRunningProbePolicy.maxBackoffMs) ?? DEFAULT_STALE_RUNNING_PROBE_POLICY.maxBackoffMs,
  );
  const maxAttempts = Math.min(
    MAX_MAX_ATTEMPTS,
    Math.max(0, integerOption(staleRunningProbePolicy.maxAttempts) ?? DEFAULT_STALE_RUNNING_PROBE_POLICY.maxAttempts),
  );
  const refreshIntervalMs = Math.max(
    MIN_REFRESH_INTERVAL_MS,
    numberOption(staleRunningProbePolicy.refreshIntervalMs) ?? DEFAULT_STALE_RUNNING_PROBE_POLICY.refreshIntervalMs,
  );

  return {
    staleRunningProbePolicy: {
      baseBackoffMs,
      maxBackoffMs,
      maxAttempts,
      refreshIntervalMs,
    },
    persistence: {
      statePath: stringOption(persistence.statePath),
      preserveStateOnStartup: persistence.preserveStateOnStartup === true,
    },
    recovery: {
      sqliteDatabasePath: stringOption(recovery.sqliteDatabasePath),
    },
  };
}

export const resolveSubagentStatusPluginOptions = normalizeSubagentStatusPluginOptions;
