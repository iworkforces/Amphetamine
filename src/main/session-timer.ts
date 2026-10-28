import type { powerMonitor as PowerMonitorType } from "electron/main";
import type {
  IpcResponse,
  PushChannel,
  SessionExtendResponse,
  SessionStatusResponse,
} from "../shared/types.js";
import {
  createSessionEngine,
  type SessionEngine,
  type SessionSnapshot,
} from "../application/session/session-engine.js";
import { createSystemClock } from "../infrastructure/clock/system-clock.js";
import { createNodeSchedule } from "../infrastructure/schedule/node-schedule.js";
import { createElectronLogger } from "../infrastructure/logging/electron-logger.js";
import { createBroadcastNotifier } from "../infrastructure/notification/broadcast-notifier.js";

/** Public snapshot alias (start/cancel return shape). */
export type SessionState = SessionSnapshot;

/**
 * Dependencies for the session timer façade.
 */
export interface SessionTimerDeps {
  broadcast: <K extends PushChannel>(channel: K, data: IpcResponse<K>) => void;
  onSessionActiveChange?: (active: boolean) => void;
  powerMonitor?: typeof PowerMonitorType;
}

/**
 * Public handle returned by `createSessionTimer`.
 */
export interface SessionTimerHandle {
  startSession: (durationMinutes: number | null) => SessionState;
  extendSession: (additionalMinutes: number) => SessionExtendResponse;
  cancelSession: () => SessionState;
  getStatus: () => SessionStatusResponse;
  cleanup: () => void;
  reconcileSessionState: () => void;
  broadcastSessionUpdate: () => void;
  readonly sessionActive: boolean;
}

/**
 * Create a session timer bound to deps (thin façade over createSessionEngine).
 * Callers must inject the returned handle — there are no module-level delegators.
 */
export function createSessionTimer(deps: SessionTimerDeps): SessionTimerHandle {
  if (typeof deps.broadcast !== "function") {
    throw new TypeError("createSessionTimer: deps.broadcast must be a function");
  }

  const engine: SessionEngine = createSessionEngine({
    clock: createSystemClock(),
    schedule: createNodeSchedule(),
    notifier: createBroadcastNotifier(deps.broadcast),
    logger: createElectronLogger(),
    ...(deps.onSessionActiveChange !== undefined
      ? { onSessionActiveChange: deps.onSessionActiveChange }
      : {}),
  });

  const powerMonitor = deps.powerMonitor;
  const onResume = (): void => {
    engine.reconcileAfterResume();
  };

  if (powerMonitor !== undefined) {
    powerMonitor.on("resume", onResume);
  }

  return {
    startSession: (durationMinutes) => engine.startSession(durationMinutes),
    extendSession: (additionalMinutes) => engine.extendSession(additionalMinutes),
    cancelSession: () => engine.cancelSession(),
    getStatus: () => engine.getStatus(),
    cleanup: () => {
      engine.cleanup();
      if (powerMonitor !== undefined) {
        powerMonitor.off("resume", onResume);
      }
    },
    reconcileSessionState: () => engine.reconcileSessionState(),
    broadcastSessionUpdate: () => engine.broadcastSessionUpdate(),
    get sessionActive(): boolean {
      return engine.sessionActive;
    },
  };
}
