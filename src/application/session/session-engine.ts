import type { PerfTimestamp } from "../../domain/time/perf-timestamp.js";
import { asPerf } from "../../domain/time/perf-timestamp.js";
import { MS_PER_MINUTE } from "../../domain/time/units.js";
import { MAX_SESSION_DURATION_MINUTES } from "../../domain/session/duration.js";
import type { ClockPort } from "../ports/clock.port.js";
import type { SchedulePort } from "../ports/schedule.port.js";
import type { LoggerPort } from "../ports/logger.port.js";
import type { MainToRendererNotifierPort } from "../ports/main-to-renderer-notifier.port.js";
import type {
  SessionExtendResponse,
  SessionStatusResponse,
  TimedSessionStatus,
} from "../../shared/types.js";

/** Public snapshot returned by start/cancel (not the wire SessionStartResponse). */
export interface SessionSnapshot {
  isRunning: boolean;
  startedAt: number | null;
  expiresAt: number | null;
  durationMinutes: number | null;
}

export interface SessionEngineDeps {
  clock: ClockPort;
  schedule: SchedulePort;
  notifier: MainToRendererNotifierPort;
  logger: LoggerPort;
  onSessionActiveChange?: (active: boolean) => void;
}

export interface SessionEngine {
  startSession: (durationMinutes: number | null) => SessionSnapshot;
  extendSession: (additionalMinutes: number) => SessionExtendResponse;
  cancelSession: () => SessionSnapshot;
  getStatus: () => SessionStatusResponse;
  cleanup: () => void;
  reconcileSessionState: () => void;
  broadcastSessionUpdate: () => void;
  /** Re-arm timed expiry after system resume using wall-clock anchor. */
  reconcileAfterResume: () => void;
  readonly sessionActive: boolean;
}

type InternalSessionState =
  | { kind: "idle" }
  | { kind: "indefinite"; startedAt: PerfTimestamp }
  | {
      kind: "timed";
      startedAt: PerfTimestamp;
      expiresAt: PerfTimestamp;
      wallClockExpiresAt: number;
      durationMinutes: number;
      cancelExpiry: () => void;
    };

/**
 * Session state machine: ClockPort + SchedulePort only for time/delay.
 * No setTimeout, powerMonitor, or electron-log imports.
 */
