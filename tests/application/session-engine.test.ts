import { describe, it, expect, vi, beforeEach } from "vitest";
import { asPerf } from "../../src/domain/time/perf-timestamp.js";
import { createSessionEngine } from "../../src/application/session/session-engine.js";
import type { ClockPort } from "../../src/application/ports/clock.port.js";
import type { SchedulePort } from "../../src/application/ports/schedule.port.js";
import type { LoggerPort } from "../../src/application/ports/logger.port.js";
import type { MainToRendererNotifierPort } from "../../src/application/ports/main-to-renderer-notifier.port.js";

type Scheduled = { ms: number; cb: () => void; cancelled: boolean };

function createFakeSchedule(): SchedulePort & {
  entries: Scheduled[];
  runNext: () => void;
  runAll: () => void;
} {
  const entries: Scheduled[] = [];
  return {
    entries,
    schedule(ms: number, cb: () => void): { cancel: () => void } {
      const entry: Scheduled = { ms, cb, cancelled: false };
      entries.push(entry);
      return {
        cancel: () => {
          entry.cancelled = true;
        },
      };
    },
    runNext(): void {
      const next = entries.find((e) => !e.cancelled);
      if (next === undefined) return;
      next.cancelled = true;
      next.cb();
    },
    runAll(): void {
      for (const e of [...entries]) {
        if (!e.cancelled) {
          e.cancelled = true;
          e.cb();
        }
      }
    },
  };
}

function createFakeClock(initialPerf = 1000, initialWall = 1_000_000): ClockPort & {
  perf: number;
  wall: number;
  advance: (ms: number) => void;
} {
  const clock = {
    perf: initialPerf,
    wall: initialWall,
    perfNow: () => asPerf(clock.perf),
    wallNow: () => clock.wall,
    advance(ms: number): void {
      clock.perf += ms;
      clock.wall += ms;
    },
  };
  return clock;
}

