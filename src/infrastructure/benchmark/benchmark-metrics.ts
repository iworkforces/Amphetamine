import { app } from "electron/main";
import { cpus, freemem, totalmem } from "node:os";
import type {
  BatteryBenchmarkCounters,
  BenchmarkScenario,
  RendererCountdownTimerCounters,
  BenchmarkLoadResult,
} from "../../shared/benchmark-types.js";

export type MainTimerCounters = {
  readonly timerResourcesCreated: number;
  readonly timerCallbacks: number;
  readonly timerResourcesDestroyed: number;
  readonly activeTimerResources: number;
};

export type BenchmarkTimerCounters = {
  readonly main: MainTimerCounters;
  readonly rendererCountdown: RendererCountdownTimerCounters;
  readonly battery: BatteryBenchmarkCounters;
};

export type BenchmarkContext = {
  readonly mainWindow: Electron.BrowserWindow;
  readonly appReadyMs: number;
  readonly bootstrapReadyMs: number;
};

export type SampleSummary = {
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly samplesMs: readonly number[];
};

export type IdleSample = {
  readonly elapsedMs: number;
  readonly totalCpuPercent: number;
  readonly totalIdleWakeups: number;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly appMetrics: readonly Electron.ProcessMetric[];
  readonly timerCounters: BenchmarkTimerCounters;
};

export type BenchmarkArtifact = {
  readonly schemaVersion: 1;
  readonly label: string;
  /**
   * Additive v1 scenario metadata (idle default). Harness and unit guards
   * treat missing scenario as idle for older artifacts.
   */
  readonly scenario: BenchmarkScenario;
  readonly scenarioMeta: {
    readonly name: BenchmarkScenario;
    /** Minutes for active-session timed run; null for idle. */
    readonly sessionDurationMinutes: number | null;
    readonly evidence:
      | {
          readonly kind: "idle";
          readonly before: IdleEvidence;
          readonly after: IdleEvidence;
        }
      | {
          readonly kind: "active-session";
          readonly sessionRunning: true;
          readonly countdownActive: true;
          readonly countdownStops: number;
          readonly countdownClears: number;
        };
  };
  readonly readiness: {
    readonly popover: BenchmarkLoadResult;
    readonly settings: readonly {
      readonly load: BenchmarkLoadResult;
      readonly ready: BenchmarkLoadResult;
    }[];
  };
  readonly timestamps: {
    readonly startedAt: string;
    readonly completedAt: string;
  };
  readonly runtime: {
    readonly appVersion: string;
    readonly electron: string | undefined;
    readonly chrome: string | undefined;
    readonly node: string;
    readonly v8: string | undefined;
    readonly platform: typeof process.platform;
    readonly arch: string;
    readonly cpuCount: number;
    readonly cpuModel: string;
    readonly totalMemoryBytes: number;
    readonly freeMemoryBytes: number;
  };
  readonly launchReadiness: {
    readonly appReadyMs: number;
    readonly bootstrapReadyMs: number;
    readonly popoverDomReadyMs: number;
  };
  readonly responsiveness: {
    readonly popoverShowHide: SampleSummary;
    readonly trayMenuProxy: SampleSummary;
    readonly settingsWindowReady: SampleSummary;
  };
  readonly idle: {
    readonly sampleIntervalMs: number;
    readonly summary: {
      readonly cpuPercent: SampleSummary;
      readonly idleWakeups: SampleSummary;
      readonly rssBytes: SampleSummary;
      readonly heapUsedBytes: SampleSummary;
    };
    readonly samples: readonly IdleSample[];
  };
  readonly timerCounters: BenchmarkTimerCounters;
};

export type LoadResult = BenchmarkLoadResult;

export type IdleEvidence = {
  readonly sessionRunning: boolean;
  readonly preventSleep: boolean;
  readonly countdownActive: boolean;
};

export function interpretLegacyScenario(value: unknown): BenchmarkScenario | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (!("scenario" in value)) return "idle";
  return value.scenario === "idle" || value.scenario === "active-session" ? value.scenario : null;
}

export function isConfirmedActiveSession(
  status: unknown,
  counters: RendererCountdownTimerCounters,
): boolean {
  return (
    typeof status === "object" &&
    status !== null &&
    "isRunning" in status &&
    status.isRunning === true &&
    "remainingSeconds" in status &&
    typeof status.remainingSeconds === "number" &&
    Number.isFinite(status.remainingSeconds) &&
    status.remainingSeconds > 0 &&
    counters.active
  );
}

export function buildRuntimeInfo(): BenchmarkArtifact["runtime"] {
  const cpuList = cpus();
  return {
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    cpuCount: cpuList.length,
    cpuModel: cpuList[0]?.model ?? "unknown",
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
  };
}

export function summarizeIdle(
  samples: readonly IdleSample[],
): BenchmarkArtifact["idle"]["summary"] {
  return {
    cpuPercent: summarize(samples.map((sample) => sample.totalCpuPercent)),
    idleWakeups: summarize(samples.map((sample) => sample.totalIdleWakeups)),
    rssBytes: summarize(samples.map((sample) => sample.rssBytes)),
    heapUsedBytes: summarize(samples.map((sample) => sample.heapUsedBytes)),
  };
}

export function summarize(samples: readonly number[]): SampleSummary {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    medianMs: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    minMs: sorted[0] ?? 0,
    maxMs: sorted.at(-1) ?? 0,
    samplesMs: samples,
  };
}

export function sumCpuPercent(metrics: readonly Electron.ProcessMetric[]): number {
  return metrics.reduce((total, metric) => total + metric.cpu.percentCPUUsage, 0);
}

export function sumIdleWakeups(metrics: readonly Electron.ProcessMetric[]): number {
  return metrics.reduce((total, metric) => total + metric.cpu.idleWakeupsPerSecond, 0);
}

export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function percentile(sortedSamples: readonly number[], percentileValue: number): number {
  if (sortedSamples.length === 0) return 0;
  const index = Math.ceil((percentileValue / 100) * sortedSamples.length) - 1;
  return round(sortedSamples[Math.max(0, Math.min(index, sortedSamples.length - 1))] ?? 0);
}
