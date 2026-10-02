/**
 * Aurora utility dialog renderer — Check for Updates and similar alerts.
 * Privileged access via window.utilityDialogApi (dedicated preload).
 * Supports warm-cache re-present via onApply (no full page reload).
 *
 * The page outlives individual presentations. Main stamps each one with an
 * increasing `presentationId`; only the newest live presentation may build
 * controls, respond, resize, or reveal. Stale payload reads, duplicate APPLY
 * deliveries, and late height / animation completions are ignored. Listeners and
 * scheduled work are disposed on actual unload (pagehide), never on warm hide.
 *
 * Initial focus: when a warm window is shown or activated again, Chromium resets
 * focus to the first tab stop (or the document). Until the user types, clicks, or
 * moves focus (e.g. assistive technology), the live presentation restores focus to
 * its own default target after such a reset.
 */
import "./styles.css";
import type {
  UtilityDialogApplyMessage,
  UtilityDialogPayload,
} from "../../shared/utility-dialog.js";
import { bindIconAuroraStagePause } from "../icon-aurora-pause.js";

const heroIcon = new URL("../../assets/settings-hero-icon.png", import.meta.url).toString();

/** Fallback reveal if animation frames stop arriving (hidden/occluded window). */
const OPEN_ANIMATION_FALLBACK_MS = 400;

declare global {
  interface Window {
    utilityDialogApi: {
      getPayload: () => Promise<UtilityDialogPayload>;
      respond: (presentationId: number, response: number) => Promise<void>;
      setHeight: (presentationId: number, height: number) => Promise<void>;
      onApply: (callback: (message: UtilityDialogApplyMessage) => void) => () => void;
      os: string;
    };
  }
}

/** State of the presentation currently on screen; replaced (never reused) per presentation. */
interface LivePresentation {
  readonly id: number;
  readonly defaultId: number;
  readonly cancelId: number;
  readonly showActionButtons: boolean;
  responded: boolean;
  /** Default button, or the dialog surface for info-only alerts. */
  focusTarget: HTMLElement;
  /** Set on the first key/pointer input or deliberate focus move; focus is the user's then. */
  focusSettled: boolean;
}

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) {
    throw new Error(`[utility-dialog] Missing element #${id}`);
  }
  return el as T;
}

function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return false;
  }
}

function clampIndex(index: number, length: number, fallback: number): number {
  if (length <= 0) return 0;
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    return fallback;
  }
  return index;
}

/** Timeouts and animation frames owned by this page, cancelled together on unload. */
function createScheduler(): {
  timeout: (callback: () => void, ms: number) => void;
  frame: (callback: () => void) => void;
  cancelAll: () => void;
} {
  const timeouts = new Set<number>();
  const frames = new Set<number>();
  return {
    timeout(callback, ms) {
      const id = window.setTimeout(() => {
        timeouts.delete(id);
        callback();
      }, ms);
      timeouts.add(id);
    },
    frame(callback) {
      if (typeof requestAnimationFrame !== "function") {
        callback();
        return;
      }
      // Boxed id: safe even if a host runs the callback before returning the id.
      const frame = { id: 0 };
      frame.id = requestAnimationFrame(() => {
        frames.delete(frame.id);
        callback();
      });
      frames.add(frame.id);
    },
    cancelAll() {
      for (const id of timeouts) window.clearTimeout(id);
      timeouts.clear();
      if (typeof cancelAnimationFrame === "function") {
        for (const id of frames) cancelAnimationFrame(id);
      }
      frames.clear();
    },
  };
}

