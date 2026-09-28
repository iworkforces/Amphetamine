import log from "electron-log";
import type { BatterySensorPort } from "../application/ports/battery-sensor.port.js";
import { isThresholdEnabled } from "../domain/battery/threshold.js";
import { isBenchmarkMode } from "../infrastructure/benchmark/benchmark-env.js";
import type { BatteryBenchmarkCounters } from "../shared/benchmark-types.js";
import { DEFAULT_BATTERY_BENCHMARK_COUNTERS } from "../shared/benchmark-types.js";

/** Interval (ms) between periodic battery polls while on battery and preventing sleep. */
const PERIODIC_BATTERY_CHECK_MS = 60_000;

/** Module-level semantic counters; only incremented when `isBenchmarkMode()`. */
const batteryCounters = {
  scheduled: 0,
  callbackAttempted: 0,
  guardedSkipped: 0,
  completedRead: 0,
};

function recordBattery(metric: keyof typeof batteryCounters): void {
  if (!isBenchmarkMode()) return;
  batteryCounters[metric] += 1;
}

/** Snapshot for benchmark artifacts (zeros outside benchmark mode). */
export function getBatteryBenchmarkCounters(): BatteryBenchmarkCounters {
  if (!isBenchmarkMode()) {
    return { ...DEFAULT_BATTERY_BENCHMARK_COUNTERS };
  }
  return {
    scheduled: batteryCounters.scheduled,
    callbackAttempted: batteryCounters.callbackAttempted,
    guardedSkipped: batteryCounters.guardedSkipped,
    completedRead: batteryCounters.completedRead,
  };
}

/** Test seam: reset counters between suites. */
export function resetBatteryBenchmarkCounters(): void {
  batteryCounters.scheduled = 0;
  batteryCounters.callbackAttempted = 0;
  batteryCounters.guardedSkipped = 0;
  batteryCounters.completedRead = 0;
}

/**
 * Dependencies for the battery monitor.
 *
 * The battery monitor is a pure detector: when the threshold is crossed,
 * it notifies composition via `onAutoStop()` and composition owns
 * the policy response (cancelling sessions, disabling standing preferences,
 * and stopping sleep prevention). The monitor never touches sleep-prevention
 * state directly.
 *
 * Charge percent and power source are read through the injected sensor.
 *
 * All fields are required — there is no silent fallback. Wiring is enforced
 * at construction time by `createBatteryMonitor`.
 */
export interface BatteryDeps {
  sensor: BatterySensorPort;
  /** Returns the configured battery threshold (%). 0 / non-positive ⇒ auto-disable is OFF. */
  getThreshold: () => number;
  /** Invoked when battery drops at or below threshold; composition owns the response. */
  onAutoStop: () => void;
  /** Returns true if sleep prevention is currently active (used to gate polling). */
  isPreventingSleep: () => boolean;
  /** Optional: report last successful charge percent for user feedback. */
  onPercentSample?: (percent: number | null) => void;
}

/** Public handle returned by `createBatteryMonitor`. */
export interface BatteryMonitorHandle {
  initBatteryMonitoring: () => Promise<void>;
  cleanupBatteryMonitoring: () => void;
  /**
   * Bridge invoked by composition whenever sleep-prevention state flips.
   * Starts/stops the periodic battery polling loop based on (onBattery && active).
   */
  onPreventSleepChange: (active: boolean) => void;
  /**
   * Re-evaluate polling after threshold (or other policy input) changes.
   * Stops any interval, restarts if gates pass, and runs an immediate check
   * when threshold is enabled and sleep prevention is active.
   */
  reconfigure: () => void;
}

/**
 * Create a battery monitor instance bound to the given dependencies.
 *
 * Throws synchronously if any dependency is missing — there are no silent
 * fallbacks. Replaces the previous 4-setter DI pattern.
 */
