import "./styles/main.css";
import type { AppSettings, PerfTimestamp, SessionStatusResponse } from "../shared/types.js";
import { asPerf } from "../shared/types.js";
import { isEffectivelyActive as isEffectivelyActiveState } from "../domain/session/effective-active.js";
import {
  installRendererBenchmarkCounters,
  recordCountdownCallback,
  recordCountdownClear,
  recordCountdownSchedule,
  recordCountdownStart,
  recordCountdownStop,
} from "./benchmark-countdown.js";
import {
  LABEL_CANCEL_SESSION,
  LABEL_PREVENT_SLEEP,
  LABEL_SESSION_DURATION,
  SESSION_DURATION_CHIPS,
  ERROR_PREFERENCE_SAVE_FAILED,
  ERROR_SETTINGS_UNAVAILABLE,
  STATUS_PREVENTING_SLEEP,
  STATUS_SLEEP_PREVENTION_OFF,
  STATUS_UNAVAILABLE,
} from "./constants.js";

type SessionStatus = SessionStatusResponse | null;

const MIN_H = 180;
const MAX_H = 420;
const COUNTDOWN_TICK_MS = 1000;

let settings: AppSettings | null = null;
let sessionStatus: SessionStatus = null;
/** Anchor (in renderer's performance.now() domain) when the active session expires. */
let sessionExpiresAtPerf: PerfTimestamp | null = null;
let saveError: string | null = null;
let sessionUnavailable = true;
let settingsRevision = 0;
let sessionRevision = 0;
let settingsReadId = 0;
let activeSettingsReadId: number | null = null;
let sessionReadInFlight = false;
let isWritingPreference = false;
let queuedPreference: boolean | null = null;
let disposed = false;
let unsubscribeSettings: (() => void) | null = null;
let unsubscribeSessionStatus: (() => void) | null = null;
let unsubscribeWindowHide: (() => void) | null = null;
let isPopoverVisible = false;
let isLoading = true;
let countdownIntervalId: ReturnType<typeof setInterval> | null = null;
const listenersController = new AbortController();

installRendererBenchmarkCounters();

const TIMER_ICON_SVG = `<svg class="popover-timer-icon" aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6" cy="6" r="5"/><path d="M6 3v3l2 2"/></svg><span class="visually-hidden">Timer</span>`;

const BOLT_ICON_SVG = `<svg class="app-title-icon" aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M7 1L1 7h4l-1 4 6-6H6z"/></svg><span class="visually-hidden">Active</span>`;

// Cached DOM element references (populated after render)
let statusDotEl: HTMLElement | null = null;
let statusTextEl: HTMLElement | null = null;
let timerValueEl: HTMLElement | null = null;
let statusErrorEl: HTMLElement | null = null;
let preventSleepToggleEl: HTMLInputElement | null = null;
let sessionActionsEl: HTMLElement | null = null;
let rafId: number | null = null;
let renderRafId: number | null = null;
let pendingFullControls = false;
/** Last painted session-actions mode; skip rebuild when unchanged. */
let sessionActionsMode: "running" | "idle" | null = null;
/** True once click delegation is bound on `#session-actions`. */
let sessionActionsDelegated = false;

function getApp(): HTMLElement | null {
  return document.getElementById("app");
}

/**
 * Capture countdown anchors from a freshly received status snapshot.
 * Maps main-process performance.now() expiresAt onto renderer's perf clock
 * via wall-clock delta (Date.now() approximates the moment of receipt).
 */
function updateSessionAnchors(status: SessionStatus): void {
  if (status !== null && status.isRunning && status.remainingSeconds !== null) {
    const remainingMs = status.remainingSeconds * 1000;
    sessionExpiresAtPerf = asPerf(performance.now() + remainingMs);
  } else {
    sessionExpiresAtPerf = null;
  }
}

/** Compute remaining seconds locally from anchors — no IPC. */
function computeRemainingSeconds(expiresAtPerf: PerfTimestamp | null): number | null {
  if (expiresAtPerf === null) return null;
  const remainingMs = Math.max(0, expiresAtPerf - performance.now());
  return Math.floor(remainingMs / 1000);
}

