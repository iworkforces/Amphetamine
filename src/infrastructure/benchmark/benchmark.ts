import { app, type BrowserWindow } from "electron/main";
import { createHook, type AsyncHook } from "node:async_hooks";
import {
  isRendererCountdownTimerCounters,
  type RendererCountdownTimerCounters,
} from "../../shared/benchmark-types.js";
import {
  BENCHMARK_ACTIVE_SESSION_MINUTES,
  BENCHMARK_LABEL_ENV_NAME,
  BENCHMARK_USER_DATA_ENV_NAME,
  getBenchmarkScenario,
  isBenchmarkMode,
} from "./benchmark-env.js";
import {
  installBenchmarkReadinessTracking,
  waitForWindowLoad,
  waitForWindowReadyToShow,
} from "./benchmark-readiness.js";
import {
  buildRuntimeInfo,
  isConfirmedActiveSession,
  round,
  summarize,
  summarizeIdle,
  sumCpuPercent,
  sumIdleWakeups,
  type BenchmarkArtifact,
  type BenchmarkContext,
  type BenchmarkTimerCounters,
  type IdleSample,
  type IdleEvidence,
  type LoadResult,
  type MainTimerCounters,
} from "./benchmark-metrics.js";
import { getBatteryBenchmarkCounters } from "../../main/battery-monitor.js";

const RESULT_PREFIX = "AMPHETAMINE_BENCHMARK_RESULT:";
const RENDERER_COUNTER_SCRIPT =
  "globalThis.__AMPHETAMINE_BENCHMARK__?.getRendererCountdownTimerCounters?.() ?? null";
const RESPONSIVENESS_SAMPLE_COUNT = 5;
const IDLE_SAMPLE_COUNT = 6;
const IDLE_SAMPLE_INTERVAL_MS = 250;
const ACTIVE_SESSION_CONFIRM_TIMEOUT_MS = 5000;

type MutableTimerState = {
  timerResourcesCreated: number;
  timerCallbacks: number;
  timerResourcesDestroyed: number;
};

class InvalidRendererBenchmarkCountersError extends Error {
  override readonly name = "InvalidRendererBenchmarkCountersError";

  constructor() {
    super("Renderer benchmark countdown counters are unavailable or invalid.");
  }
}

const timerState: MutableTimerState = {
  timerResourcesCreated: 0,
  timerCallbacks: 0,
  timerResourcesDestroyed: 0,
};
const activeTimerIds = new Set<number>();
let timerHook: AsyncHook | null = null;

export function configureBenchmarkEnvironment(): void {
  if (!isBenchmarkMode()) return;
  const userDataPath = process.env[BENCHMARK_USER_DATA_ENV_NAME];
  if (typeof userDataPath === "string" && userDataPath.length > 0) {
    app.setPath("userData", userDataPath);
  }
}

export function installBenchmarkTimerCounters(): void {
  if (!isBenchmarkMode() || timerHook !== null) return;
  installBenchmarkReadinessTracking();
  timerHook = createHook({
    init(asyncId, type) {
      if (type !== "Timeout") return;
      timerState.timerResourcesCreated += 1;
      activeTimerIds.add(asyncId);
    },
    before(asyncId) {
      if (!activeTimerIds.has(asyncId)) return;
      timerState.timerCallbacks += 1;
    },
    destroy(asyncId) {
      if (!activeTimerIds.delete(asyncId)) return;
      timerState.timerResourcesDestroyed += 1;
    },
  });
  timerHook.enable();
}

