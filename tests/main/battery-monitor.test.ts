import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BatteryMonitorHandle } from "../../src/main/battery-monitor.js";

const mockPowerMonitor = vi.hoisted(() => ({
  on: vi.fn(),
  off: vi.fn(),
  isOnBatteryPower: vi.fn().mockReturnValue(false),
}));
const mockLogInfo = vi.hoisted(() => vi.fn());
const mockLogWarn = vi.hoisted(() => vi.fn());
const mockLogError = vi.hoisted(() => vi.fn());

/** Controllable charge percent for monitor integration tests (platform-independent). */
const mockGetBatteryPercent = vi.hoisted(() => vi.fn().mockResolvedValue(75));

vi.mock("electron-log", () => ({
  default: { info: mockLogInfo, warn: mockLogWarn, error: mockLogError },
}));

const sensor = {
  getPercent: () => mockGetBatteryPercent() as Promise<number | null>,
  isOnBatteryPower: () => mockPowerMonitor.isOnBatteryPower() as boolean,
  onPowerSourceChange: (handlers: {
    onBattery: () => void;
    onAc: () => void;
    onResume: () => void;
  }) => {
    mockPowerMonitor.on("on-battery", handlers.onBattery);
    mockPowerMonitor.on("on-ac", handlers.onAc);
    mockPowerMonitor.on("resume", handlers.onResume);
    return () => {
      mockPowerMonitor.off("on-battery", handlers.onBattery);
      mockPowerMonitor.off("on-ac", handlers.onAc);
      mockPowerMonitor.off("resume", handlers.onResume);
    };
  },
};

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
      sensor,
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
    // Deterministic power source per test (the on-battery event implies battery power).
    mockPowerMonitor.isOnBatteryPower.mockReturnValue(false);
    mockGetThreshold = vi.fn<() => number>().mockReturnValue(0);
    mockOnAutoStop = vi.fn<() => void>();
    mockIsActive = vi.fn<() => boolean>().mockReturnValue(false);
    mockGetBatteryPercent.mockReset();
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

    it("does not subscribe or check twice on repeated initialization", async () => {
      mockGetThreshold.mockReturnValue(80);
      mockIsActive.mockReturnValue(true);
      mockPowerMonitor.isOnBatteryPower.mockReturnValue(true);

      await handle.initBatteryMonitoring();
      await handle.initBatteryMonitoring();

      expect(mockPowerMonitor.on).toHaveBeenCalledTimes(3);
      expect(mockGetBatteryPercent).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
    });

    it("unsubscribes exact callbacks once and ignores init after cleanup", async () => {
      await handle.initBatteryMonitoring();

      handle.cleanupBatteryMonitoring();
      handle.cleanupBatteryMonitoring();
      await handle.initBatteryMonitoring();

      expect(mockPowerMonitor.off.mock.calls).toEqual(mockPowerMonitor.on.mock.calls);
      expect(mockPowerMonitor.off).toHaveBeenCalledTimes(3);
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
    beforeEach(() => {
      // Electron reports battery power whenever it emits on-battery.
      mockPowerMonitor.isOnBatteryPower.mockReturnValue(true);
    });

    it("coalesces overlapping triggers into one follow-up and never retries a failed read alone", async () => {
      mockGetThreshold.mockReturnValue(80);
      mockIsActive.mockReturnValue(true);
      const read = Promise.withResolvers<number | null>();
      mockGetBatteryPercent.mockReturnValueOnce(read.promise);
      mockGetBatteryPercent.mockRejectedValueOnce(new Error("sensor unavailable"));
      mockGetBatteryPercent.mockResolvedValueOnce(5);
      await handle.initBatteryMonitoring();
      const onBattery = mockPowerMonitor.on.mock.calls.find(
        (call) => call[0] === "on-battery",
      )?.[1];
      expect(onBattery).toBeTypeOf("function");

      onBattery();
      onBattery();
      onBattery();
      expect(mockGetBatteryPercent).toHaveBeenCalledTimes(1);
      read.resolve(null);
      await vi.advanceTimersByTimeAsync(0);
      // One follow-up for the two overlapping triggers; it fails and is not retried.
      expect(mockGetBatteryPercent).toHaveBeenCalledTimes(2);
      expect(mockLogWarn).toHaveBeenCalledTimes(1);
      expect(mockOnAutoStop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockGetBatteryPercent).toHaveBeenCalledTimes(2);

      onBattery();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockOnAutoStop).toHaveBeenCalledTimes(1);
      expect(mockGetBatteryPercent).toHaveBeenCalledTimes(3);
    });
    it("discards a battery read completing after disposal", async () => {
      mockPowerMonitor.isOnBatteryPower.mockReturnValue(true);
      const read = Promise.withResolvers<number | null>();
      const onPercentSample = vi.fn();
      mockIsActive.mockReturnValue(true);
      mockGetThreshold.mockReturnValue(80);
      mockGetBatteryPercent.mockReturnValue(read.promise);
      const { createBatteryMonitor } = await import("../../src/main/battery-monitor.js");
      const monitor = createBatteryMonitor({
        sensor,
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

  describe("read authority (deferred reads)", () => {
    let onPercentSample: ReturnType<typeof vi.fn<(percent: number | null) => void>>;
    let monitor: BatteryMonitorHandle;
    /** Deferred sensor reads, resolved by the test in issue order. */
    let reads: PromiseWithResolvers<number | null>[];

    function powerHandler(event: "on-battery" | "on-ac" | "resume"): () => void {
      const handler = mockPowerMonitor.on.mock.calls.findLast((call) => call[0] === event)?.[1];
      if (typeof handler !== "function") throw new Error(`Missing ${event} listener`);
      return handler as () => void;
    }

    async function settleRead(index: number, percent: number | null): Promise<void> {
      const read = reads[index];
      if (read === undefined) throw new Error(`Read ${index} was never issued`);
      read.resolve(percent);
      await vi.advanceTimersByTimeAsync(0);
    }

    beforeEach(async () => {
      reads = [];
      mockGetBatteryPercent.mockImplementation(() => {
        const read = Promise.withResolvers<number | null>();
        reads.push(read);
        return read.promise;
      });
      mockGetThreshold.mockReturnValue(20);
      mockIsActive.mockReturnValue(true);
      mockPowerMonitor.isOnBatteryPower.mockReturnValue(true);
      onPercentSample = vi.fn<(percent: number | null) => void>();
      const mod = await import("../../src/main/battery-monitor.js");
      monitor = mod.createBatteryMonitor({
        sensor,
        getThreshold: () => mockGetThreshold(),
        onAutoStop: () => mockOnAutoStop(),
        isPreventingSleep: () => mockIsActive(),
        onPercentSample: (percent) => onPercentSample(percent),
      });
      await monitor.initBatteryMonitoring();
    });

    afterEach(() => {
      monitor.cleanupBatteryMonitoring();
    });

    it("discards a stale reading after the threshold is disabled and re-enabled mid-read", async () => {
      powerHandler("on-battery")();
      mockGetThreshold.mockReturnValue(0);
      monitor.reconfigure();
      mockGetThreshold.mockReturnValue(20);
      monitor.reconfigure();
      expect(mockGetBatteryPercent).toHaveBeenCalledTimes(1);

      await settleRead(0, 5);
      expect(onPercentSample).not.toHaveBeenCalled();
      expect(mockOnAutoStop).not.toHaveBeenCalled();

      // The re-enable earned one fresh check under the current threshold.
      expect(mockGetBatteryPercent).toHaveBeenCalledTimes(2);
      await settleRead(1, 50);
      expect(onPercentSample.mock.calls).toEqual([[50]]);
      expect(mockOnAutoStop).not.toHaveBeenCalled();
      expect(mockGetBatteryPercent).toHaveBeenCalledTimes(2);
    });

    it("discards a reading after prevention turns off and on again, then stops on a fresh low read", async () => {
      powerHandler("on-battery")();
      mockIsActive.mockReturnValue(false);
      monitor.onPreventSleepChange(false);
      mockIsActive.mockReturnValue(true);
      monitor.onPreventSleepChange(true);

      await settleRead(0, 5);
      expect(onPercentSample).not.toHaveBeenCalled();
      expect(mockOnAutoStop).not.toHaveBeenCalled();
      expect(mockGetBatteryPercent).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockGetBatteryPercent).toHaveBeenCalledTimes(2);
      await settleRead(1, 5);
      expect(onPercentSample.mock.calls).toEqual([[5]]);
      expect(mockOnAutoStop).toHaveBeenCalledOnce();
    });

    it("discards a reading once the machine moves onto AC power", async () => {
      powerHandler("on-battery")();
      mockPowerMonitor.isOnBatteryPower.mockReturnValue(false);
      powerHandler("on-ac")();

      await settleRead(0, 5);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(onPercentSample).not.toHaveBeenCalled();
      expect(mockOnAutoStop).not.toHaveBeenCalled();
      expect(mockGetBatteryPercent).toHaveBeenCalledTimes(1);
    });

    it("revokes a reading across AC and back to battery, then trusts only the fresh check", async () => {
      powerHandler("on-battery")();
      mockPowerMonitor.isOnBatteryPower.mockReturnValue(false);
      powerHandler("on-ac")();
      mockPowerMonitor.isOnBatteryPower.mockReturnValue(true);
      powerHandler("on-battery")();

      await settleRead(0, 3);
      expect(onPercentSample).not.toHaveBeenCalled();
      expect(mockOnAutoStop).not.toHaveBeenCalled();
      await settleRead(1, 7);
      expect(onPercentSample.mock.calls).toEqual([[7]]);
      expect(mockOnAutoStop).toHaveBeenCalledOnce();
      expect(mockLogInfo).toHaveBeenCalledWith(
        "[battery] Auto-stop triggered: battery at 7% (threshold: 20%)",
      );
    });

    it("revokes a reading that straddles system resume", async () => {
      vi.advanceTimersByTime(60_000);
      expect(mockGetBatteryPercent).toHaveBeenCalledTimes(1);
      powerHandler("resume")();

      await settleRead(0, 5);
      expect(onPercentSample).not.toHaveBeenCalled();
      await settleRead(1, 60);
      expect(onPercentSample.mock.calls).toEqual([[60]]);
      expect(mockOnAutoStop).not.toHaveBeenCalled();
    });

    it.each([
      ["sleep prevention is no longer active", () => mockIsActive.mockReturnValue(false)],
      ["the threshold is no longer enabled", () => mockGetThreshold.mockReturnValue(0)],
      [
        "the machine is no longer on battery",
        () => mockPowerMonitor.isOnBatteryPower.mockReturnValue(false),
      ],
    ])("re-checks authority after the read when %s", async (_label, revoke) => {
      powerHandler("on-battery")();
      revoke();

      await settleRead(0, 5);
      expect(onPercentSample).not.toHaveBeenCalled();
      expect(mockOnAutoStop).not.toHaveBeenCalled();
    });

    it("discards a reading and its owed follow-up when the monitor is cleaned up", async () => {
      powerHandler("on-battery")();
      powerHandler("on-battery")();
      monitor.cleanupBatteryMonitoring();

      await settleRead(0, 5);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onPercentSample).not.toHaveBeenCalled();
      expect(mockOnAutoStop).not.toHaveBeenCalled();
      expect(mockGetBatteryPercent).toHaveBeenCalledTimes(1);
    });

    it("drops ineligible triggers during a read and a follow-up that became ineligible", async () => {
      powerHandler("on-battery")();
      mockIsActive.mockReturnValue(false);
      await vi.advanceTimersByTimeAsync(60_000);
      mockIsActive.mockReturnValue(true);

      await settleRead(0, 40);
      // No transition happened, so the reading keeps its authority.
      expect(onPercentSample.mock.calls).toEqual([[40]]);
      expect(mockGetBatteryPercent).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockGetBatteryPercent).toHaveBeenCalledTimes(2);
      powerHandler("on-battery")();
      mockGetThreshold.mockReturnValue(0);
      await settleRead(1, 5);
      expect(onPercentSample.mock.calls).toEqual([[40]]);
      expect(mockGetBatteryPercent).toHaveBeenCalledTimes(2);
    });

    it("keeps one read in flight for bursts from every trigger source", async () => {
      powerHandler("on-battery")();
      powerHandler("resume")();
      monitor.reconfigure();
      await vi.advanceTimersByTimeAsync(60_000);
      powerHandler("on-battery")();
      expect(mockGetBatteryPercent).toHaveBeenCalledTimes(1);

      await settleRead(0, 50);
      expect(mockGetBatteryPercent).toHaveBeenCalledTimes(2);
      await settleRead(1, 50);
      expect(mockGetBatteryPercent).toHaveBeenCalledTimes(2);
      expect(onPercentSample.mock.calls).toEqual([[50]]);
    });

    it("stays silent when a read rejects after cleanup", async () => {
      powerHandler("on-battery")();
      monitor.cleanupBatteryMonitoring();
      const read = reads[0];
      if (read === undefined) throw new Error("read was never issued");
      read.reject(new Error("pmset exited"));
      await vi.advanceTimersByTimeAsync(0);

      expect(mockLogWarn).not.toHaveBeenCalled();
      expect(mockLogError).not.toHaveBeenCalled();
    });

    it("ignores prevention changes after cleanup", () => {
      monitor.cleanupBatteryMonitoring();
      monitor.onPreventSleepChange(true);

      expect(vi.getTimerCount()).toBe(0);
    });

    it("ignores a late power event delivered after cleanup", async () => {
      const onBattery = powerHandler("on-battery");
      monitor.cleanupBatteryMonitoring();

      onBattery();
      expect(mockGetBatteryPercent).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("logs a failing auto-stop response and releases the read guard", async () => {
      const failure = new Error("session cancel failed");
      mockOnAutoStop.mockImplementationOnce(() => {
        throw failure;
      });
      powerHandler("on-battery")();
      await settleRead(0, 5);

      expect(mockLogError).toHaveBeenCalledExactlyOnceWith(
        "[battery] Battery check error:",
        failure,
      );
      powerHandler("on-battery")();
      expect(mockGetBatteryPercent).toHaveBeenCalledTimes(2);
    });

    it("does not sample on AC power when the threshold is reconfigured", async () => {
      mockPowerMonitor.isOnBatteryPower.mockReturnValue(false);
      powerHandler("on-ac")();
      monitor.reconfigure();

      expect(mockGetBatteryPercent).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("benchmark battery counters", () => {
    beforeEach(async () => {
      mockIsBenchmarkMode.mockReturnValue(true);
      vi.resetModules();
      const mod = await import("../../src/main/battery-monitor.js");
      mod.resetBatteryBenchmarkCounters();
      handle = mod.createBatteryMonitor({
        sensor,
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

    it("counts scheduled, attempts, overlap skips and completed reads exactly", async () => {
      mockGetThreshold.mockReturnValue(80);
      mockIsActive.mockReturnValue(true);
      mockPowerMonitor.isOnBatteryPower.mockReturnValue(true);
      const read = Promise.withResolvers<number | null>();
      mockGetBatteryPercent.mockReturnValue(read.promise);
      await handle.initBatteryMonitoring();
      const onBattery = mockPowerMonitor.on.mock.calls.find(
        (call) => call[0] === "on-battery",
      )?.[1];
      onBattery();
      onBattery();
      const mod = await import("../../src/main/battery-monitor.js");
      expect(mod.getBatteryBenchmarkCounters()).toEqual({
        scheduled: 1,
        callbackAttempted: 2,
        guardedSkipped: 1,
        completedRead: 0,
      });

      read.resolve(null);
      await vi.advanceTimersByTimeAsync(0);
      // The coalesced follow-up is one more guard entry and one more completed read.
      expect(mod.getBatteryBenchmarkCounters()).toEqual({
        scheduled: 1,
        callbackAttempted: 3,
        guardedSkipped: 1,
        completedRead: 2,
      });
      handle.cleanupBatteryMonitoring();
    });

    it("counts a stale read as completed and an ineligible follow-up as a guarded skip", async () => {
      mockGetThreshold.mockReturnValue(80);
      mockIsActive.mockReturnValue(true);
      mockPowerMonitor.isOnBatteryPower.mockReturnValue(true);
      const read = Promise.withResolvers<number | null>();
      mockGetBatteryPercent.mockReturnValueOnce(read.promise);
      await handle.initBatteryMonitoring();
      const onBattery = mockPowerMonitor.on.mock.calls.find(
        (call) => call[0] === "on-battery",
      )?.[1];
      const onAc = mockPowerMonitor.on.mock.calls.find((call) => call[0] === "on-ac")?.[1];
      onBattery();
      onBattery();
      mockPowerMonitor.isOnBatteryPower.mockReturnValue(false);
      onAc();
      read.resolve(5);
      await vi.advanceTimersByTimeAsync(0);

      const mod = await import("../../src/main/battery-monitor.js");
      expect(mod.getBatteryBenchmarkCounters()).toEqual({
        scheduled: 1,
        callbackAttempted: 3,
        guardedSkipped: 2,
        completedRead: 1,
      });
      expect(mockGetBatteryPercent).toHaveBeenCalledTimes(1);
      expect(mockOnAutoStop).not.toHaveBeenCalled();
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
        sensor,
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
