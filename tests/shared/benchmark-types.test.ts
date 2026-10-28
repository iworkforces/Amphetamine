import { describe, it, expect } from "vitest";
import {
  isRendererCountdownTimerCounters,
  DEFAULT_RENDERER_COUNTDOWN_TIMER_COUNTERS,
  isBatteryBenchmarkCounters,
  DEFAULT_BATTERY_BENCHMARK_COUNTERS,
  isBenchmarkScenario,
  isBenchmarkResultPayload,
} from "../../src/shared/benchmark-types.js";
import { benchmarkFixture } from "../infrastructure/benchmark-fixture.js";

describe("isRendererCountdownTimerCounters", () => {
  it("accepts default counters shape", () => {
    expect(isRendererCountdownTimerCounters(DEFAULT_RENDERER_COUNTDOWN_TIMER_COUNTERS)).toBe(true);
  });

  it("rejects null, arrays, and incomplete objects", () => {
    expect(isRendererCountdownTimerCounters(null)).toBe(false);
    expect(isRendererCountdownTimerCounters([])).toBe(false);
    expect(isRendererCountdownTimerCounters({ starts: 1 })).toBe(false);
    expect(
      isRendererCountdownTimerCounters({
        ...DEFAULT_RENDERER_COUNTDOWN_TIMER_COUNTERS,
        active: "yes",
      }),
    ).toBe(false);
  });
});

describe("current benchmark result", () => {
  it("rejects missing or contradictory idle evidence and active samples", () => {
    const evidence = benchmarkFixture.scenarioMeta.evidence;
    expect(isBenchmarkResultPayload({ ...benchmarkFixture, scenarioMeta: { ...benchmarkFixture.scenarioMeta, evidence: { kind: "idle" } } })).toBe(false);
    for (const phase of ["before", "after"] as const) {
      for (const field of ["sessionRunning", "preventSleep", "countdownActive"] as const) {
        const changed = { ...evidence, [phase]: { ...evidence[phase], [field]: true } };
        expect(isBenchmarkResultPayload({ ...benchmarkFixture, scenarioMeta: { ...benchmarkFixture.scenarioMeta, evidence: changed } })).toBe(false);
      }
    }
    const sample = benchmarkFixture.idle.samples[0];
    if (sample === undefined) throw new Error("Fixture is missing a sample");
    const activeSample = { ...sample, timerCounters: { ...sample.timerCounters, rendererCountdown: { ...sample.timerCounters.rendererCountdown, active: true } } };
    expect(isBenchmarkResultPayload({ ...benchmarkFixture, idle: { ...benchmarkFixture.idle, samples: [activeSample] } })).toBe(false);
  });

  it("accepts complete successful evidence and rejects legacy or failed readiness", () => {
    expect(isBenchmarkResultPayload(benchmarkFixture)).toBe(true);
    expect(isBenchmarkResultPayload({ ...benchmarkFixture, scenario: undefined })).toBe(false);
    expect(
      isBenchmarkResultPayload({
        ...benchmarkFixture,
        readiness: { ...benchmarkFixture.readiness, popover: { kind: "failed", elapsedMs: 1 } },
      }),
    ).toBe(false);
  });

  it("rejects non-finite metrics and inactive session evidence", () => {
    expect(
      isBenchmarkResultPayload({
        ...benchmarkFixture,
        launchReadiness: { ...benchmarkFixture.launchReadiness, appReadyMs: Infinity },
      }),
    ).toBe(false);
    expect(
      isBenchmarkResultPayload({
        ...benchmarkFixture,
        scenario: "active-session",
        scenarioMeta: {
          name: "active-session",
          sessionDurationMinutes: 30,
          evidence: { kind: "active-session", sessionRunning: true, countdownActive: false },
        },
      }),
    ).toBe(false);
    expect(
      isRendererCountdownTimerCounters({
        ...DEFAULT_RENDERER_COUNTDOWN_TIMER_COUNTERS,
        starts: NaN,
      }),
    ).toBe(false);
  });
  it("rejects active evidence contradicted by samples and malformed process metrics", () => {
    const active = {
      ...benchmarkFixture,
      scenario: "active-session",
      scenarioMeta: {
        name: "active-session",
        sessionDurationMinutes: 30,
        evidence: {
          kind: "active-session",
          sessionRunning: true,
          countdownActive: true,
          countdownStops: 0,
          countdownClears: 0,
        },
      },
    };
    expect(isBenchmarkResultPayload(active)).toBe(false);
    const sample = benchmarkFixture.idle.samples[0];
    if (sample === undefined) throw new Error("Fixture is missing a sample");
    const activeSample = {
      ...sample,
      timerCounters: {
        ...sample.timerCounters,
        rendererCountdown: { ...sample.timerCounters.rendererCountdown, active: true },
      },
    };
    expect(
      isBenchmarkResultPayload({ ...active, idle: { ...active.idle, samples: [activeSample] } }),
    ).toBe(true);
    const restarted = {
      ...activeSample,
      timerCounters: {
        ...activeSample.timerCounters,
        rendererCountdown: { ...activeSample.timerCounters.rendererCountdown, stops: 1 },
      },
    };
    expect(
      isBenchmarkResultPayload({ ...active, idle: { ...active.idle, samples: [restarted] } }),
    ).toBe(false);
    expect(
      isBenchmarkResultPayload({
        ...benchmarkFixture,
        idle: { ...benchmarkFixture.idle, samples: [{ ...sample, appMetrics: [null] }] },
      }),
    ).toBe(false);
  });
});

describe("benchmark scenario and battery counters", () => {
  it("accepts idle and active-session only", () => {
    expect(isBenchmarkScenario("idle")).toBe(true);
    expect(isBenchmarkScenario("active-session")).toBe(true);
    expect(isBenchmarkScenario("unknown")).toBe(false);
    expect(isBenchmarkScenario(null)).toBe(false);
  });

  it("accepts default battery counter shape with unambiguous path keys", () => {
    expect(isBatteryBenchmarkCounters(DEFAULT_BATTERY_BENCHMARK_COUNTERS)).toBe(true);
    expect(DEFAULT_BATTERY_BENCHMARK_COUNTERS).toEqual({
      scheduled: 0,
      callbackAttempted: 0,
      guardedSkipped: 0,
      completedRead: 0,
    });
    expect(isBatteryBenchmarkCounters({ scheduled: 1 })).toBe(false);
  });
});