function createSilentLogger(): LoggerPort {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("createSessionEngine", () => {
  let schedule: ReturnType<typeof createFakeSchedule>;
  let clock: ReturnType<typeof createFakeClock>;
  let publish: ReturnType<typeof vi.fn>;
  let notifier: MainToRendererNotifierPort;
  let onActive: (active: boolean) => void;
  let onActiveMock: ReturnType<typeof vi.fn<(active: boolean) => void>>;

  beforeEach(() => {
    schedule = createFakeSchedule();
    clock = createFakeClock();
    publish = vi.fn();
    notifier = { publish: publish as MainToRendererNotifierPort["publish"] };
    onActiveMock = vi.fn<(active: boolean) => void>();
    onActive = (active) => {
      onActiveMock(active);
    };
  });

  function build() {
    return createSessionEngine({
      clock,
      schedule,
      notifier,
      logger: createSilentLogger(),
      onSessionActiveChange: onActive,
    });
  }

  it("starts an indefinite session without scheduling", () => {
    const engine = build();
    const snap = engine.startSession(null);

    expect(snap.isRunning).toBe(true);
    expect(snap.durationMinutes).toBeNull();
    expect(snap.expiresAt).toBeNull();
    expect(schedule.entries).toHaveLength(0);
    expect(onActiveMock).toHaveBeenCalledWith(true);
    expect(publish).toHaveBeenCalledWith({
      type: "session-status",
      status: expect.objectContaining({ isRunning: true, durationMinutes: null }),
    });
  });

  it("starts a timed session and schedules expiry via SchedulePort", () => {
    const engine = build();
    const snap = engine.startSession(30);

    expect(snap.isRunning).toBe(true);
    expect(snap.durationMinutes).toBe(30);
    expect(schedule.entries).toHaveLength(1);
    expect(schedule.entries[0]!.ms).toBe(30 * 60_000);
    expect(engine.sessionActive).toBe(true);
  });

  it("fires expiry through fake schedule without real timers", () => {
    const engine = build();
    engine.startSession(1);
    onActiveMock.mockClear();
    publish.mockClear();

    schedule.runNext();

    expect(engine.sessionActive).toBe(false);
    expect(onActiveMock).toHaveBeenCalledWith(false);
    expect(publish).toHaveBeenCalledWith({
      type: "session-status",
      status: expect.objectContaining({ isRunning: false }),
    });
  });

  it("cancel clears scheduled expiry and deactivates", () => {
    const engine = build();
    engine.startSession(15);
    expect(schedule.entries[0]!.cancelled).toBe(false);

    const snap = engine.cancelSession();

    expect(snap.isRunning).toBe(false);
    expect(schedule.entries[0]!.cancelled).toBe(true);
    expect(engine.sessionActive).toBe(false);
    expect(onActiveMock).toHaveBeenLastCalledWith(false);
  });

  it("cleanup cancels outstanding schedule handles", () => {
    const engine = build();
    engine.startSession(10);
    engine.cleanup();
    expect(schedule.entries[0]!.cancelled).toBe(true);
    expect(engine.sessionActive).toBe(false);
  });

  it("replacing a session cancels the previous schedule", () => {
    const engine = build();
    engine.startSession(30);
    const first = schedule.entries[0]!;
    engine.startSession(null);
    expect(first.cancelled).toBe(true);
    expect(schedule.entries.filter((e) => !e.cancelled)).toHaveLength(0);
  });

  it("reconcileAfterResume reschedules remaining wall-clock time", () => {
    const engine = build();
    engine.startSession(30);
    const first = schedule.entries[0]!;
    // Sleep for 10 minutes of wall time
    clock.advance(10 * 60_000);
    publish.mockClear();

    engine.reconcileAfterResume();

    expect(first.cancelled).toBe(true);
    const live = schedule.entries.filter((e) => !e.cancelled);
    expect(live).toHaveLength(1);
    expect(live[0]!.ms).toBe(20 * 60_000);
    expect(publish).toHaveBeenCalled();
  });

  it("reconcileAfterResume fires expiry when wall clock is past end", () => {
    const engine = build();
    engine.startSession(30);
    clock.advance(31 * 60_000);
    onActiveMock.mockClear();

    engine.reconcileAfterResume();

    expect(engine.sessionActive).toBe(false);
    expect(onActiveMock).toHaveBeenCalledWith(false);
  });

  it("reconcileAfterResume realigns remainingSeconds when wall advances more than perf", () => {
    const engine = build();
    engine.startSession(30);
    // Only wall advances (simulates sleep skew where perf stalled).
    clock.wall += 10 * 60_000;
    engine.reconcileAfterResume();
    const status = engine.getStatus();
    expect(status.isRunning).toBe(true);
    if (status.isRunning) {
      expect(status.remainingSeconds).toBe(20 * 60);
    }
  });

  it("getStatus remainingSeconds uses wall clock for timed sessions", () => {
    const engine = build();
    engine.startSession(1);
    clock.advance(15_000);
    const status = engine.getStatus();
    expect(status.isRunning).toBe(true);
    if (status.isRunning && status.expiresAt !== null) {
      expect(status.remainingSeconds).toBe(45);
    }
  });

  it("extends the existing wall deadline repeatedly and realigns the performance clock", () => {
    const engine = build();
    const original = engine.startSession(30);
    clock.wall += 10 * 60_000;
    clock.perf += 2 * 60_000;
    onActiveMock.mockClear();
    publish.mockClear();

    const first = engine.extendSession(15);
    const second = engine.extendSession(5);

    expect(first).toEqual({
      ok: true,
      status: {
        isRunning: true,
        startedAt: original.startedAt,
        expiresAt: asPerf(clock.perf + 35 * 60_000),
        remainingSeconds: 35 * 60,
        durationMinutes: 45,
      },
    });
    expect(second).toEqual({
      ok: true,
      status: {
        isRunning: true,
        startedAt: original.startedAt,
        expiresAt: asPerf(clock.perf + 40 * 60_000),
        remainingSeconds: 40 * 60,
        durationMinutes: 50,
      },
    });
    expect(schedule.entries.map((entry) => [entry.ms, entry.cancelled])).toEqual([
      [30 * 60_000, true],
      [35 * 60_000, true],
      [40 * 60_000, false],
    ]);
    expect(onActiveMock).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("accepts exactly the cumulative cap and rejects the next minute without mutation", () => {
    const engine = build();
    engine.startSession(1430);
    expect(engine.extendSession(10)).toMatchObject({
      ok: true,
      status: { durationMinutes: 1440 },
    });
    const before = engine.getStatus();
    const entries = schedule.entries.map((entry) => ({ ...entry }));
    publish.mockClear();
    onActiveMock.mockClear();

    expect(engine.extendSession(1)).toEqual({ ok: false, reason: "duration-limit" });
    expect(engine.getStatus()).toEqual(before);
    expect(schedule.entries).toEqual(entries);
    expect(publish).not.toHaveBeenCalled();
    expect(onActiveMock).not.toHaveBeenCalled();
  });

  it("uses wall remaining when the performance clock advances faster", () => {
    const engine = build();
    const original = engine.startSession(20);
    clock.perf += 25 * 60_000;
    clock.wall += 5 * 60_000;

    const result = engine.extendSession(5);

    expect(result).toMatchObject({
      ok: true,
      status: {
        startedAt: original.startedAt,
        expiresAt: asPerf(clock.perf + 20 * 60_000),
        remainingSeconds: 1200,
      },
    });
    expect(schedule.entries[1]?.ms).toBe(20 * 60_000);
  });

  it("ignores a queued expiry after resume expires the session", () => {
    const engine = build();
    engine.startSession(1);
    const stale = schedule.entries[0];
    expect(stale).toBeDefined();
    clock.wall += 60_000;
    engine.reconcileAfterResume();
    publish.mockClear();
    onActiveMock.mockClear();

    stale?.cb();

    expect(engine.sessionActive).toBe(false);
    expect(publish).not.toHaveBeenCalled();
    expect(onActiveMock).not.toHaveBeenCalled();
  });

  it.each([0, -1, 0.5, NaN, Infinity, -Infinity])(
    "rejects invalid extension %s without changing an active schedule",
    (minutes) => {
      const engine = build();
      engine.startSession(30);
      const before = engine.getStatus();
      const entries = schedule.entries.map((entry) => ({ ...entry }));
      publish.mockClear();
      onActiveMock.mockClear();

      expect(engine.extendSession(minutes)).toEqual({
        ok: false,
        reason: "invalid-additional-minutes",
      });
      expect(engine.getStatus()).toEqual(before);
      expect(schedule.entries).toEqual(entries);
      expect(publish).not.toHaveBeenCalled();
      expect(onActiveMock).not.toHaveBeenCalled();
    },
  );

  it.each(["idle", "indefinite", "expired"] as const)(
    "rejects %s sessions without mutation",
    (condition) => {
      const engine = build();
      if (condition === "indefinite") engine.startSession(null);
      if (condition === "expired") {
        engine.startSession(1);
        clock.wall += 60_000;
      }
      const before = engine.getStatus();
      const entries = schedule.entries.map((entry) => ({ ...entry }));
      publish.mockClear();
      onActiveMock.mockClear();

      expect(engine.extendSession(1)).toEqual({ ok: false, reason: condition });
      expect(engine.getStatus()).toEqual(before);
      expect(schedule.entries).toEqual(entries);
      expect(publish).not.toHaveBeenCalled();
      expect(onActiveMock).not.toHaveBeenCalled();
    },
  );

  it.each(["extend", "resume", "restart", "indefinite", "cancel", "cleanup"] as const)(
    "ignores an already queued expiry after %s",
    (operation) => {
      const engine = build();
      engine.startSession(30);
      const stale = schedule.entries[0];
      expect(stale).toBeDefined();
      if (operation === "extend") engine.extendSession(15);
      if (operation === "resume") engine.reconcileAfterResume();
      if (operation === "restart") engine.startSession(10);
      if (operation === "indefinite") engine.startSession(null);
      if (operation === "cancel") engine.cancelSession();
      if (operation === "cleanup") engine.cleanup();
      const before = engine.getStatus();
      publish.mockClear();
      onActiveMock.mockClear();

      stale?.cb();

      expect(engine.getStatus()).toEqual(before);
      expect(publish).not.toHaveBeenCalled();
      expect(onActiveMock).not.toHaveBeenCalled();
      if (operation === "extend" || operation === "resume" || operation === "restart") {
        schedule.runNext();
        expect(engine.sessionActive).toBe(false);
        expect(onActiveMock).toHaveBeenCalledOnce();
      }
    },
  );

  it("throws when broadcast notifier is missing", () => {
    expect(() =>
      createSessionEngine({
        clock,
        schedule,
        // @ts-expect-error intentional missing publish
        notifier: {},
        logger: createSilentLogger(),
      }),
    ).toThrow(/notifier/);
  });
});