/** Effective active state: user intent OR live session (domain pure rule). */
function isEffectivelyActive(): boolean {
  return isEffectivelyActiveState(
    settings?.preventSleep ?? false,
    Boolean(sessionStatus?.isRunning),
  );
}

function formatTimerValue(): string {
  if (!sessionStatus?.isRunning || sessionStatus.durationMinutes === null) {
    return " Indefinitely";
  }

  // Prefer locally-computed value (no IPC, no 1s-push dependency).
  const localRemaining = computeRemainingSeconds(sessionExpiresAtPerf);
  const computedRemaining = localRemaining ?? sessionStatus.remainingSeconds;

  const totalSeconds = Math.max(0, Math.ceil(computedRemaining));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.ceil((totalSeconds % 3600) / 60);

  if (hours >= 1) {
    return ` ${hours}h ${minutes}m remaining`;
  }

  const minuteValue = Math.max(0, Math.ceil(totalSeconds / 60));
  return ` ${minuteValue}m remaining`;
}

let lastRenderedTimerText: string | null = null;

function startCountdownTicker(): void {
  recordCountdownStart();
  if (countdownIntervalId !== null) return;
  countdownIntervalId = setInterval(() => {
    recordCountdownCallback();
    // Only refresh display when a timed session is active locally.
    if (sessionExpiresAtPerf === null) return;
    // Pure tick: timer text only (no full controls repaint).
    updateStatusUI();
  }, COUNTDOWN_TICK_MS);
  recordCountdownSchedule();
}

function stopCountdownTicker(): void {
  recordCountdownStop();
  if (countdownIntervalId !== null) {
    clearInterval(countdownIntervalId);
    countdownIntervalId = null;
    recordCountdownClear();
  }
  // Clear cache so next tick forces a fresh render.
  lastRenderedTimerText = null;
}

function syncCountdownTicker(): void {
  if (disposed) return;
  if (isPopoverVisible && sessionExpiresAtPerf !== null) {
    if (countdownIntervalId === null) {
      startCountdownTicker();
    }
    return;
  }

  if (countdownIntervalId !== null) {
    stopCountdownTicker();
  }
}

function resizeToContent(): void {
  const app = getApp();
  if (!app) return;

  const targetH = Math.min(MAX_H, Math.max(MIN_H, Math.ceil(app.scrollHeight)));
  window.api.window.setHeight(targetH);
}

function paintControls(): void {
  const active = isEffectivelyActive();
  statusDotEl?.classList.toggle("active", active);
  if (statusTextEl) {
    statusTextEl.textContent = active
      ? STATUS_PREVENTING_SLEEP
      : settings === null || sessionUnavailable
        ? STATUS_UNAVAILABLE
        : STATUS_SLEEP_PREVENTION_OFF;
  }
  if (preventSleepToggleEl) {
    preventSleepToggleEl.disabled = settings === null;
    preventSleepToggleEl.checked = settings?.preventSleep ?? false;
    preventSleepToggleEl.setAttribute("aria-checked", String(settings?.preventSleep ?? false));
  }
  if (statusErrorEl) {
    const error = saveError ?? (settings === null ? ERROR_SETTINGS_UNAVAILABLE : null);
    statusErrorEl.textContent = error ?? "";
    statusErrorEl.classList.toggle("visible", error !== null);
  }
  paintSessionActions();
}

/**
 * Rebuild `#session-actions` only when the running/idle mode changes.
 * Click handling uses one delegated listener so same-mode status pushes do not
 * rebind or replace the action subtree (stable cancel-button identity).
 */
