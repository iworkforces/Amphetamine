import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({
  app: { getVersion: () => "1.2.3" },
}));

describe("benchmark-metrics", () => {
  it("interprets a missing legacy scenario as idle without inventing evidence", async () => {
    const { interpretLegacyScenario } =
      await import("../../src/infrastructure/benchmark/benchmark-metrics.js");
    expect(interpretLegacyScenario({})).toBe("idle");
    expect(interpretLegacyScenario({ scenario: "active-session" })).toBe("active-session");
    expect(interpretLegacyScenario({ scenario: "wrong" })).toBeNull();
    expect(interpretLegacyScenario(null)).toBeNull();
  });
  it("requires a currently running session and active countdown, not historical counters", async () => {
    const { isConfirmedActiveSession } =
      await import("../../src/infrastructure/benchmark/benchmark-metrics.js");
    const counters = {
      starts: 1,
      schedules: 1,
      callbacks: 0,
      fires: 0,
      stops: 1,
      clears: 1,
      active: false,
    };
    const running = { isRunning: true, remainingSeconds: 30 };
    expect(isConfirmedActiveSession(running, counters)).toBe(false);
    expect(
      isConfirmedActiveSession(
        { isRunning: false, remainingSeconds: null },
        { ...counters, active: true },
      ),
    ).toBe(false);
    expect(isConfirmedActiveSession(running, { ...counters, active: true })).toBe(true);
  });
  beforeEach(() => {
    vi.resetModules();
  });

  it("summarize returns median/p95/min/max", async () => {
    const { summarize } = await import("../../src/infrastructure/benchmark/benchmark-metrics.js");
    const s = summarize([10, 20, 30, 40, 50]);
    expect(s.minMs).toBe(10);
    expect(s.maxMs).toBe(50);
    expect(s.medianMs).toBeGreaterThan(0);
    expect(s.p95Ms).toBeGreaterThan(0);
    expect(s.samplesMs).toHaveLength(5);
  });

  it("summarize handles empty samples", async () => {
    const { summarize } = await import("../../src/infrastructure/benchmark/benchmark-metrics.js");
    const s = summarize([]);
    expect(s.minMs).toBe(0);
    expect(s.maxMs).toBe(0);
  });

  it("sumCpuPercent and sumIdleWakeups aggregate metrics", async () => {
    const { sumCpuPercent, sumIdleWakeups } =
      await import("../../src/infrastructure/benchmark/benchmark-metrics.js");
    type ProcessMetricLike = Parameters<typeof sumCpuPercent>[0][number];
    const metrics: ProcessMetricLike[] = [
      { cpu: { percentCPUUsage: 10, idleWakeupsPerSecond: 2 } } as ProcessMetricLike,
      { cpu: { percentCPUUsage: 5, idleWakeupsPerSecond: 3 } } as ProcessMetricLike,
    ];
    expect(sumCpuPercent(metrics)).toBe(15);
    expect(sumIdleWakeups(metrics)).toBe(5);
  });

  it("round trims to 3 decimals", async () => {
    const { round } = await import("../../src/infrastructure/benchmark/benchmark-metrics.js");
    expect(round(1.23456)).toBe(1.235);
  });

  it("buildRuntimeInfo includes app version", async () => {
    const { buildRuntimeInfo } =
      await import("../../src/infrastructure/benchmark/benchmark-metrics.js");
    const info = buildRuntimeInfo();
    expect(info.appVersion).toBe("1.2.3");
    expect(info.cpuCount).toBeGreaterThan(0);
  });

  it("summarizeIdle maps sample fields", async () => {
    const { summarizeIdle } =
      await import("../../src/infrastructure/benchmark/benchmark-metrics.js");
    const summary = summarizeIdle([
      {
        elapsedMs: 1,
        totalCpuPercent: 2,
        totalIdleWakeups: 3,
        rssBytes: 4,
        heapUsedBytes: 5,
        appMetrics: [],
        timerCounters: {
          main: {
            timerResourcesCreated: 0,
            timerCallbacks: 0,
            timerResourcesDestroyed: 0,
            activeTimerResources: 0,
          },
          rendererCountdown: {
            starts: 0,
            schedules: 0,
            callbacks: 0,
            fires: 0,
            stops: 0,
            clears: 0,
            active: false,
          },
          battery: {
            scheduled: 0,
            callbackAttempted: 0,
            guardedSkipped: 0,
            completedRead: 0,
          },
        },
      },
    ]);
    expect(summary.cpuPercent.samplesMs).toEqual([2]);
    expect(summary.rssBytes.samplesMs).toEqual([4]);
  });
});