export function createSessionEngine(deps: SessionEngineDeps): SessionEngine {
  if (typeof deps.clock.perfNow !== "function" || typeof deps.clock.wallNow !== "function") {
    throw new TypeError("createSessionEngine: deps.clock must implement ClockPort");
  }
  if (typeof deps.schedule.schedule !== "function") {
    throw new TypeError("createSessionEngine: deps.schedule must implement SchedulePort");
  }
  if (typeof deps.notifier.publish !== "function") {
    throw new TypeError("createSessionEngine: deps.notifier must implement MainToRendererNotifierPort");
  }
  if (
    typeof deps.logger.info !== "function" ||
    typeof deps.logger.warn !== "function" ||
    typeof deps.logger.error !== "function"
  ) {
    throw new TypeError("createSessionEngine: deps.logger must implement LoggerPort");
  }

  const { clock, schedule, notifier, logger } = deps;
  const onSessionActiveChange = deps.onSessionActiveChange;

  let state: InternalSessionState = { kind: "idle" };
  let scheduleGeneration = 0;

  const clearTimedExpiry = (): void => {
    if (state.kind === "timed") {
      scheduleGeneration += 1;
      state.cancelExpiry();
    }
  };

  const getStatus = (): SessionStatusResponse => {
    switch (state.kind) {
      case "idle":
        return {
          isRunning: false,
          startedAt: null,
          expiresAt: null,
          remainingSeconds: null,
          durationMinutes: null,
        };
      case "indefinite":
        return {
          isRunning: true,
          startedAt: state.startedAt,
          expiresAt: null,
          remainingSeconds: null,
          durationMinutes: null,
        };
      case "timed": {
        // Prefer wall-clock remaining so post-sleep UI matches real expiry
        // (perf clock may stall or skew across system sleep).
        const remainingMs = Math.max(0, state.wallClockExpiresAt - clock.wallNow());
        const remainingSeconds = Math.floor(remainingMs / 1000);
        return {
          isRunning: true,
          startedAt: state.startedAt,
          expiresAt: state.expiresAt,
          remainingSeconds,
          durationMinutes: state.durationMinutes,
        };
      }
    }
  };

  const broadcastSessionUpdate = (): void => {
    notifier.publish({ type: "session-status", status: getStatus() });
  };

  const fireExpiry = (): void => {
    clearTimedExpiry();
    state = { kind: "idle" };
    try {
      onSessionActiveChange?.(false);
      broadcastSessionUpdate();
    } catch (err) {
      logger.error("[session] Error in session expiry callback:", err);
    }
  };

  const armTimedExpiry = (delayMs: number): { cancel: () => void } => {
    const generation = ++scheduleGeneration;
    return schedule.schedule(delayMs, () => {
      if (generation === scheduleGeneration) fireExpiry();
    });
  };

  const reconcileSessionState = (): void => {
    // Preference fields must not cancel a live session.
  };

  const startSession = (durationMinutes: number | null): SessionSnapshot => {
    const wasActive = state.kind !== "idle";
    clearTimedExpiry();

    if (durationMinutes === null) {
      const startedAt = clock.perfNow();
      state = { kind: "indefinite", startedAt };
      if (!wasActive) onSessionActiveChange?.(true);
      broadcastSessionUpdate();
      return {
        isRunning: true,
        startedAt,
        expiresAt: null,
        durationMinutes: null,
      };
    }

    const startedAt = clock.perfNow();
    const durationMs = durationMinutes * MS_PER_MINUTE;
    const expiresAt = asPerf(startedAt + durationMs);
    const wallClockExpiresAt = clock.wallNow() + durationMs;
    const handle = armTimedExpiry(durationMs);

    state = {
      kind: "timed",
      startedAt,
      expiresAt,
      wallClockExpiresAt,
      durationMinutes,
      cancelExpiry: handle.cancel,
    };

    if (!wasActive) onSessionActiveChange?.(true);
    broadcastSessionUpdate();

    return {
      isRunning: true,
      startedAt,
      expiresAt,
      durationMinutes,
    };
  };

  const extendSession = (additionalMinutes: number): SessionExtendResponse => {
    if (!Number.isInteger(additionalMinutes) || additionalMinutes <= 0) {
      return { ok: false, reason: "invalid-additional-minutes" };
    }
    if (state.kind === "idle") return { ok: false, reason: "idle" };
    if (state.kind === "indefinite") return { ok: false, reason: "indefinite" };
    const wallNow = clock.wallNow();
    if (state.wallClockExpiresAt <= wallNow) return { ok: false, reason: "expired" };
    const durationMinutes = state.durationMinutes + additionalMinutes;
    if (durationMinutes > MAX_SESSION_DURATION_MINUTES) {
      return { ok: false, reason: "duration-limit" };
    }

    const wallClockExpiresAt = state.wallClockExpiresAt + additionalMinutes * MS_PER_MINUTE;
    const remainingMs = wallClockExpiresAt - wallNow;
    const expiresAt = asPerf(clock.perfNow() + remainingMs);
    clearTimedExpiry();
    const handle = armTimedExpiry(remainingMs);
    state = {
      ...state,
      durationMinutes,
      wallClockExpiresAt,
      expiresAt,
      cancelExpiry: handle.cancel,
    };
    const status: TimedSessionStatus = {
      isRunning: true,
      startedAt: state.startedAt,
      expiresAt,
      remainingSeconds: Math.floor(remainingMs / 1000),
      durationMinutes,
    };
    notifier.publish({ type: "session-status", status });
    return { ok: true, status };
  };

  const cancelSession = (): SessionSnapshot => {
    const wasActive = state.kind !== "idle";
    clearTimedExpiry();
    state = { kind: "idle" };
    if (wasActive) onSessionActiveChange?.(false);
    broadcastSessionUpdate();
    return {
      isRunning: false,
      startedAt: null,
      expiresAt: null,
      durationMinutes: null,
    };
  };

  const reconcileAfterResume = (): void => {
    if (state.kind !== "timed") return;
    const remainingMs = state.wallClockExpiresAt - clock.wallNow();
    if (remainingMs <= 0) {
      fireExpiry();
      return;
    }
    clearTimedExpiry();
    // Realign perf expiry so anchors and any perf-based math match wall remaining.
    const expiresAt = asPerf(clock.perfNow() + remainingMs);
    const handle = armTimedExpiry(remainingMs);
    state = { ...state, expiresAt, cancelExpiry: handle.cancel };
    broadcastSessionUpdate();
  };

  const cleanup = (): void => {
    clearTimedExpiry();
    state = { kind: "idle" };
  };

  return {
    startSession,
    extendSession,
    cancelSession,
    getStatus,
    cleanup,
    reconcileSessionState,
    broadcastSessionUpdate,
    reconcileAfterResume,
    get sessionActive(): boolean {
      return state.kind !== "idle";
    },
  };
}