function paintSessionActions(): void {
  if (!sessionActionsEl) return;
  const running = Boolean(sessionStatus?.isRunning);
  const mode: "running" | "idle" = running ? "running" : "idle";
  ensureSessionActionsDelegation(sessionActionsEl);
  if (mode === sessionActionsMode) {
    return;
  }
  sessionActionsMode = mode;
  if (running) {
    sessionActionsEl.innerHTML = `<button type="button" id="cancel-session-action" class="session-chip session-chip--cancel">${LABEL_CANCEL_SESSION}</button>`;
    return;
  }
  const chips = SESSION_DURATION_CHIPS.map(
    (chip) =>
      `<button type="button" class="session-chip" data-duration="${chip.minutes === null ? "" : String(chip.minutes)}">${chip.label}</button>`,
  ).join("");
  sessionActionsEl.innerHTML = `<span class="session-actions-label">${LABEL_SESSION_DURATION}</span><div class="session-chip-row">${chips}</div>`;
}

function ensureSessionActionsDelegation(container: HTMLElement): void {
  if (sessionActionsDelegated) return;
  sessionActionsDelegated = true;
  container.addEventListener(
    "click",
    (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const btn = target.closest<HTMLButtonElement>("button.session-chip");
      if (btn === null || !container.contains(btn)) return;
      if (btn.id === "cancel-session-action") {
        // Status arrives via SESSION_STATUS_UPDATE push; no redundant getStatus.
        void window.api.session.cancel();
        return;
      }
      const raw = btn.dataset["duration"] ?? "";
      const duration: number | null = raw === "" ? null : parseInt(raw, 10);
      if (raw !== "" && Number.isNaN(duration)) return;
      void window.api.session.start(duration);
    },
    { signal: listenersController.signal },
  );
}

function updateStatusUI(options?: { fullControls?: boolean }): void {
  if (disposed || isLoading) return;
  if (options?.fullControls === true) pendingFullControls = true;
  // Skip work when timer text unchanged and this is a pure countdown tick.
  const currentTimerText = formatTimerValue();
  if (currentTimerText === lastRenderedTimerText && !pendingFullControls) {
    return;
  }
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
  }
  rafId = requestAnimationFrame(() => {
    rafId = null;
    if (disposed) return;
    lastRenderedTimerText = currentTimerText;
    if (pendingFullControls || timerValueEl === null) {
      paintControls();
    }
    pendingFullControls = false;
    if (timerValueEl) {
      timerValueEl.textContent = currentTimerText;
    }
  });
}

function paintReadResult(): void {
  if (disposed) return;
  if (renderRafId !== null) {
    paintControls();
    const timerText = formatTimerValue();
    if (timerValueEl) timerValueEl.textContent = timerText;
    lastRenderedTimerText = timerText;
    return;
  }
  updateStatusUI({ fullControls: true });
}

function canApplySettingsRead(readId: number, revision: number): boolean {
  return !disposed && revision === settingsRevision && activeSettingsReadId === readId;
}

function canApplySessionRead(revision: number): boolean {
  return !disposed && revision === sessionRevision;
}

async function refreshSettings(preserveSaveError = false): Promise<void> {
  if (activeSettingsReadId !== null || disposed) return;
  const readId = ++settingsReadId;
  activeSettingsReadId = readId;
  const revision = settingsRevision;
  try {
    const next = await window.api.settings.get();
    if (!canApplySettingsRead(readId, revision)) return;
    settings = next;
    settingsRevision += 1;
    if (!preserveSaveError) saveError = null;
  } catch (error) {
    if (!canApplySettingsRead(readId, revision)) return;
    console.warn("[renderer] Failed to get settings", error);
    settings = null;
  } finally {
    if (activeSettingsReadId === readId) {
      activeSettingsReadId = null;
      paintReadResult();
    }
  }
}

async function refreshSessionStatus(): Promise<void> {
  if (sessionReadInFlight || disposed) return;
  sessionReadInFlight = true;
  const revision = sessionRevision;
  try {
    const next = await window.api.session.getStatus();
    if (!canApplySessionRead(revision)) return;
    sessionStatus = next;
    updateSessionAnchors(sessionStatus);
    sessionUnavailable = false;
    sessionRevision += 1;
  } catch (error) {
    if (!canApplySessionRead(revision)) return;
    console.warn("[renderer] Failed to get session status", error);
    sessionStatus = null;
    updateSessionAnchors(null);
    sessionUnavailable = true;
  } finally {
    sessionReadInFlight = false;
    syncCountdownTicker();
    paintReadResult();
  }
}