export function createBatteryMonitor(deps: BatteryDeps): BatteryMonitorHandle {
  if (typeof deps.getThreshold !== "function") {
    throw new TypeError("createBatteryMonitor: deps.getThreshold must be a function");
  }
  if (typeof deps.onAutoStop !== "function") {
    throw new TypeError("createBatteryMonitor: deps.onAutoStop must be a function");
  }
  if (typeof deps.isPreventingSleep !== "function") {
    throw new TypeError("createBatteryMonitor: deps.isPreventingSleep must be a function");
  }

  const { sensor } = deps;
  const { getThreshold, onAutoStop, isPreventingSleep } = deps;
  const onPercentSample = deps.onPercentSample;

  let isCheckingBattery = false;
  let disposed = false;
  let unsubscribePowerSource: (() => void) | null = null;
  let batteryCheckInterval: ReturnType<typeof setInterval> | null = null;

  const checkBatteryAndStop = async (): Promise<void> => {
    const threshold = getThreshold();
    if (!isThresholdEnabled(threshold)) {
      recordBattery("guardedSkipped");
      return;
    }
    if (!isPreventingSleep()) {
      recordBattery("guardedSkipped");
      return;
    }

    try {
      const percent = await sensor.getPercent();
      recordBattery("completedRead");
      if (disposed) return;
      onPercentSample?.(percent);
      if (percent !== null && percent <= threshold) {
        log.info(
          `[battery] Auto-stop triggered: battery at ${percent}% (threshold: ${threshold}%)`,
        );
        onAutoStop();
      }
    } catch (err) {
      // Still a completed attempt past the gate (I/O failed after entry).
      recordBattery("completedRead");
      if (!disposed) log.warn("[battery] Failed to check battery level:", err);
    }
  };

  const runGuardedBatteryCheck = (errorMessage: string): void => {
    recordBattery("callbackAttempted");
    if (disposed || isCheckingBattery) {
      recordBattery("guardedSkipped");
      return;
    }
    isCheckingBattery = true;
    void checkBatteryAndStop()
      .catch((err) => log.error(errorMessage, err))
      .finally(() => {
        isCheckingBattery = false;
      });
  };

  /**
   * Start the periodic battery polling loop.
   * Gated: only runs when threshold is enabled (> 0), on battery power, AND sleep prevention is active.
   * Idempotent — safe to call repeatedly.
   */
  const startPeriodicBatteryChecks = (): void => {
    if (disposed || batteryCheckInterval !== null) return;
    if (!isThresholdEnabled(getThreshold())) return;
    if (!sensor.isOnBatteryPower()) return;
    if (!isPreventingSleep()) return;
    batteryCheckInterval = setInterval(() => {
      runGuardedBatteryCheck("[battery] Periodic battery check error:");
    }, PERIODIC_BATTERY_CHECK_MS);
    // unref so the interval doesn't pin the event loop (test/cleanup safety)
    batteryCheckInterval.unref();
    recordBattery("scheduled");
  };

  /** Stop the periodic battery polling loop, if running. */
  const stopPeriodicBatteryChecks = (): void => {
    if (batteryCheckInterval !== null) {
      clearInterval(batteryCheckInterval);
      batteryCheckInterval = null;
    }
  };

  /** @internal Power monitor listeners persist for app lifetime by design. */
  const initBatteryMonitoring = async (): Promise<void> => {
    if (disposed || unsubscribePowerSource !== null) return;
    unsubscribePowerSource = sensor.onPowerSourceChange({
      onBattery: () => {
        runGuardedBatteryCheck("[battery] Battery check error:");
        startPeriodicBatteryChecks();
      },
      onAc: () => {
        log.info("[battery] On AC power, battery monitoring reset");
        stopPeriodicBatteryChecks();
      },
      onResume: () => {
        if (sensor.isOnBatteryPower()) {
          runGuardedBatteryCheck("[battery] Battery check error:");
        }
        startPeriodicBatteryChecks();
      },
    });

    // If we're already on battery and preventing sleep at init time, kick off polling.
    startPeriodicBatteryChecks();
  };

  /** Remove power monitor listeners. For completeness in cleanup paths. */
  const cleanupBatteryMonitoring = (): void => {
    if (disposed) return;
    disposed = true;
    stopPeriodicBatteryChecks();
    unsubscribePowerSource?.();
    unsubscribePowerSource = null;
  };

  /**
   * Bridge from composition: sleep-prevention state changed. Start the polling
   * loop when prevention turns on (and we're on battery); stop it when off.
   */
  const onPreventSleepChange = (active: boolean): void => {
    if (disposed) return;
    if (active) {
      startPeriodicBatteryChecks();
    } else {
      stopPeriodicBatteryChecks();
    }
  };

  /**
   * Threshold (or other policy) changed — restart the polling loop from current
   * gates so enabling auto-disable while already preventing sleep on battery
   * actually starts monitoring.
   */
  const reconfigure = (): void => {
    if (disposed) return;
    stopPeriodicBatteryChecks();
    startPeriodicBatteryChecks();
    if (isThresholdEnabled(getThreshold()) && isPreventingSleep()) {
      runGuardedBatteryCheck("[battery] Reconfigure battery check error:");
    }
  };

  return {
    initBatteryMonitoring,
    cleanupBatteryMonitoring,
    onPreventSleepChange,
    reconfigure,
  };
}