function bootstrap(): void {
  const api = window.utilityDialogApi;
  if (api.os === "win32") {
    document.body.classList.add("platform-win32");
  }

  const root = requireEl<HTMLDivElement>("app");
  const icon = requireEl<HTMLImageElement>("dialog-icon");
  const messageEl = requireEl<HTMLHeadingElement>("dialog-message");
  const detailEl = requireEl<HTMLParagraphElement>("dialog-detail");
  const actionsEl = requireEl<HTMLDivElement>("dialog-actions");
  // Wire pause before async payload so warm-cache hide still freezes leaves.
  const unbindAuroraPause = bindIconAuroraStagePause(root);

  icon.src = heroIcon;
  // Icon is decorative for layout; height measure does not wait on decode.

  const scheduler = createScheduler();
  let disposed = false;
  /** Highest presentation id seen (presented or retired); nothing older is applied. */
  let latestPresentationId = 0;
  let live: LivePresentation | null = null;

  const isLive = (presentation: LivePresentation): boolean => !disposed && live === presentation;

  /** True while this page moves focus itself, so the focus guard ignores the change. */
  let movingFocus = false;
  const focusPresentationTarget = (presentation: LivePresentation): void => {
    movingFocus = true;
    try {
      presentation.focusTarget.focus({ preventScroll: true });
    } finally {
      movingFocus = false;
    }
  };

  const respond = (presentation: LivePresentation, index: number): void => {
    if (!isLive(presentation) || presentation.responded) return;
    presentation.responded = true;
    void api.respond(presentation.id, index).catch((err: unknown) => {
      console.error("[utility-dialog] respond failed:", err);
    });
  };

  /** Opacity-only open (no scale) so height shrink-wrap does not fight transform. */
  const startOpenAnimation = (presentation: LivePresentation): void => {
    root.classList.remove("pre-animate", "ready");
    if (prefersReducedMotion()) {
      root.classList.add("ready");
      return;
    }
    root.classList.add("pre-animate");
    const finish = (): void => {
      // A later presentation owns the reveal once this one is retired or replaced.
      if (!isLive(presentation)) return;
      root.classList.remove("pre-animate");
      root.classList.add("ready");
    };
    scheduler.frame(() => {
      scheduler.frame(finish);
    });
    scheduler.timeout(finish, OPEN_ANIMATION_FALLBACK_MS);
  };

  /**
   * Measure intrinsic content height and shrink-wrap.
   * Single rAF; does not wait on icon (stage size is reserved in CSS).
   * Invokes `onSettled` after setHeight resolves (or immediately on skip/failure)
   * so open animation never races the first resize (warm-edge filter fringe).
   * Completions for a presentation that is no longer live are ignored.
   */
  const reportContentHeight = (presentation: LivePresentation, onSettled: () => void): void => {
    scheduler.frame(() => {
      if (!isLive(presentation)) return;
      const prevMinHeight = root.style.minHeight;
      const prevHeight = root.style.height;
      root.style.minHeight = "0";
      root.style.height = "auto";
      const height = Math.ceil(root.scrollHeight);
      root.style.minHeight = prevMinHeight;
      root.style.height = prevHeight;
      if (height <= 0) {
        onSettled();
        return;
      }
      void api.setHeight(presentation.id, height).then(
        () => {
          if (isLive(presentation)) onSettled();
        },
        (err: unknown) => {
          console.error("[utility-dialog] setHeight failed:", err);
          // Still reveal content if sizing fails.
          if (isLive(presentation)) onSettled();
        },
      );
    });
  };

  const applyPayload = (payload: UtilityDialogPayload): void => {
    // Older (stale) or equal (duplicate / already retired) ids change nothing:
    // no rebuild, no refocus, and no re-armed response.
    if (disposed || payload.presentationId <= latestPresentationId) return;
    latestPresentationId = payload.presentationId;

    document.title = payload.title;
    messageEl.textContent = payload.message;
    detailEl.textContent = payload.detail;

    const buttons = payload.buttons.length > 0 ? payload.buttons : ["OK"];
    const presentation: LivePresentation = {
      id: payload.presentationId,
      defaultId: clampIndex(payload.defaultId, buttons.length, buttons.length - 1),
      cancelId: clampIndex(payload.cancelId, buttons.length, 0),
      showActionButtons: buttons.length > 1,
      responded: false,
      focusTarget: root,
      focusSettled: false,
    };
    live = presentation;

    // Wipe previous action row (warm-cache re-present).
    actionsEl.replaceChildren();
    root.classList.remove("no-actions");
    actionsEl.hidden = false;

    if (presentation.showActionButtons) {
      buttons.forEach((label, index) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.className =
          index === presentation.defaultId ? "dialog-btn-primary" : "dialog-btn-secondary";
        btn.addEventListener("click", () => {
          respond(presentation, index);
        });
        actionsEl.appendChild(btn);
      });
      const defaultButton = actionsEl.children[presentation.defaultId] ?? actionsEl.children[0];
      if (defaultButton instanceof HTMLButtonElement) {
        presentation.focusTarget = defaultButton;
      }
    } else {
      actionsEl.hidden = true;
      root.classList.add("no-actions");
      // Focus the dialog surface for screen readers (info-only, no action row).
      if (!root.hasAttribute("tabindex")) {
        root.tabIndex = -1;
      }
    }
    focusPresentationTarget(presentation);

    // Hold invisible, shrink-wrap, then fade in. Racing fade/bloom with setHeight
    // on first open let aurora filter/blend fringe paint a warm edge outside the
    // final window bounds.
    root.classList.remove("ready");
    root.classList.add("pre-animate");
    reportContentHeight(presentation, () => {
      startOpenAnimation(presentation);
    });
  };

  /** Main dismissed this presentation: stop it from responding, resizing, or revealing. */
  const retire = (presentationId: number): void => {
    latestPresentationId = Math.max(latestPresentationId, presentationId);
    if (live !== null && live.id <= presentationId) {
      live = null;
    }
  };

  const onApply = (message: UtilityDialogApplyMessage): void => {
    switch (message.kind) {
      case "present":
        applyPayload(message.payload);
        break;
      case "retire":
        retire(message.presentationId);
        break;
    }
  };

  /**
   * Window show / activation resets focus to the first tab stop or the document.
   * Before the user settles focus, put it back on the live presentation's target
   * once that reset has run (a deactivating window keeps its active element, so the
   * restore is then a no-op).
   */
  const scheduleFocusRestore = (): void => {
    const presentation = live;
    if (presentation === null || presentation.focusSettled) return;
    scheduler.timeout(() => {
      if (
        isLive(presentation) &&
        !presentation.focusSettled &&
        document.activeElement !== presentation.focusTarget
      ) {
        focusPresentationTarget(presentation);
      }
    }, 0);
  };

  const onFocusOut = (e: FocusEvent): void => {
    if (movingFocus || live === null) return;
    if (e.relatedTarget === null) {
      // Focus cleared without a destination: the window show reset.
      scheduleFocusRestore();
      return;
    }
    // A deliberate move to another element (assistive technology, script) is kept.
    live.focusSettled = true;
  };

  const onPointerDown = (): void => {
    if (live !== null) live.focusSettled = true;
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    const presentation = live;
    if (presentation === null) return;
    presentation.focusSettled = true;
    if (e.key === "Escape") {
      e.preventDefault();
      respond(presentation, presentation.cancelId);
      return;
    }
    if (e.key === "Enter") {
      if (!presentation.showActionButtons) {
        e.preventDefault();
        respond(presentation, presentation.cancelId);
        return;
      }
      const active = document.activeElement;
      if (active instanceof HTMLButtonElement && actionsEl.contains(active)) {
        return;
      }
      e.preventDefault();
      respond(presentation, presentation.defaultId);
    }
  };

  let unsubscribeApply: () => void = () => {};

  const dispose = (): void => {
    disposed = true;
    live = null;
    unsubscribeApply();
    unbindAuroraPause();
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("focus", scheduleFocusRestore);
    document.removeEventListener("focusout", onFocusOut, true);
    window.removeEventListener("pagehide", onPageHide);
    scheduler.cancelAll();
  };

  // Warm hide keeps everything; only a real unload (not a bfcache entry) disposes.
  const onPageHide = (event: PageTransitionEvent): void => {
    if (event.persisted) return;
    dispose();
  };

  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("pointerdown", onPointerDown, true);
  // Activation can land focus on the first tab stop without any focusout.
  window.addEventListener("focus", scheduleFocusRestore);
  document.addEventListener("focusout", onFocusOut, true);
  // Warm-cache re-present / retirement: main pushes without reloading.
  unsubscribeApply = api.onApply(onApply);

  // First paint: pull payload if main already stored one (race with APPLY).
  void api.getPayload().then(applyPayload, () => {
    // Idle warm shell may have no payload yet — wait for onApply.
  });
}

/** An unrenderable page declines only the presentation that is live right now. */
function declineLivePresentation(): void {
  try {
    const api = window.utilityDialogApi;
    void api
      .getPayload()
      .then((payload) => api.respond(payload.presentationId, payload.cancelId))
      .catch(() => {
        // No live presentation, or main already settled it.
      });
  } catch {
    // Preload may be unavailable if bootstrap failed very early.
  }
}

try {
  bootstrap();
} catch (err: unknown) {
  console.error("[utility-dialog] bootstrap failed:", err);
  const root = document.getElementById("app");
  if (root !== null) {
    root.classList.remove("pre-animate");
    root.classList.add("ready");
  }
  declineLivePresentation();
}