async function savePreference(next: boolean): Promise<void> {
  isWritingPreference = true;
  const revision = settingsRevision;
  try {
    const response = await window.api.settings.set({ preventSleep: next });
    if (disposed) return;
    if (revision === settingsRevision) {
      settings = response.settings;
      settingsRevision += 1;
    }
    const rejected = response.rejectedKeys.includes("preventSleep");
    saveError = rejected ? ERROR_PREFERENCE_SAVE_FAILED : null;
    if (rejected) queuedPreference = null;
  } catch (error) {
    if (disposed) return;
    console.warn("[renderer] Failed to save Prevent Sleep", error);
    saveError = ERROR_PREFERENCE_SAVE_FAILED;
    queuedPreference = null;
    await refreshSettings(true);
  } finally {
    isWritingPreference = false;
    updateStatusUI({ fullControls: true });
    const queued = queuedPreference;
    queuedPreference = null;
    if (!disposed && queued !== null && settings !== null && queued !== settings.preventSleep) {
      void savePreference(queued);
    }
  }
}

function bindEvents(): void {
  const app = getApp();
  if (!app) return;

  const settingsButton = app.querySelector<HTMLButtonElement>("#settings-action");
  const quitButton = app.querySelector<HTMLButtonElement>("#quit-action");
  const preventToggle = app.querySelector<HTMLInputElement>("#prevent-sleep-toggle");

  settingsButton?.addEventListener(
    "click",
    () => {
      void window.api.settings.open();
    },
    { signal: listenersController.signal },
  );

  quitButton?.addEventListener(
    "click",
    () => {
      void window.api.app.quit();
    },
    { signal: listenersController.signal },
  );

  preventToggle?.addEventListener(
    "change",
    () => {
      if (settings === null || disposed) return;
      const next = preventToggle.checked;
      preventToggle.checked = settings.preventSleep;
      preventToggle.setAttribute("aria-checked", String(settings.preventSleep));
      if (isWritingPreference) {
        queuedPreference = next;
        return;
      }
      if (next !== settings.preventSleep) void savePreference(next);
    },
    { signal: listenersController.signal },
  );

  paintSessionActions();
}

function render(version: string): void {
  const app = document.getElementById("app");
  if (!app) return;

  app.innerHTML = `
    <div class="popover">
      <header class="popover-header">
        <span class="app-title">${BOLT_ICON_SVG} Amphetamine</span>
        <span class="app-version">v${version}</span>
      </header>

      <section class="popover-status" aria-live="polite">
        <span id="status-dot" class="status-dot${isEffectivelyActive() ? " active" : ""}"></span>
        <span id="status-text" class="status-text"></span>
      </section>

      <p id="status-error" class="status-error status-text popover-status"></p>

      <div class="popover-toggle-row">
        <label class="popover-toggle-label" for="prevent-sleep-toggle">${LABEL_PREVENT_SLEEP}</label>
        <label class="toggle-switch">
          <input type="checkbox" id="prevent-sleep-toggle" class="toggle-input" role="switch" aria-checked="false" disabled />
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
        </label>
      </div>

      <p id="timer-text" class="popover-timer"><span class="timer-icon">${TIMER_ICON_SVG}</span><span class="timer-value">${formatTimerValue()}</span></p>

      <div id="session-actions" class="session-actions"></div>

      <div class="popover-divider" role="presentation"></div>

      <footer class="popover-footer">
        <button id="settings-action" class="footer-action" type="button">Settings...</button>
        <button id="quit-action" class="footer-action footer-action--quit" type="button">Quit</button>
      </footer>
    </div>
  `;

  // Full shell re-render: reset mode so actions paint once after cache is set.
  sessionActionsMode = null;
  sessionActionsDelegated = false;
  statusDotEl = app.querySelector("#status-dot");
  statusTextEl = app.querySelector("#status-text");
  timerValueEl = app.querySelector(".timer-value");
  statusErrorEl = app.querySelector("#status-error");
  preventSleepToggleEl = app.querySelector("#prevent-sleep-toggle");
  sessionActionsEl = app.querySelector("#session-actions");
  bindEvents();
  paintControls();

  renderRafId = requestAnimationFrame(() => {
    renderRafId = null;
    if (disposed) return;
    resizeToContent();

    if (isPopoverVisible) {
      app.classList.add("visible");
    }
  });
}

