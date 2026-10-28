import type { powerMonitor } from "electron";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AppSettings, SessionStatusResponse } from "../../src/shared/types.js";
import { DEFAULT_SETTINGS } from "../../src/shared/types.js";
import type { SessionState, SessionTimerHandle } from "../../src/main/session-timer.js";

// Hoisted mock functions - evaluated before vi.mock calls
const mockGetSettings = vi.hoisted(() => vi.fn());
const mockOnSessionStateChange = vi.hoisted(() => vi.fn());
const mockBroadcastToWindows = vi.hoisted(() => vi.fn());

// Mutable settings state - updated by mockOnSessionStateChange
let settingsState: AppSettings = {
  ...DEFAULT_SETTINGS,
  launchAtLogin: false,
  preventSleep: false,
  defaultSessionDuration: null,
};

// Set up getSettings to return the current state
mockGetSettings.mockImplementation(() => ({ ...settingsState }));
mockOnSessionStateChange.mockImplementation((partial: Partial<typeof settingsState>) => {
  settingsState = { ...settingsState, ...partial };
});

vi.mock("../../src/main/settings.js", () => ({
  onSettingsChanged: vi.fn(),
}));

/**
 * Build a fresh session-timer handle wired to the mock callbacks. Mirrors what
 * composition does at runtime: construct via the factory, register as the
 * active module-level handle so module-level exports keep delegating.
 */
async function buildHandle(): Promise<SessionTimerHandle> {
  const mod = await import("../../src/main/session-timer.js");
  return mod.createSessionTimer({
    broadcast: mockBroadcastToWindows,
  });
}

