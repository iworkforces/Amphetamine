import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import process from "node:process";
import { benchmarkFixture } from "./benchmark-fixture.js";

const state = vi.hoisted(() => ({
  running: false,
  preventSleep: false,
  countdownActive: false,
  countdownReads: 0,
  changeAtRead: 0,
  settingsOutcome: "loaded",
}));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const app = Object.assign(new EventEmitter(), {
    getVersion: () => "1",
    getAppMetrics: () => benchmarkFixture.idle.samples[0]?.appMetrics ?? [],
    quit: vi.fn(),
  });
  class Window extends EventEmitter {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      isDestroyed: () => this.destroyed,
      executeJavaScript: async (script: string) => {
        if (script.includes("session.start")) return { ok: true };
        if (script.includes("session.getStatus"))
          return { isRunning: state.running, remainingSeconds: state.running ? 30 : null };
        if (script.includes("settings.get")) return { preventSleep: state.preventSleep };
        state.countdownReads += 1;
        return {
          ...benchmarkFixture.timerCounters.rendererCountdown,
          starts: 1,
          schedules: 1,
          active: state.changeAtRead === state.countdownReads ? !state.countdownActive : state.countdownActive,
        };
      },
    });
    constructor() {
      super();
      app.emit("browser-window-created", {}, this);
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit("closed"); }
    showInactive() {}
    hide() {}
  }
  return { app, BrowserWindow: Window };
});

vi.mock("../../src/main/battery-monitor.js", () => ({
  getBatteryBenchmarkCounters: () => benchmarkFixture.timerCounters.battery,
}));
vi.mock("../../src/main/tray.js", () => ({ measureBenchmarkTrayMenuProxy: () => 0 }));
vi.mock("../../src/main/settings-window.js", async () => {
  const { BrowserWindow } = await import("electron/main");
  return {
    createSettingsWindow: () => {
      const window = new BrowserWindow();
      if (state.settingsOutcome === "loaded") {
        window.webContents.emit("did-finish-load");
        window.emit("ready-to-show");
      }
      if (state.settingsOutcome === "failed") window.webContents.emit("did-fail-load", {}, -1, "failure", "file:", true);
      if (state.settingsOutcome === "closed") window.destroy();
      return window;
    },
    closeSettingsWindow: () => {},
  };
});

import { app, BrowserWindow } from "electron/main";
import { installBenchmarkReadinessTracking } from "../../src/infrastructure/benchmark/benchmark-readiness.js";
import { runBenchmarkIfRequested } from "../../src/infrastructure/benchmark/benchmark.js";
import { isBenchmarkResultPayload } from "../../src/shared/benchmark-types.js";

installBenchmarkReadinessTracking();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("AMPHETAMINE_BENCHMARK", "1");
  vi.stubEnv("AMPHETAMINE_BENCHMARK_SCENARIO", "idle");
  Object.assign(state, { running: false, preventSleep: false, countdownActive: false, countdownReads: 0, changeAtRead: 0, settingsOutcome: "loaded" });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.mocked(app.quit).mockClear();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

async function run(outcome: "loaded" | "failed" | "closed" | "timeout" = "loaded") {
  const window = new BrowserWindow();
  const result = runBenchmarkIfRequested({ mainWindow: window, appReadyMs: 1, bootstrapReadyMs: 1 });
  const settled = result.then(() => null, (error: unknown) => error);
  if (outcome === "loaded") window.webContents.emit("did-finish-load");
  if (outcome === "failed") window.webContents.emit("did-fail-load", {}, -1, "failure", "file:", true);
  if (outcome === "closed") window.destroy();
  await vi.advanceTimersByTimeAsync(10000);
  return settled;
}

describe("benchmark orchestration", () => {
  it.each(["idle", "active-session"])("emits validated %s evidence", async (scenario) => {
    vi.stubEnv("AMPHETAMINE_BENCHMARK_SCENARIO", scenario);
    state.running = scenario === "active-session";
    state.countdownActive = state.running;
    expect(await run()).toBeNull();
    const output = vi.mocked(process.stdout.write).mock.calls[0]?.[0];
    expect(typeof output).toBe("string");
    const payload: unknown = JSON.parse(String(output).split("AMPHETAMINE_BENCHMARK_RESULT:")[1] ?? "null");
    expect(isBenchmarkResultPayload(payload)).toBe(true);
    if (scenario === "idle") expect(payload).toMatchObject({ scenarioMeta: { evidence: { kind: "idle", before: { sessionRunning: false, preventSleep: false, countdownActive: false }, after: { sessionRunning: false, preventSleep: false, countdownActive: false } } } });
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it.each(["failed", "closed", "timeout"] as const)("emits no result when popover load is %s", async (outcome) => {
    expect(await run(outcome)).toBeInstanceOf(Error);
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  it.each(["failed", "closed", "timeout"] as const)("emits no result when settings load is %s", async (outcome) => {
    state.settingsOutcome = outcome;
    expect(await run()).toBeInstanceOf(Error);
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  it("rejects historical active countdown counters when the ticker is inactive", async () => {
    vi.stubEnv("AMPHETAMINE_BENCHMARK_SCENARIO", "active-session");
    state.running = true;
    expect(await run()).toBeInstanceOf(Error);
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  it("rejects activity that disappears during active sampling", async () => {
    vi.stubEnv("AMPHETAMINE_BENCHMARK_SCENARIO", "active-session");
    state.running = true;
    state.countdownActive = true;
    state.changeAtRead = 4;
    expect(await run()).toBeInstanceOf(Error);
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  it.each(["running", "preventSleep", "countdownActive"] as const)("rejects idle when %s is active", async (key) => {
    state[key] = true;
    expect(await run()).toBeInstanceOf(Error);
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  it("rejects an active countdown during idle sampling", async () => {
    state.changeAtRead = 3;
    expect(await run()).toBeInstanceOf(Error);
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  it.each(["running", "preventSleep"] as const)("rejects idle when %s becomes active before the final observation", async (key) => {
    globalThis.setTimeout(() => { state[key] = true; }, 1000);
    expect(await run()).toBeInstanceOf(Error);
    expect(process.stdout.write).not.toHaveBeenCalled();
  });
});
