import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BatteryMonitorHandle } from "../../src/main/battery-monitor.js";

const mockPowerMonitor = vi.hoisted(() => ({
  on: vi.fn(),
  off: vi.fn(),
  isOnBatteryPower: vi.fn().mockReturnValue(false),
}));
const mockLogInfo = vi.hoisted(() => vi.fn());
const mockLogWarn = vi.hoisted(() => vi.fn());

/** Controllable charge percent for monitor integration tests (platform-independent). */
const mockGetBatteryPercent = vi.hoisted(() => vi.fn().mockResolvedValue(75));

vi.mock("electron", () => ({
  app: { isPackaged: false },
  powerMonitor: mockPowerMonitor,
}));

vi.mock("electron-log", () => ({
  default: { info: mockLogInfo, warn: mockLogWarn, error: vi.fn() },
}));

vi.mock("../../src/main/platform/index.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    getBatteryPercent: (...args: unknown[]) =>
      mockGetBatteryPercent(...args) as Promise<number | null>,
  };
});

const mockIsBenchmarkMode = vi.hoisted(() => vi.fn(() => false));
vi.mock("../../src/infrastructure/benchmark/benchmark-env.js", () => ({
  isBenchmarkMode: () => mockIsBenchmarkMode() as boolean,
  BENCHMARK_ENV_NAME: "AMPHETAMINE_BENCHMARK",
}));