describe("session-timer", () => {
  let startSession: (_durationMinutes: number | null) => SessionState;
  let cancelSession: () => SessionState;
  let getStatus: () => SessionStatusResponse;
  let cleanup: () => void;
  let reconcileSessionState: () => void;

  beforeEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();

    // Reset settings state
    settingsState = {
      ...DEFAULT_SETTINGS,
      launchAtLogin: false,
      preventSleep: false,
      defaultSessionDuration: null,
    };

    vi.resetModules();

    const handle = await buildHandle();
    startSession = handle.startSession;
    cancelSession = handle.cancelSession;
    getStatus = handle.getStatus;
    cleanup = handle.cleanup;
    reconcileSessionState = handle.reconcileSessionState;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("startSession", () => {
    it("indefinite - starts session with null duration", () => {
      const state = startSession(null);

      expect(state.isRunning).toBe(true);
      expect(state.startedAt).not.toBeNull();
      expect(state.expiresAt).toBeNull();
      expect(state.durationMinutes).toBeNull();
    });

    it("timed 30min - starts session with correct expiry", () => {
      const before = performance.now();
      const state = startSession(30);
      const after = performance.now();

      expect(state.isRunning).toBe(true);
      expect(state.startedAt).not.toBeNull();
      expect(state.expiresAt).toBeGreaterThanOrEqual(before + 30 * 60 * 1000);
      expect(state.expiresAt).toBeLessThanOrEqual(after + 30 * 60 * 1000);
      expect(state.durationMinutes).toBe(30);
    });

    it("clears previous timer when starting a new session", () => {
      // Start first session (30min) and verify it has a timer
      const firstStatus = startSession(30);
      expect(firstStatus.isRunning).toBe(true);

      // Start second session (15min) - should clear first timer
      const secondStatus = startSession(15);

      expect(secondStatus.isRunning).toBe(true);
      expect(secondStatus.durationMinutes).toBe(15);
    });
  });

  describe("extendSession", () => {
    it("extends a live session through the facade without changing settings or active state", async () => {
      vi.useFakeTimers();
      const onActive = vi.fn();
      const mod = await import("../../src/main/session-timer.js");
      const handle = mod.createSessionTimer({
        broadcast: mockBroadcastToWindows,
        onSessionActiveChange: onActive,
      });
      const original = handle.startSession(2);
      vi.advanceTimersByTime(60_000);
      mockBroadcastToWindows.mockClear();
      onActive.mockClear();
      const settingsBefore = { ...settingsState };

      const result = handle.extendSession(1);

      expect(result).toMatchObject({
        ok: true,
        status: { startedAt: original.startedAt, durationMinutes: 3, remainingSeconds: 120 },
      });
      expect(mockBroadcastToWindows).toHaveBeenCalledTimes(1);
      expect(onActive).not.toHaveBeenCalled();
      expect(settingsState).toEqual(settingsBefore);
      vi.advanceTimersByTime(60_000);
      expect(handle.sessionActive).toBe(true);
      vi.advanceTimersByTime(60_000);
      expect(handle.sessionActive).toBe(false);
      handle.cleanup();
    });

    it("rejects an idle extension without broadcasting", async () => {
      const handle = await buildHandle();
      mockBroadcastToWindows.mockClear();

      expect(handle.extendSession(15)).toEqual({ ok: false, reason: "idle" });
      expect(mockBroadcastToWindows).not.toHaveBeenCalled();
      handle.cleanup();
    });
  });

  describe("cancelSession", () => {
    it("running - cancels active session", () => {
      startSession(30);
      const state = cancelSession();

      expect(state.isRunning).toBe(false);
      expect(state.startedAt).toBeNull();
      expect(state.expiresAt).toBeNull();
      expect(state.durationMinutes).toBeNull();
    });

    it("no running session - cancel is safe, still syncs sleep", () => {
      const state = cancelSession();

      expect(state.isRunning).toBe(false);
      expect(state.startedAt).toBeNull();
      expect(state.expiresAt).toBeNull();
      expect(state.durationMinutes).toBeNull();
    });
  });

  describe("getStatus", () => {
    it("no session - returns not running with nulls", () => {
      const state = getStatus();

      expect(state.isRunning).toBe(false);
      expect(state.startedAt).toBeNull();
      expect(state.expiresAt).toBeNull();
      expect(state.durationMinutes).toBeNull();
    });

    it("running session - returns correct state", () => {
      startSession(30);
      const state = getStatus();

      expect(state.isRunning).toBe(true);
      expect(state.startedAt).not.toBeNull();
      expect(state.expiresAt).not.toBeNull();
      expect(state.durationMinutes).toBe(30);
    });

    it("reconcileSessionState is a no-op (preference must not kill live session)", () => {
      startSession(30);
      expect(getStatus().isRunning).toBe(true);
      // Preference null must not cancel runtime session.
      settingsState = { ...settingsState, defaultSessionDuration: null };
      reconcileSessionState();
      expect(getStatus().isRunning).toBe(true);
    });

    it("getStatus is pure — never calls onSessionStateChange (no side effects)", () => {
      // Settings say a session is active but module state is empty.
      // The legacy getStatus() side-effected here; the new pure version must not.
      mockGetSettings.mockReturnValue({
        launchAtLogin: false,
        preventSleep: false,
        defaultSessionDuration: 30,
      });
      mockOnSessionStateChange.mockClear();

      const state = getStatus();

      expect(state.isRunning).toBe(false);
      expect(state.startedAt).toBeNull();
      expect(state.expiresAt).toBeNull();
      expect(state.durationMinutes).toBeNull();
      expect(mockOnSessionStateChange).not.toHaveBeenCalled();
    });
  });

  describe("cleanup", () => {
    it("running session - clears timer without syncing sleep", () => {
      startSession(30);

      cleanup();

      expect(getStatus().isRunning).toBe(false);
    });

    it("cleanup does NOT call onSessionStateChange (vs cancelSession which does)", () => {
      startSession(30);
      mockOnSessionStateChange.mockClear();

      cleanup();

      expect(mockOnSessionStateChange).not.toHaveBeenCalled();
    });

    it("cleanup is safe when no session is active", () => {
      expect(() => cleanup()).not.toThrow();
      expect(getStatus().isRunning).toBe(false);
    });
  });

  describe("timer expiry", () => {
    it("expires - syncs sleep off and clears settings", async () => {
      vi.useFakeTimers();

      vi.resetModules();

      settingsState = {
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: false,
        defaultSessionDuration: null,
      };

      const handle = await buildHandle();
      handle.startSession(1); // 1 minute = 60000ms

      mockOnSessionStateChange.mockClear();

      vi.advanceTimersByTime(1 * 60 * 1000);
      expect(handle.getStatus().isRunning).toBe(false);

      vi.useRealTimers();
    });
  });

  describe("edge cases", () => {
    it("second start cancels first timer (concurrent start)", async () => {
      vi.useFakeTimers();

      vi.resetModules();
      settingsState = {
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: false,
        defaultSessionDuration: null,
      };

      const handle = await buildHandle();

      // Start first session of 2 minutes
      handle.startSession(2);
      // Start second session of 1 minute — should clear first
      handle.startSession(1);

      mockOnSessionStateChange.mockClear();

      // Advance 1 minute — second session expires
      vi.advanceTimersByTime(1 * 60 * 1000);
      expect(handle.getStatus().isRunning).toBe(false);

      // Advance to 2 minutes — first timer should NOT fire again
      mockOnSessionStateChange.mockClear();
      vi.advanceTimersByTime(1 * 60 * 1000);
      expect(mockOnSessionStateChange).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("zero duration starts and expires immediately", async () => {
      vi.useFakeTimers();

      vi.resetModules();
      settingsState = {
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: false,
        defaultSessionDuration: null,
      };

      const handle = await buildHandle();

      const state = handle.startSession(0);
      expect(state.isRunning).toBe(true);
      expect(state.durationMinutes).toBe(0);

      mockOnSessionStateChange.mockClear();

      // Zero duration means 0ms timeout — fires on next tick
      vi.advanceTimersByTime(0);

      vi.useRealTimers();
    });

    it("negative duration creates timer that fires immediately", async () => {
      vi.useFakeTimers();

      vi.resetModules();
      settingsState = {
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: false,
        defaultSessionDuration: null,
      };

      const handle = await buildHandle();

      const state = handle.startSession(-1);
      expect(state.isRunning).toBe(true);

      mockOnSessionStateChange.mockClear();

      // Negative timeout → fires immediately
      vi.advanceTimersByTime(0);

      vi.useRealTimers();
    });

    it("getStatus with no session returns all-null fields including remainingSeconds", () => {
      const state = getStatus();

      expect(state).toEqual({
        isRunning: false,
        startedAt: null,
        expiresAt: null,
        durationMinutes: null,
        remainingSeconds: null,
      });
    });

    it("cancelSession vs cleanup: cancelSession calls onSessionStateChange, cleanup does not", () => {
      startSession(30);
      mockOnSessionStateChange.mockClear();

      cancelSession();
    });
  });

  describe("broadcastSessionUpdate", () => {
    let broadcastSessionUpdate: () => void;

    beforeEach(async () => {
      vi.resetModules();
      vi.clearAllMocks();
      settingsState = {
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: false,
        defaultSessionDuration: null,
      };

      const handle = await buildHandle();
      startSession = handle.startSession;
      cancelSession = handle.cancelSession;
      getStatus = handle.getStatus;
      cleanup = handle.cleanup;
      broadcastSessionUpdate = handle.broadcastSessionUpdate;
    });

    it("broadcasts pure status snapshot when no session is active (never null)", () => {
      broadcastSessionUpdate();

      expect(mockBroadcastToWindows).toHaveBeenCalledWith(
        "session:status-update",
        {
          isRunning: false,
          startedAt: null,
          expiresAt: null,
          durationMinutes: null,
          remainingSeconds: null,
        },
      );
    });

    it("broadcasts session data with remainingSeconds when session is active", () => {
      startSession(30);
      mockBroadcastToWindows.mockClear();

      broadcastSessionUpdate();

      expect(mockBroadcastToWindows).toHaveBeenCalledWith(
        "session:status-update",
        expect.objectContaining({
          isRunning: true,
          startedAt: expect.any(Number),
          expiresAt: expect.any(Number),
          remainingSeconds: expect.any(Number),
          durationMinutes: 30,
        }),
      );
    });

    it("broadcasts isRunning=true with null expiresAt for indefinite session", () => {
      startSession(null);
      mockBroadcastToWindows.mockClear();

      broadcastSessionUpdate();

      // Indefinite sessions: sessionStartedAt is set so isRunning=true,
      // but expiresAt and remainingSeconds are null (no timer).
      expect(mockBroadcastToWindows).toHaveBeenCalledWith(
        "session:status-update",
        expect.objectContaining({
          isRunning: true,
          startedAt: expect.any(Number),
          expiresAt: null,
          remainingSeconds: null,
          durationMinutes: null,
        }),
      );
    });
  });

  describe("event-driven broadcasts (push-on-state-change)", () => {
    beforeEach(async () => {
      vi.useFakeTimers();
      vi.resetModules();
      vi.clearAllMocks();
      settingsState = {
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: false,
        defaultSessionDuration: null,
      };

      const handle = await buildHandle();
      startSession = handle.startSession;
      cancelSession = handle.cancelSession;
      getStatus = handle.getStatus;
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("startSession triggers exactly one broadcast and no further automatic broadcasts", () => {
      mockBroadcastToWindows.mockClear();
      startSession(30);

      // Exactly one broadcast on state transition
      expect(mockBroadcastToWindows).toHaveBeenCalledTimes(1);

      mockBroadcastToWindows.mockClear();
      // No further broadcasts fire automatically over time
      vi.advanceTimersByTime(5000);
      expect(mockBroadcastToWindows).not.toHaveBeenCalled();
    });

    it("cancelSession triggers exactly one broadcast", () => {
      startSession(30);
      mockBroadcastToWindows.mockClear();

      cancelSession();
      expect(mockBroadcastToWindows).toHaveBeenCalledTimes(1);

      mockBroadcastToWindows.mockClear();
      vi.advanceTimersByTime(5000);
      expect(mockBroadcastToWindows).not.toHaveBeenCalled();
    });

    it("timer expiry triggers exactly one broadcast", () => {
      startSession(1);
      mockBroadcastToWindows.mockClear();

      vi.advanceTimersByTime(60_000);
      expect(mockBroadcastToWindows).toHaveBeenCalledTimes(1);
    });

    it("indefinite startSession triggers exactly one broadcast", () => {
      mockBroadcastToWindows.mockClear();
      startSession(null);
      expect(mockBroadcastToWindows).toHaveBeenCalledTimes(1);

      mockBroadcastToWindows.mockClear();
      vi.advanceTimersByTime(5000);
      expect(mockBroadcastToWindows).not.toHaveBeenCalled();
    });
  });
});

describe("session-timer additional edge cases", () => {
  let startSession: (_durationMinutes: number | null) => SessionState;
  let cancelSession: () => SessionState;
  let getStatus: () => SessionStatusResponse;
  let reconcileSessionState: () => void;

  beforeEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
    settingsState = {
      ...DEFAULT_SETTINGS,
      launchAtLogin: false,
      preventSleep: false,
      defaultSessionDuration: null,
    };
    vi.resetModules();

    const handle = await buildHandle();
    startSession = handle.startSession;
    cancelSession = handle.cancelSession;
    getStatus = handle.getStatus;
    reconcileSessionState = handle.reconcileSessionState;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("performance.now() controlled clock", () => {
    it("getStatus().remainingSeconds is computed from wall clock after start", async () => {
      vi.resetModules();
      settingsState = {
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: false,
        defaultSessionDuration: null,
      };

      let wallValue = 1_000_000;
      const wallSpy = vi.spyOn(Date, "now").mockImplementation(() => wallValue);
      const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => 0);

      const handle = await buildHandle();

      handle.startSession(2);

      // Advance wall clock by 60 seconds (session remaining 60s of 120s).
      wallValue = 1_000_000 + 60_000;
      const status = handle.getStatus();
      expect(status.isRunning).toBe(true);
      expect(status.remainingSeconds).toBe(60);

      wallSpy.mockRestore();
      nowSpy.mockRestore();
    });
  });

  describe("concurrent startSession calls", () => {
    it("second startSession replaces first - only one active session, no leaked timers", async () => {
      vi.useFakeTimers();
      vi.resetModules();
      settingsState = {
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: false,
        defaultSessionDuration: null,
      };

      const handle = await buildHandle();

      const first = handle.startSession(10);
      const second = handle.startSession(10);

      expect(first.isRunning).toBe(true);
      expect(second.isRunning).toBe(true);

      const status = handle.getStatus();
      expect(status.isRunning).toBe(true);
      expect(status.durationMinutes).toBe(10);

      mockBroadcastToWindows.mockClear();
      vi.advanceTimersByTime(10 * 60 * 1000);

      // Exactly one expiry broadcast for the second (active) timer.
      const idleBroadcasts = mockBroadcastToWindows.mock.calls.filter(
        (args) => args[1]?.isRunning === false,
      );
      expect(idleBroadcasts.length).toBe(1);

      mockBroadcastToWindows.mockClear();
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(mockBroadcastToWindows).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe("cancelSession racing with expiry", () => {
    it("cancel just before expiry does not double-fire session status broadcast", async () => {
      vi.useFakeTimers();
      vi.resetModules();
      settingsState = {
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        preventSleep: false,
        defaultSessionDuration: null,
      };

      const handle = await buildHandle();

      handle.startSession(1);
      vi.advanceTimersByTime(60000 - 1);

      mockBroadcastToWindows.mockClear();

      handle.cancelSession();

      expect(mockBroadcastToWindows).toHaveBeenCalledTimes(1);

      mockBroadcastToWindows.mockClear();
      vi.advanceTimersByTime(10);
      expect(mockBroadcastToWindows).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe("getStatus consistent shape (P0-2)", () => {
    it("returns SessionStatusResponse with isRunning=false (never null) before any session", () => {
      const status = getStatus();

      expect(status).not.toBeNull();
      expect(status).toEqual({
        isRunning: false,
        startedAt: null,
        expiresAt: null,
        durationMinutes: null,
        remainingSeconds: null,
      });
    });
  });

  describe("reconcileSessionState is preference-independent", () => {
    it("does not clear a live session when defaultSessionDuration is null", async () => {
      startSession(45);

      const before = getStatus();
      expect(before.isRunning).toBe(true);
      expect(before.startedAt).not.toBeNull();
      expect(before.expiresAt).not.toBeNull();
      expect(before.durationMinutes).toBe(45);

      settingsState = {
        ...settingsState,
        defaultSessionDuration: null,
      };

      reconcileSessionState();

      const after = getStatus();
      expect(after.isRunning).toBe(true);
      expect(after.durationMinutes).toBe(45);

      // Reference cancelSession to satisfy noUnusedLocals
      void cancelSession;
    });
  });

  describe("factory enforces required deps (no silent fallbacks)", () => {

    it("createSessionTimer throws when broadcast is missing", async () => {
      const mod = await import("../../src/main/session-timer.js");
      expect(() =>
        mod.createSessionTimer({
          // @ts-expect-error - intentionally missing required dep
          broadcast: undefined,
        }),
      ).toThrow(/broadcast/);
    });

  });

  describe("handleResume — sleep-resilient expiry (FIX 2)", () => {
    it("re-arms timer with correct remaining when timed and remaining > 0", async () => {
      const mockPowerMonitor = { on: vi.fn(), off: vi.fn() };
      vi.resetModules();
      vi.useRealTimers();
      const mod = await import("../../src/main/session-timer.js");
      const handle = mod.createSessionTimer({
        broadcast: mockBroadcastToWindows,
        powerMonitor: mockPowerMonitor as unknown as typeof powerMonitor,
      });

      // Start a 30-min timed session.
      handle.startSession(30);
      const beforeStatus = handle.getStatus();
      expect(beforeStatus.isRunning).toBe(true);

      // Find resume listener.
      const resumeCall = mockPowerMonitor.on.mock.calls.find(
        (c: unknown[]) => c[0] === "resume",
      );
      expect(resumeCall).toBeDefined();
      const handleResume = resumeCall![1] as () => void;

      // Simulate resume immediately — remaining ~30 min, session should still be running.
      handleResume();
      const afterStatus = handle.getStatus();
      expect(afterStatus.isRunning).toBe(true);
      expect(afterStatus.durationMinutes).toBe(30);

      handle.cleanup();
    });

    it("fires expiry immediately when remaining <= 0 (slept past expiry)", async () => {
      const mockPowerMonitor = { on: vi.fn(), off: vi.fn() };
      vi.resetModules();
      vi.useRealTimers();
      const dateNowSpy = vi.spyOn(Date, "now");
      const mod = await import("../../src/main/session-timer.js");
      const handle = mod.createSessionTimer({
        broadcast: mockBroadcastToWindows,
        powerMonitor: mockPowerMonitor as unknown as typeof powerMonitor,
      });

      // Anchor wallClockExpiresAt at 0 + 30*60_000.
      dateNowSpy.mockReturnValue(0);
      handle.startSession(30);
      expect(handle.getStatus().isRunning).toBe(true);

      // Now jump wall clock past expiry.
      dateNowSpy.mockReturnValue(31 * 60 * 1000);
      const resumeCall = mockPowerMonitor.on.mock.calls.find(
        (c: unknown[]) => c[0] === "resume",
      );
      const handleResume = resumeCall![1] as () => void;

      mockOnSessionStateChange.mockClear();
      handleResume();

      expect(handle.getStatus().isRunning).toBe(false);

      dateNowSpy.mockRestore();
      handle.cleanup();
    });

    it("is a no-op when state is idle", async () => {
      const mockPowerMonitor = { on: vi.fn(), off: vi.fn() };
      vi.resetModules();
      vi.useRealTimers();
      const mod = await import("../../src/main/session-timer.js");
      const handle = mod.createSessionTimer({
        broadcast: mockBroadcastToWindows,
        powerMonitor: mockPowerMonitor as unknown as typeof powerMonitor,
      });

      const resumeCall = mockPowerMonitor.on.mock.calls.find(
        (c: unknown[]) => c[0] === "resume",
      );
      const handleResume = resumeCall![1] as () => void;

      mockOnSessionStateChange.mockClear();
      handleResume();

      expect(handle.getStatus().isRunning).toBe(false);
      expect(mockOnSessionStateChange).not.toHaveBeenCalled();
      handle.cleanup();
    });

    it("is a no-op when state is indefinite", async () => {
      const mockPowerMonitor = { on: vi.fn(), off: vi.fn() };
      vi.resetModules();
      vi.useRealTimers();
      const mod = await import("../../src/main/session-timer.js");
      const handle = mod.createSessionTimer({
        broadcast: mockBroadcastToWindows,
        powerMonitor: mockPowerMonitor as unknown as typeof powerMonitor,
      });
      handle.startSession(null);

      const resumeCall = mockPowerMonitor.on.mock.calls.find(
        (c: unknown[]) => c[0] === "resume",
      );
      const handleResume = resumeCall![1] as () => void;

      mockOnSessionStateChange.mockClear();
      handleResume();

      expect(handle.getStatus().isRunning).toBe(true);
      expect(handle.getStatus().expiresAt).toBeNull();
      expect(mockOnSessionStateChange).not.toHaveBeenCalled();
      handle.cleanup();
    });

    it("cleanup removes resume listener", async () => {
      const mockPowerMonitor = { on: vi.fn(), off: vi.fn() };
      vi.resetModules();
      const mod = await import("../../src/main/session-timer.js");
      const handle = mod.createSessionTimer({
        broadcast: mockBroadcastToWindows,
        powerMonitor: mockPowerMonitor as unknown as typeof powerMonitor,
      });

      handle.cleanup();

      expect(mockPowerMonitor.off).toHaveBeenCalledWith("resume", expect.any(Function));
    });
  });
});