/**
 * Transition-based hide: ignore duplicate hide signals while already hidden
 * so countdown stop/clear is recorded once per hide transition.
 */
function handlePopoverHide(): void {
  if (!isPopoverVisible) return;
  const app = getApp();
  if (!app) return;

  isPopoverVisible = false;
  app.classList.remove("visible");
  syncCountdownTicker();
}

function handleVisibilityChange(): void {
  if (disposed) return;
  const app = getApp();
  if (!app) return;

  if (document.visibilityState === "visible") {
    if (isPopoverVisible) {
      // Already visible — no transition work.
      return;
    }
    isPopoverVisible = true;
    app.classList.add("visible");
    updateStatusUI();
    syncCountdownTicker();
    if (settings === null) void refreshSettings();
    if (sessionUnavailable) void refreshSessionStatus();
    return;
  }

  // Hidden: same transition path as window:hide (dedupe if already hidden).
  handlePopoverHide();
}

/** Subscribe to push updates from main process */
function setupPushSubscriptions(): void {
  unsubscribeSettings = window.api.onSettingsChanged((next) => {
    if (disposed) return;
    activeSettingsReadId = null;
    settings = next;
    settingsRevision += 1;
    saveError = null;
    updateStatusUI({ fullControls: true });
  });

  unsubscribeSessionStatus = window.api.onSessionStatusUpdate((status) => {
    if (disposed) return;
    sessionStatus = status;
    sessionRevision += 1;
    sessionUnavailable = false;
    updateSessionAnchors(status);
    syncCountdownTicker();
    updateStatusUI({ fullControls: true });
  });
}

/** Attach window/document event listeners for popover lifecycle */
function attachWindowEvents(): void {
  document.addEventListener("visibilitychange", handleVisibilityChange, {
    signal: listenersController.signal,
  });
  unsubscribeWindowHide = window.api.onWindowHide(() => {
    if (disposed) return;
    handlePopoverHide();
  });

  window.addEventListener(
    "beforeunload",
    () => {
      if (disposed) return;
      disposed = true;
      listenersController.abort();
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (renderRafId !== null) {
        cancelAnimationFrame(renderRafId);
        renderRafId = null;
      }
      stopCountdownTicker();
      statusDotEl = null;
      statusTextEl = null;
      timerValueEl = null;
      statusErrorEl = null;
      preventSleepToggleEl = null;
      sessionActionsEl = null;
      sessionActionsMode = null;
      sessionActionsDelegated = false;
      unsubscribeSessionStatus?.();
      unsubscribeSessionStatus = null;
      unsubscribeSettings?.();
      unsubscribeSettings = null;
      unsubscribeWindowHide?.();
      unsubscribeWindowHide = null;
    },
    { signal: listenersController.signal },
  );
}

function init(): void {
  isLoading = true;
  isPopoverVisible = true;
  setupPushSubscriptions();
  attachWindowEvents();
  render("-");
  isLoading = false;
  void refreshSettings();
  void refreshSessionStatus();
  void window.api.app
    .getVersion()
    .then((version) => {
      if (disposed) return;
      const versionEl = document.querySelector<HTMLElement>(".app-version");
      if (versionEl) versionEl.textContent = `v${version}`;
    })
    .catch((error: unknown) => {
      if (!disposed) console.warn("[renderer] Failed to get version", error);
    });
}

document.addEventListener(
  "DOMContentLoaded",
  () => {
    init();
  },
  { once: true },
);