export async function runBenchmarkIfRequested(context: BenchmarkContext): Promise<void> {
  if (!isBenchmarkMode()) return;

  const scenario = getBenchmarkScenario();
  const startedAt = new Date().toISOString();
  const startMs = performance.now();
  const popoverWaitStarted = performance.now();
  const popoverDomReady = await waitForWindowLoad(context.mainWindow);
  const popoverDomReadyMs = round(performance.now() - popoverWaitStarted);
  requireLoaded(popoverDomReady);

  let countdownBaseline: RendererCountdownTimerCounters | null = null;
  let idleBefore: IdleEvidence | null = null;
  if (scenario === "active-session") {
    await prepareActiveSessionScenario(context.mainWindow);
    countdownBaseline = await readRendererCountdownTimerCounters(context.mainWindow);
    if (!countdownBaseline.active)
      throw new Error("[benchmark] countdown stopped before sampling.");
  } else idleBefore = await confirmIdleScenario(context.mainWindow);

  const idleSamples = await collectIdleSamples(startMs, context.mainWindow);
  let idleAfter: IdleEvidence | null = null;
  if (scenario === "active-session") {
    if (
      countdownBaseline === null ||
      !idleSamples.every((sample) => {
        const countdown = sample.timerCounters.rendererCountdown;
        return (
          countdown.active &&
          countdown.stops === countdownBaseline.stops &&
          countdown.clears === countdownBaseline.clears
        );
      })
    ) {
      throw new Error("[benchmark] countdown was inactive during sampling.");
    }
    await confirmActiveSession(context.mainWindow);
  } else {
    if (idleSamples.some((sample) => sample.timerCounters.rendererCountdown.active))
      throw new Error("[benchmark] countdown was active during idle sampling.");
    idleAfter = await confirmIdleScenario(context.mainWindow);
  }
  const popoverShowHide = sampleSync(() => {
    context.mainWindow.showInactive();
    context.mainWindow.hide();
  });
  const trayMenuProxy = await sampleTrayMenuProxy();
  const settingsWindowReady = await sampleSettingsWindowReady();
  const rendererCountdownCounters = await readRendererCountdownTimerCounters(context.mainWindow);
  const evidence: BenchmarkArtifact["scenarioMeta"]["evidence"] | null =
    countdownBaseline !== null
      ? {
          kind: "active-session",
          sessionRunning: true,
          countdownActive: true,
          countdownStops: countdownBaseline.stops,
          countdownClears: countdownBaseline.clears,
        }
      : idleBefore !== null && idleAfter !== null
        ? { kind: "idle", before: idleBefore, after: idleAfter }
        : null;
  if (evidence === null) throw new Error("[benchmark] scenario was not confirmed.");

  const artifact: BenchmarkArtifact = {
    schemaVersion: 1,
    label: process.env[BENCHMARK_LABEL_ENV_NAME] ?? "benchmark",
    scenario,
    scenarioMeta: {
      name: scenario,
      sessionDurationMinutes:
        scenario === "active-session" ? BENCHMARK_ACTIVE_SESSION_MINUTES : null,
      evidence,
    },
    readiness: { popover: popoverDomReady, settings: settingsWindowReady },
    timestamps: { startedAt, completedAt: new Date().toISOString() },
    runtime: buildRuntimeInfo(),
    launchReadiness: {
      appReadyMs: round(context.appReadyMs),
      bootstrapReadyMs: round(context.bootstrapReadyMs),
      popoverDomReadyMs,
    },
    responsiveness: {
      popoverShowHide: summarize(popoverShowHide),
      trayMenuProxy: summarize(trayMenuProxy),
      settingsWindowReady: summarize(
        settingsWindowReady.map((result) => round(result.ready.elapsedMs)),
      ),
    },
    idle: {
      sampleIntervalMs: IDLE_SAMPLE_INTERVAL_MS,
      summary: summarizeIdle(idleSamples),
      samples: idleSamples,
    },
    timerCounters: snapshotTimerCounters(rendererCountdownCounters),
  };

  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(artifact)}\n`);
  app.quit();
}

/**
 * Start a timed session via the existing renderer IPC bridge and confirm
 * countdown counters are active before idle sampling begins.
 */
async function prepareActiveSessionScenario(win: BrowserWindow): Promise<void> {
  // Ensure the popover is visible so the renderer countdown ticker arms.
  win.showInactive();
  await sleep(50);

  const startScript = `window.api.session.start(${BENCHMARK_ACTIVE_SESSION_MINUTES})`;
  const startResult: unknown = await win.webContents.executeJavaScript(startScript, true);
  if (
    typeof startResult !== "object" ||
    startResult === null ||
    !("ok" in startResult) ||
    startResult.ok !== true
  ) {
    throw new Error(
      `[benchmark] active-session scenario failed to start session: ${JSON.stringify(startResult)}`,
    );
  }

  const deadline = performance.now() + ACTIVE_SESSION_CONFIRM_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (await isActiveSession(win)) return;
    await sleep(50);
  }
  throw new Error("[benchmark] active-session scenario was not confirmed.");
}

async function isActiveSession(win: BrowserWindow): Promise<boolean> {
  const status: unknown = await win.webContents.executeJavaScript(
    "window.api.session.getStatus()",
    true,
  );
  const counters = await readRendererCountdownTimerCounters(win);
  return isConfirmedActiveSession(status, counters);
}

async function confirmActiveSession(win: BrowserWindow): Promise<void> {
  if (!(await isActiveSession(win)))
    throw new Error("[benchmark] active session ended during sampling.");
}

async function confirmIdleScenario(win: BrowserWindow): Promise<IdleEvidence> {
  const status: unknown = await win.webContents.executeJavaScript(
    "window.api.session.getStatus()",
    true,
  );
  const settings: unknown = await win.webContents.executeJavaScript("window.api.settings.get()", true);
  const counters = await readRendererCountdownTimerCounters(win);
  if (
    typeof status !== "object" ||
    status === null ||
    !("isRunning" in status) ||
    typeof status.isRunning !== "boolean" ||
    typeof settings !== "object" ||
    settings === null ||
    !("preventSleep" in settings) ||
    typeof settings.preventSleep !== "boolean"
  )
    throw new Error("[benchmark] idle scenario state is unavailable.");
  const evidence = {
    sessionRunning: status.isRunning,
    preventSleep: settings.preventSleep,
    countdownActive: counters.active,
  };
  if (evidence.sessionRunning || evidence.preventSleep || evidence.countdownActive)
    throw new Error("[benchmark] idle scenario was not confirmed.");
  return evidence;
}

function requireLoaded(result: LoadResult): void {
  if (result.kind !== "loaded") throw new Error(`[benchmark] window readiness ${result.kind}.`);
}

function snapshotMainTimerCounters(): MainTimerCounters {
  return {
    timerResourcesCreated: timerState.timerResourcesCreated,
    timerCallbacks: timerState.timerCallbacks,
    timerResourcesDestroyed: timerState.timerResourcesDestroyed,
    activeTimerResources: activeTimerIds.size,
  };
}

function snapshotTimerCounters(
  rendererCountdown: RendererCountdownTimerCounters,
): BenchmarkTimerCounters {
  return {
    main: snapshotMainTimerCounters(),
    rendererCountdown,
    battery: getBatteryBenchmarkCounters(),
  };
}

function sampleSync(action: () => void): readonly number[] {
  const samples: number[] = [];
  for (let index = 0; index < RESPONSIVENESS_SAMPLE_COUNT; index += 1) {
    const started = performance.now();
    action();
    samples.push(round(performance.now() - started));
  }
  return samples;
}

async function sampleTrayMenuProxy(): Promise<readonly number[]> {
  const { measureBenchmarkTrayMenuProxy } = await import("../../main/tray.js");
  return sampleSync(() => {
    measureBenchmarkTrayMenuProxy();
  });
}

async function sampleSettingsWindowReady(): Promise<BenchmarkArtifact["readiness"]["settings"]> {
  const { createSettingsWindow, closeSettingsWindow } =
    await import("../../main/settings-window.js");
  const samples: { load: LoadResult; ready: LoadResult }[] = [];
  for (let index = 0; index < RESPONSIVENESS_SAMPLE_COUNT; index += 1) {
    const settingsWin = createSettingsWindow();
    try {
      const result = await waitForWindowReadyToShow(settingsWin);
      requireLoaded(result);
      const load = await waitForWindowLoad(settingsWin);
      requireLoaded(load);
      samples.push({ load, ready: result });
    } finally {
      closeSettingsWindow();
    }
    await sleep(25);
  }
  return samples;
}

async function collectIdleSamples(
  startMs: number,
  win: BrowserWindow,
): Promise<readonly IdleSample[]> {
  const samples: IdleSample[] = [];
  for (let index = 0; index < IDLE_SAMPLE_COUNT; index += 1) {
    await sleep(IDLE_SAMPLE_INTERVAL_MS);
    const appMetrics = app.getAppMetrics();
    const memoryUsage = process.memoryUsage();
    const rendererCountdownCounters = await readRendererCountdownTimerCounters(win);
    samples.push({
      elapsedMs: round(performance.now() - startMs),
      totalCpuPercent: round(sumCpuPercent(appMetrics)),
      totalIdleWakeups: sumIdleWakeups(appMetrics),
      rssBytes: memoryUsage.rss,
      heapUsedBytes: memoryUsage.heapUsed,
      appMetrics,
      timerCounters: snapshotTimerCounters(rendererCountdownCounters),
    });
  }
  return samples;
}

async function readRendererCountdownTimerCounters(
  win: BrowserWindow,
): Promise<RendererCountdownTimerCounters> {
  const result: unknown = await win.webContents.executeJavaScript(RENDERER_COUNTER_SCRIPT, true);
  if (isRendererCountdownTimerCounters(result)) {
    return result;
  }
  throw new InvalidRendererBenchmarkCountersError();
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
