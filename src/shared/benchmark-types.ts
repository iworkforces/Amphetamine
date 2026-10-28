export const BENCHMARK_ENV_NAME = "AMPHETAMINE_BENCHMARK" as const;

/** Harness scenario: idle (default) or timed active session. */
export type BenchmarkScenario = "idle" | "active-session";

export const BENCHMARK_SCENARIOS = [
  "idle",
  "active-session",
] as const satisfies readonly BenchmarkScenario[];

export function isBenchmarkScenario(value: unknown): value is BenchmarkScenario {
  return value === "idle" || value === "active-session";
}

export type RendererCountdownTimerCounters = {
  readonly starts: number;
  readonly schedules: number;
  readonly callbacks: number;
  readonly fires: number;
  readonly stops: number;
  readonly clears: number;
  readonly active: boolean;
};

export const DEFAULT_RENDERER_COUNTDOWN_TIMER_COUNTERS = {
  starts: 0,
  schedules: 0,
  callbacks: 0,
  fires: 0,
  stops: 0,
  clears: 0,
  active: false,
} as const satisfies RendererCountdownTimerCounters;

const RENDERER_COUNTDOWN_COUNTER_KEYS = [
  "starts",
  "schedules",
  "callbacks",
  "fires",
  "stops",
  "clears",
] as const;

export function isRendererCountdownTimerCounters(
  value: unknown,
): value is RendererCountdownTimerCounters {
  if (!isRecord(value)) return false;
  return (
    RENDERER_COUNTDOWN_COUNTER_KEYS.every((key) => isFiniteNumber(value[key])) &&
    typeof value["active"] === "boolean"
  );
}

/**
 * Semantic battery-monitor counters (benchmark mode only).
 * Distinguishes schedule vs callback attempt vs gate skip vs completed percent read.
 */
export type BatteryBenchmarkCounters = {
  /** Periodic interval was started (or re-started after stop). */
  readonly scheduled: number;
  /** Guard entry ran (periodic tick, power event, reconfigure). */
  readonly callbackAttempted: number;
  /** Exited early due to threshold/AC/inactive prevention or re-entrancy. */
  readonly guardedSkipped: number;
  /** Completed a charge-percent read attempt (success or error after gates). */
  readonly completedRead: number;
};

export const DEFAULT_BATTERY_BENCHMARK_COUNTERS = {
  scheduled: 0,
  callbackAttempted: 0,
  guardedSkipped: 0,
  completedRead: 0,
} as const satisfies BatteryBenchmarkCounters;

const BATTERY_COUNTER_KEYS = [
  "scheduled",
  "callbackAttempted",
  "guardedSkipped",
  "completedRead",
] as const;

export function isBatteryBenchmarkCounters(value: unknown): value is BatteryBenchmarkCounters {
  if (!isRecord(value)) return false;
  return BATTERY_COUNTER_KEYS.every((key) => isFiniteNumber(value[key]));
}

export type BenchmarkLoadResult = {
  readonly kind: "loaded" | "failed" | "timeout" | "closed";
  readonly elapsedMs: number;
};

export type BenchmarkResultPayload = Record<string, unknown> & {
  readonly scenario: BenchmarkScenario;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function allNumbersFinite(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(allNumbersFinite);
  if (isRecord(value)) return Object.values(value).every(allNumbersFinite);
  return true;
}

function hasNumbers(value: unknown, keys: readonly string[]): boolean {
  return isRecord(value) && keys.every((key) => isFiniteNumber(value[key]));
}

function isSummary(value: unknown): boolean {
  return (
    hasNumbers(value, ["medianMs", "p95Ms", "minMs", "maxMs"]) &&
    isRecord(value) &&
    Array.isArray(value["samplesMs"]) &&
    value["samplesMs"].length > 0 &&
    value["samplesMs"].every(isFiniteNumber)
  );
}

function isTimerCounters(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasNumbers(value["main"], [
      "timerResourcesCreated",
      "timerCallbacks",
      "timerResourcesDestroyed",
      "activeTimerResources",
    ]) &&
    isRendererCountdownTimerCounters(value["rendererCountdown"]) &&
    isBatteryBenchmarkCounters(value["battery"])
  );
}

function isSuccessfulLoad(value: unknown): boolean {
  return isRecord(value) && value["kind"] === "loaded" && isFiniteNumber(value["elapsedMs"]);
}

function isProcessMetric(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasNumbers(value, ["pid", "creationTime"]) &&
    typeof value["type"] === "string" &&
    [
      "Browser",
      "Tab",
      "Utility",
      "Zygote",
      "Sandbox helper",
      "GPU",
      "Pepper Plugin",
      "Pepper Plugin Broker",
      "Unknown",
    ].includes(value["type"]) &&
    hasNumbers(value["cpu"], ["percentCPUUsage", "idleWakeupsPerSecond"]) &&
    hasNumbers(value["memory"], ["workingSetSize", "peakWorkingSetSize"])
  );
}