describe("battery-monitor", () => {
  let handle: BatteryMonitorHandle;
  let mockGetThreshold: ReturnType<typeof vi.fn<() => number>>;
  let mockOnAutoStop: ReturnType<typeof vi.fn<() => void>>;
  let mockIsActive: ReturnType<typeof vi.fn<() => boolean>>;

  /** Build a fresh battery-monitor handle wired to the current mocks. */
  async function buildHandle(): Promise<BatteryMonitorHandle> {
    const mod = await import("../../src/main/battery-monitor.js");
    return mod.createBatteryMonitor({
      getThreshold: () => mockGetThreshold(),
      onAutoStop: () => mockOnAutoStop(),
      isPreventingSleep: () => mockIsActive(),
    });
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.resetModules();

    mockPowerMonitor.on.mockImplementation(() => {});
    mockGetThreshold = vi.fn<() => number>().mockReturnValue(0);
    mockOnAutoStop = vi.fn<() => void>();
    mockIsActive = vi.fn<() => boolean>().mockReturnValue(false);
    mockGetBatteryPercent.mockResolvedValue(75);

    handle = await buildHandle();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("initBatteryMonitoring", () => {
    it("registers on-battery listener", async () => {
      await handle.initBatteryMonitoring();

      expect(mockPowerMonitor.on).toHaveBeenCalledWith("on-battery", expect.any(Function));
    });

    it("registers on-ac listener", async () => {
      await handle.initBatteryMonitoring();

      expect(mockPowerMonitor.on).toHaveBeenCalledWith("on-ac", expect.any(Function));
    });
  });

  describe("createBatteryMonitor enforces required deps (no silent fallbacks)", () => {
    it("throws when getThreshold is missing", async () => {
      const mod = await import("../../src/main/battery-monitor.js");
      expect(() =>
        mod.createBatteryMonitor({
          // @ts-expect-error - intentionally missing required dep
          getThreshold: undefined,
          onAutoStop: () => {},
          isPreventingSleep: () => false,
        }),
      ).toThrow(/getThreshold/);
    });

    it("throws when onAutoStop is missing", async () => {
      const mod = await import("../../src/main/battery-monitor.js");
      expect(() =>
        mod.createBatteryMonitor({
          getThreshold: () => 0,
          // @ts-expect-error - intentionally missing required dep
          onAutoStop: undefined,
          isPreventingSleep: () => false,
        }),
      ).toThrow(/onAutoStop/);
    });

    it("throws when isPreventingSleep is missing", async () => {
      const mod = await import("../../src/main/battery-monitor.js");
      expect(() =>
        mod.createBatteryMonitor({
          getThreshold: () => 0,
          onAutoStop: () => {},
          // @ts-expect-error - intentionally missing required dep
          isPreventingSleep: undefined,
        }),
      ).toThrow(/isPreventingSleep/);
    });
  });

  describe("on-battery event", () => {
    it("discards a battery read completing after disposal", async () => {
      const read = Promise.withResolvers<number | null>();
      const onPercentSample = vi.fn();
      mockIsActive.mockReturnValue(true);
      mockGetThreshold.mockReturnValue(80);
      mockGetBatteryPercent.mockReturnValue(read.promise);
      const { createBatteryMonitor } = await import("../../src/main/battery-monitor.js");
      const monitor = createBatteryMonitor({
        getThreshold: () => mockGetThreshold(),
        onAutoStop: mockOnAutoStop,
        isPreventingSleep: () => mockIsActive(),
        onPercentSample,
      });
      await monitor.initBatteryMonitoring();
      const onBattery = mockPowerMonitor.on.mock.calls.find(
        (call) => call[0] === "on-battery",
      )?.[1];
      expect(onBattery).toBeTypeOf("function");
      onBattery();
      monitor.cleanupBatteryMonitoring();
      read.resolve(5);
      await vi.advanceTimersByTimeAsync(0);
      monitor.reconfigure();
      expect(onPercentSample).not.toHaveBeenCalled();
      expect(mockOnAutoStop).not.toHaveBeenCalled();
      expect(mockGetBatteryPercent).toHaveBeenCalledTimes(1);
    });
    it("checks battery when on-battery fires and threshold is set", async () => {
      mockIsActive.mockReturnValue(true);
      mockGetThreshold.mockReturnValue(80);

      await handle.initBatteryMonitoring();

      const onBatteryCall = mockPowerMonitor.on.mock.calls.find(
        (call: unknown[]) => call[0] === "on-battery",
      );
      expect(onBatteryCall).toBeDefined();

      const onBatteryCallback = onBatteryCall![1] as () => void;
      onBatteryCallback();

      await vi.advanceTimersByTimeAsync(50);

      expect(mockGetBatteryPercent).toHaveBeenCalled();
    });

    it("calls auto-stop callback when battery below threshold", async () => {
      mockIsActive.mockReturnValue(true);
      mockGetThreshold.mockReturnValue(80);
      mockGetBatteryPercent.mockResolvedValue(75);

      await handle.initBatteryMonitoring();

      const onBatteryCall = mockPowerMonitor.on.mock.calls.find(
        (call: unknown[]) => call[0] === "on-battery",
      );
      const onBatteryCallback = onBatteryCall![1] as () => void;
      onBatteryCallback();

      await vi.advanceTimersByTimeAsync(50);

      expect(mockOnAutoStop).toHaveBeenCalled();
    });

    it("treats threshold 0 as disabled and does NOT auto-stop even at low battery", async () => {
      mockIsActive.mockReturnValue(true);
      mockGetThreshold.mockReturnValue(0);
      mockGetBatteryPercent.mockResolvedValue(5);

      await handle.initBatteryMonitoring();

      const onBatteryCall = mockPowerMonitor.on.mock.calls.find(
        (call: unknown[]) => call[0] === "on-battery",
      );
      const onBatteryCallback = onBatteryCall![1] as () => void;
      onBatteryCallback();

      await vi.advanceTimersByTimeAsync(50);

      expect(mockOnAutoStop).not.toHaveBeenCalled();
    });

    it("treats negative threshold as disabled and does NOT auto-stop", async () => {
      mockIsActive.mockReturnValue(true);
      mockGetThreshold.mockReturnValue(-10);
      mockGetBatteryPercent.mockResolvedValue(1);

      await handle.initBatteryMonitoring();

      const onBatteryCall = mockPowerMonitor.on.mock.calls.find(
        (call: unknown[]) => call[0] === "on-battery",
      );
      const onBatteryCallback = onBatteryCall![1] as () => void;
      onBatteryCallback();

      await vi.advanceTimersByTimeAsync(50);

      expect(mockOnAutoStop).not.toHaveBeenCalled();
    });

    it("does NOT auto-stop when not preventing sleep", async () => {
      mockIsActive.mockReturnValue(false);
      mockGetThreshold.mockReturnValue(80);

      await handle.initBatteryMonitoring();

      const onBatteryCall = mockPowerMonitor.on.mock.calls.find(
        (call: unknown[]) => call[0] === "on-battery",
      );
      const onBatteryCallback = onBatteryCall![1] as () => void;
      onBatteryCallback();

      await vi.advanceTimersByTimeAsync(50);

      expect(mockOnAutoStop).not.toHaveBeenCalled();
    });

    it("does NOT auto-stop when battery above threshold", async () => {
      mockIsActive.mockReturnValue(true);
      mockGetThreshold.mockReturnValue(20);
      mockGetBatteryPercent.mockResolvedValue(75);

      await handle.initBatteryMonitoring();

      const onBatteryCall = mockPowerMonitor.on.mock.calls.find(
        (call: unknown[]) => call[0] === "on-battery",
      );
      const onBatteryCallback = onBatteryCall![1] as () => void;
      onBatteryCallback();

      await vi.advanceTimersByTimeAsync(50);

      expect(mockOnAutoStop).not.toHaveBeenCalled();
    });

    it("does NOT auto-stop when charge percent is unavailable", async () => {
      mockIsActive.mockReturnValue(true);
      mockGetThreshold.mockReturnValue(80);
      mockGetBatteryPercent.mockResolvedValue(null);

      await handle.initBatteryMonitoring();

      const onBatteryCall = mockPowerMonitor.on.mock.calls.find(
        (call: unknown[]) => call[0] === "on-battery",
      );
      const onBatteryCallback = onBatteryCall![1] as () => void;
      onBatteryCallback();

      await vi.advanceTimersByTimeAsync(50);

      expect(mockOnAutoStop).not.toHaveBeenCalled();
    });
  });

  describe("on-ac event", () => {
    it("registers on-ac listener and logs info", async () => {
      await handle.initBatteryMonitoring();

      const onAcCall = mockPowerMonitor.on.mock.calls.find(
        (call: unknown[]) => call[0] === "on-ac",
      );
      expect(onAcCall).toBeDefined();

      const onAcCallback = onAcCall![1] as () => void;
      onAcCallback();

      expect(mockLogInfo).toHaveBeenCalled();
    });
  });

  describe("periodic battery checks (FIX 1)", () => {
    beforeEach(() => {
      mockGetThreshold.mockReturnValue(20);
    });

    it("starts setInterval when on battery power and preventing sleep", async () => {
      mockPowerMonitor.isOnBatteryPower.mockReturnValue(true);
      mockIsActive.mockReturnValue(true);
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

      await handle.initBatteryMonitoring();

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
      setIntervalSpy.mockRestore();
    });

    it("does NOT start setInterval when not on battery power", async () => {
      mockPowerMonitor.isOnBatteryPower.mockReturnValue(false);
      mockIsActive.mockReturnValue(true);
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

      await handle.initBatteryMonitoring();

      expect(setIntervalSpy).not.toHaveBeenCalled();
      setIntervalSpy.mockRestore();
    });

    it("does NOT start setInterval when not preventing sleep", async () => {
      mockPowerMonitor.isOnBatteryPower.mockReturnValue(true);
      mockIsActive.mockReturnValue(false);
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

      await handle.initBatteryMonitoring();

      expect(setIntervalSpy).not.toHaveBeenCalled();
      setIntervalSpy.mockRestore();
    });

    it("does NOT start setInterval when threshold is 0 (disabled), even on battery + preventing", async () => {
      mockPowerMonitor.isOnBatteryPower.mockReturnValue(true);
      mockIsActive.mockReturnValue(true);
      mockGetThreshold.mockReturnValue(0);
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

      await handle.initBatteryMonitoring();
      handle.onPreventSleepChange(true);

      expect(setIntervalSpy).not.toHaveBeenCalled();
      setIntervalSpy.mockRestore();
    });

    it("calls .unref() on the interval", async () => {
      mockPowerMonitor.isOnBatteryPower.mockReturnValue(true);
      mockIsActive.mockReturnValue(true);
      const fakeInterval = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(fakeInterval);

      await handle.initBatteryMonitoring();

      expect(fakeInterval.unref).toHaveBeenCalled();
      setIntervalSpy.mockRestore();
    });

    it("registers a resume listener that re-starts polling", async () => {
      await handle.initBatteryMonitoring();

      const resumeCall = mockPowerMonitor.on.mock.calls.find(
        (call: unknown[]) => call[0] === "resume",
      );
      expect(resumeCall).toBeDefined();

      mockPowerMonitor.isOnBatteryPower.mockReturnValue(true);
      mockIsActive.mockReturnValue(true);
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const resumeCallback = resumeCall![1] as () => void;
      resumeCallback();

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
      setIntervalSpy.mockRestore();
    });

    it("auto-stops on resume before the periodic interval fires", async () => {
      mockPowerMonitor.isOnBatteryPower.mockReturnValue(true);
      mockIsActive.mockReturnValue(true);
      mockGetThreshold.mockReturnValue(80);
      mockGetBatteryPercent.mockResolvedValue(75);

      await handle.initBatteryMonitoring();

      const resumeCall = mockPowerMonitor.on.mock.calls.find(
        (call: unknown[]) => call[0] === "resume",
      );
      expect(resumeCall).toBeDefined();
      if (resumeCall === undefined) {
        throw new Error("resume listener was not registered");
      }

      const resumeCallback = resumeCall[1];
      expect(typeof resumeCallback).toBe("function");
      if (typeof resumeCallback !== "function") {
        throw new Error("resume listener was not callable");
      }

      resumeCallback();

      await vi.advanceTimersByTimeAsync(50);

      expect(mockOnAutoStop).toHaveBeenCalledTimes(1);
    });

    it("does NOT auto-stop on resume while on AC power", async () => {
      mockPowerMonitor.isOnBatteryPower.mockReturnValue(false);
      mockIsActive.mockReturnValue(true);
      mockGetThreshold.mockReturnValue(80);

      await handle.initBatteryMonitoring();

      const resumeCall = mockPowerMonitor.on.mock.calls.find(
        (call: unknown[]) => call[0] === "resume",
      );
      expect(resumeCall).toBeDefined();
      if (resumeCall === undefined) {
        throw new Error("resume listener was not registered");
      }

      const resumeCallback = resumeCall[1];
      expect(typeof resumeCallback).toBe("function");
      if (typeof resumeCallback !== "function") {
        throw new Error("resume listener was not callable");
      }

      resumeCallback();

      await vi.advanceTimersByTimeAsync(50);

      expect(mockOnAutoStop).not.toHaveBeenCalled();
    });

    it("clears interval when on-ac fires", async () => {
      mockPowerMonitor.isOnBatteryPower.mockReturnValue(true);
      mockIsActive.mockReturnValue(true);
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

      await handle.initBatteryMonitoring();

      const onAcCall = mockPowerMonitor.on.mock.calls.find(
        (call: unknown[]) => call[0] === "on-ac",
      );
      const onAcCallback = onAcCall![1] as () => void;
      onAcCallback();

      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });

    it("onPreventSleepChange(true) starts polling when on battery", () => {
      mockPowerMonitor.isOnBatteryPower.mockReturnValue(true);
      mockIsActive.mockReturnValue(true);
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

      handle.onPreventSleepChange(true);

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
      setIntervalSpy.mockRestore();
    });

    it("onPreventSleepChange(false) clears the interval", async () => {
      mockPowerMonitor.isOnBatteryPower.mockReturnValue(true);
      mockIsActive.mockReturnValue(true);
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

      await handle.initBatteryMonitoring();
      handle.onPreventSleepChange(false);

      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });

    it("cleanup removes resume listener and clears interval", async () => {
      mockPowerMonitor.isOnBatteryPower.mockReturnValue(true);
      mockIsActive.mockReturnValue(true);
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

      await handle.initBatteryMonitoring();
      handle.cleanupBatteryMonitoring();

      expect(mockPowerMonitor.off).toHaveBeenCalledWith("resume", expect.any(Function));
      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });
  });

  describe("benchmark battery counters", () => {
    beforeEach(async () => {
      mockIsBenchmarkMode.mockReturnValue(true);
      vi.resetModules();
      const mod = await import("../../src/main/battery-monitor.js");
      mod.resetBatteryBenchmarkCounters();
      handle = mod.createBatteryMonitor({
        getThreshold: () => mockGetThreshold(),
        onAutoStop: () => mockOnAutoStop(),
        isPreventingSleep: () => mockIsActive(),
      });
    });

    afterEach(() => {
      mockIsBenchmarkMode.mockReturnValue(false);
    });

    it("records scheduled and completedRead on active gated check", async () => {
      mockGetThreshold.mockReturnValue(20);
      mockIsActive.mockReturnValue(true);
      mockPowerMonitor.isOnBatteryPower.mockReturnValue(true);
      mockGetBatteryPercent.mockResolvedValue(50);

      await handle.initBatteryMonitoring();
      // startPeriodic at init
      const mod = await import("../../src/main/battery-monitor.js");
      expect(mod.getBatteryBenchmarkCounters().scheduled).toBeGreaterThanOrEqual(1);

      // Fire on-battery listener for a check
      const onBattery = mockPowerMonitor.on.mock.calls.find((c) => c[0] === "on-battery")?.[1] as
        (() => void) | undefined;
      onBattery?.();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();

      const counters = mod.getBatteryBenchmarkCounters();
      expect(counters.callbackAttempted).toBeGreaterThanOrEqual(1);
      expect(counters.completedRead).toBeGreaterThanOrEqual(1);
    });

    it("records guardedSkipped when threshold disabled (no completed read)", async () => {
      mockGetThreshold.mockReturnValue(0);
      mockIsActive.mockReturnValue(true);
      mockPowerMonitor.isOnBatteryPower.mockReturnValue(true);
      const mod = await import("../../src/main/battery-monitor.js");
      mod.resetBatteryBenchmarkCounters();

      await handle.initBatteryMonitoring();
      const onBattery = mockPowerMonitor.on.mock.calls.find((c) => c[0] === "on-battery")?.[1] as
        (() => void) | undefined;
      onBattery?.();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();

      const counters = mod.getBatteryBenchmarkCounters();
      expect(counters.callbackAttempted).toBeGreaterThanOrEqual(1);
      expect(counters.guardedSkipped).toBeGreaterThanOrEqual(1);
      expect(counters.completedRead).toBe(0);
      // No periodic schedule when threshold disabled
      expect(counters.scheduled).toBe(0);
    });

    it("returns zeros when not in benchmark mode", async () => {
      mockIsBenchmarkMode.mockReturnValue(false);
      vi.resetModules();
      const mod = await import("../../src/main/battery-monitor.js");
      const h = mod.createBatteryMonitor({
        getThreshold: () => 20,
        onAutoStop: () => {},
        isPreventingSleep: () => true,
      });
      mockPowerMonitor.isOnBatteryPower.mockReturnValue(true);
      await h.initBatteryMonitoring();
      expect(mod.getBatteryBenchmarkCounters()).toEqual({
        scheduled: 0,
        callbackAttempted: 0,
        guardedSkipped: 0,
        completedRead: 0,
      });
    });
  });
});
