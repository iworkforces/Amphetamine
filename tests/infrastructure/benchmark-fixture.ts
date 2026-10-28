import {
  DEFAULT_BATTERY_BENCHMARK_COUNTERS,
  DEFAULT_RENDERER_COUNTDOWN_TIMER_COUNTERS,
} from "../../src/shared/benchmark-types.js";

const summary = { medianMs: 1, p95Ms: 1, minMs: 1, maxMs: 1, samplesMs: [1] };
const counters = {
  main: {
    timerResourcesCreated: 1,
    timerCallbacks: 1,
    timerResourcesDestroyed: 1,
    activeTimerResources: 0,
  },
  rendererCountdown: DEFAULT_RENDERER_COUNTDOWN_TIMER_COUNTERS,
  battery: DEFAULT_BATTERY_BENCHMARK_COUNTERS,
};

export const benchmarkFixture = {
  schemaVersion: 1,
  label: "café",
  scenario: "idle",
  scenarioMeta: { name: "idle", sessionDurationMinutes: null, evidence: {
    kind: "idle",
    before: { sessionRunning: false, preventSleep: false, countdownActive: false },
    after: { sessionRunning: false, preventSleep: false, countdownActive: false },
  } },
  readiness: {
    popover: { kind: "loaded", elapsedMs: 1 },
    settings: [{ load: { kind: "loaded", elapsedMs: 1 }, ready: { kind: "loaded", elapsedMs: 1 } }],
  },
  timestamps: { startedAt: "start", completedAt: "end" },
  runtime: {
    appVersion: "1",
    node: "1",
    platform: "darwin",
    arch: "arm64",
    cpuModel: "cpu",
    cpuCount: 1,
    totalMemoryBytes: 1,
    freeMemoryBytes: 1,
  },
  launchReadiness: { appReadyMs: 1, bootstrapReadyMs: 1, popoverDomReadyMs: 1 },
  responsiveness: {
    popoverShowHide: summary,
    trayMenuProxy: summary,
    settingsWindowReady: summary,
  },
  idle: {
    sampleIntervalMs: 1,
    summary: {
      cpuPercent: summary,
      idleWakeups: summary,
      rssBytes: summary,
      heapUsedBytes: summary,
    },
    samples: [
      {
        elapsedMs: 1,
        totalCpuPercent: 1,
        totalIdleWakeups: 1,
        rssBytes: 1,
        heapUsedBytes: 1,
        appMetrics: [
          {
            pid: 1,
            creationTime: 1,
            type: "Browser",
            cpu: { percentCPUUsage: 1, idleWakeupsPerSecond: 1 },
            memory: { workingSetSize: 1, peakWorkingSetSize: 1 },
          },
        ],
        timerCounters: counters,
      },
    ],
  },
  timerCounters: counters,
};