export function isBenchmarkResultPayload(value: unknown): value is BenchmarkResultPayload {
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== 1 ||
    typeof value["label"] !== "string" ||
    !isBenchmarkScenario(value["scenario"]) ||
    !allNumbersFinite(value)
  )
    return false;
  const scenario = value["scenario"];
  const meta = value["scenarioMeta"];
  const readiness = value["readiness"];
  const timestamps = value["timestamps"];
  const runtime = value["runtime"];
  const responsiveness = value["responsiveness"];
  const idle = value["idle"];
  if (!isRecord(meta) || meta["name"] !== scenario || !isRecord(meta["evidence"])) return false;
  const evidence = meta["evidence"];
  if (
    scenario === "idle"
      ? meta["sessionDurationMinutes"] !== null ||
        meta["evidence"]["kind"] !== "idle" ||
        !isIdleEvidence(meta["evidence"]["before"]) ||
        !isIdleEvidence(meta["evidence"]["after"])
      : !isFiniteNumber(meta["sessionDurationMinutes"]) ||
        meta["sessionDurationMinutes"] <= 0 ||
        meta["evidence"]["kind"] !== "active-session" ||
        meta["evidence"]["sessionRunning"] !== true ||
        meta["evidence"]["countdownActive"] !== true ||
        !hasNumbers(meta["evidence"], ["countdownStops", "countdownClears"])
  )
    return false;
  if (
    !isRecord(readiness) ||
    !isSuccessfulLoad(readiness["popover"]) ||
    !Array.isArray(readiness["settings"]) ||
    readiness["settings"].length === 0 ||
    !readiness["settings"].every(
      (setting: unknown) =>
        isRecord(setting) &&
        isSuccessfulLoad(setting["load"]) &&
        isSuccessfulLoad(setting["ready"]),
    )
  )
    return false;
  if (
    !isRecord(timestamps) ||
    typeof timestamps["startedAt"] !== "string" ||
    typeof timestamps["completedAt"] !== "string"
  )
    return false;
  if (
    !isRecord(runtime) ||
    !["appVersion", "node", "platform", "arch", "cpuModel"].every(
      (key) => typeof runtime[key] === "string",
    ) ||
    !hasNumbers(runtime, ["cpuCount", "totalMemoryBytes", "freeMemoryBytes"])
  )
    return false;
  if (
    !hasNumbers(value["launchReadiness"], [
      "appReadyMs",
      "bootstrapReadyMs",
      "popoverDomReadyMs",
    ]) ||
    !isRecord(responsiveness) ||
    !["popoverShowHide", "trayMenuProxy", "settingsWindowReady"].every((key) =>
      isSummary(responsiveness[key]),
    )
  )
    return false;
  if (
    !isRecord(idle) ||
    !isFiniteNumber(idle["sampleIntervalMs"]) ||
    !isRecord(idle["summary"]) ||
    !["cpuPercent", "idleWakeups", "rssBytes", "heapUsedBytes"].every((key) =>
      isSummary(isRecord(idle["summary"]) ? idle["summary"][key] : undefined),
    ) ||
    !Array.isArray(idle["samples"]) ||
    idle["samples"].length === 0
  )
    return false;
  return (
    idle["samples"].every(
      (sample: unknown) =>
        isRecord(sample) &&
        hasNumbers(sample, [
          "elapsedMs",
          "totalCpuPercent",
          "totalIdleWakeups",
          "rssBytes",
          "heapUsedBytes",
        ]) &&
        Array.isArray(sample["appMetrics"]) &&
        sample["appMetrics"].length > 0 &&
        sample["appMetrics"].every(isProcessMetric) &&
        isTimerCounters(sample["timerCounters"]) &&
        isRecord(sample["timerCounters"]) &&
        isRecord(sample["timerCounters"]["rendererCountdown"]) &&
        (scenario === "idle"
          ? sample["timerCounters"]["rendererCountdown"]["active"] === false
          : sample["timerCounters"]["rendererCountdown"]["active"] === true &&
            sample["timerCounters"]["rendererCountdown"]["stops"] === evidence["countdownStops"] &&
            sample["timerCounters"]["rendererCountdown"]["clears"] === evidence["countdownClears"]),
    ) && isTimerCounters(value["timerCounters"])
  );
}

function isIdleEvidence(value: unknown): boolean {
  return (
    isRecord(value) &&
    value["sessionRunning"] === false &&
    value["preventSleep"] === false &&
    value["countdownActive"] === false
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
