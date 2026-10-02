import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  UtilityDialogApplyMessage,
  UtilityDialogPayload,
} from "../../src/shared/utility-dialog.js";

const mockGetPayload = vi.fn<() => Promise<UtilityDialogPayload>>();
const mockRespond = vi.fn<(presentationId: number, response: number) => Promise<void>>();
const mockSetHeight = vi.fn<(presentationId: number, height: number) => Promise<void>>();
const mockOnApply = vi.fn<(callback: (message: UtilityDialogApplyMessage) => void) => () => void>();

const samplePayload: UtilityDialogPayload = {
  presentationId: 1,
  title: "Amphetamine",
  message: "You're up to date",
  detail: "Amphetamine 1.11.0 is the latest version.",
  buttons: ["OK"],
  defaultId: 0,
  cancelId: 0,
};
const choicePayload: UtilityDialogPayload = {
  ...samplePayload,
  buttons: ["Not now", "Install"],
  defaultId: 1,
};
const nativeWindow = window;
/** Every listener the renderer adds through the stand-in window (removed after each test). */
const windowListeners: [string, EventListenerOrEventListenerObject][] = [];

async function openDialog(): Promise<void> {
  vi.resetModules();
  await import("../../src/renderer/utility-dialog/index.js");
  await vi.advanceTimersByTimeAsync(400);
}

/** Deliver an APPLY push through the renderer's subscription. */
function apply(message: UtilityDialogApplyMessage): void {
  const listener = mockOnApply.mock.calls[0]?.[0];
  if (listener === undefined) throw new Error("renderer did not subscribe to APPLY");
  listener(message);
}

function present(payload: UtilityDialogPayload): void {
  apply({ kind: "present", payload });
}

function retire(presentationId: number): void {
  apply({ kind: "retire", presentationId });
}

function requireRoot(): HTMLElement {
  const root = document.getElementById("app");
  if (root === null) throw new Error("missing #app");
  return root;
}

function actionButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("#dialog-actions button"));
}

function pressKey(key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true });
  window.dispatchEvent(event);
  return event;
}

function enableMotion(): void {
  const originalMatchMedia = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    value: (query: string) => ({ ...originalMatchMedia(query), matches: false }),
    configurable: true,
  });
}

/** Manual animation-frame queue with cancellation (ids are stable per frame). */
function captureAnimationFrames(): {
  pending: Map<number, FrameRequestCallback>;
  run: (id: number) => void;
  runAll: () => void;
  cancel: ReturnType<typeof vi.fn<(id: number) => void>>;
} {
  const pending = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextId++;
    pending.set(id, callback);
    return id;
  });
  const cancel = vi.fn<(id: number) => void>((id) => {
    pending.delete(id);
  });
  vi.stubGlobal("cancelAnimationFrame", cancel);
  const run = (id: number): void => {
    const callback = pending.get(id);
    if (callback === undefined) throw new Error(`frame ${id} is not pending`);
    pending.delete(id);
    callback(id * 16);
  };
  return {
    pending,
    run,
    runAll: () => {
      for (const id of [...pending.keys()]) run(id);
    },
    cancel,
  };
}

function setupDom(): void {
  document.body.innerHTML = `
    <div
      id="app"
      class="utility-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="dialog-message"
      aria-describedby="dialog-detail"
    >
      <div class="icon-aurora-stage dialog-icon-stage">
        <div class="icon-aurora" aria-hidden="true">
          <span class="aurora-blob aurora-blob--core"></span>
          <span class="aurora-blob aurora-blob--a"></span>
          <span class="aurora-blob aurora-blob--b"></span>
          <span class="aurora-blob aurora-blob--c"></span>
          <span class="aurora-ring"></span>
          <span class="aurora-ring aurora-ring--counter"></span>
          <span class="aurora-sheen"></span>
          <span class="aurora-flare"></span>
        </div>
        <img id="dialog-icon" class="dialog-icon" alt="" draggable="false" />
      </div>
      <h1 id="dialog-message" class="dialog-message"></h1>
      <p id="dialog-detail" class="dialog-detail"></p>
      <div id="dialog-actions" class="dialog-actions" role="group" aria-label="Dialog actions"></div>
    </div>
  `;
}

function setDocumentVisibility(visibilityState: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    value: visibilityState,
    configurable: true,
  });
  Object.defineProperty(document, "hidden", {
    value: visibilityState === "hidden",
    configurable: true,
  });
}

describe("renderer utility-dialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    setupDom();
    setDocumentVisibility("visible");
    mockGetPayload.mockReset();
    mockGetPayload.mockResolvedValue(samplePayload);
    mockRespond.mockReset();
    mockRespond.mockResolvedValue(undefined);
    mockSetHeight.mockReset();
    mockSetHeight.mockResolvedValue(undefined);
    mockOnApply.mockReset();
    mockOnApply.mockImplementation(() => () => {
      /* unsubscribe */
    });

    Object.defineProperty(globalThis, "window", {
      value: {
        ...globalThis.window,
        utilityDialogApi: {
          getPayload: mockGetPayload,
          respond: mockRespond,
          setHeight: mockSetHeight,
          onApply: mockOnApply,
          os: "darwin",
        },
        matchMedia: (query: string) => ({
          matches: query === "(prefers-reduced-motion: reduce)",
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }),
        requestAnimationFrame: (cb: FrameRequestCallback) => {
          cb(0);
          return 0;
        },
        dispatchEvent: nativeWindow.dispatchEvent.bind(nativeWindow),
        addEventListener: (
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | AddEventListenerOptions,
        ) => {
          nativeWindow.addEventListener(type, listener, options);
          windowListeners.push([type, listener]);
        },
        removeEventListener: nativeWindow.removeEventListener.bind(nativeWindow),
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    for (const [type, listener] of windowListeners)
      nativeWindow.removeEventListener(type, listener);
    windowListeners.length = 0;
    Object.defineProperty(globalThis, "window", {
      value: nativeWindow,
      writable: true,
      configurable: true,
    });
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("applies payload message and detail from getPayload", async () => {
    // jsdom scrollHeight is often 0 — stub so setHeight + post-settle open path run.
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(280);

    vi.resetModules();
    await import("../../src/renderer/utility-dialog/index.js");
    await vi.advanceTimersByTimeAsync(0);
    // getPayload → apply → rAF measure → setHeight.then(open)
    await Promise.resolve();
    await Promise.resolve();
    if (mockSetHeight.mock.results[0]?.value instanceof Promise) {
      await mockSetHeight.mock.results[0].value;
    }
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(400);

    expect(document.getElementById("dialog-message")?.textContent).toBe("You're up to date");
    expect(document.getElementById("dialog-detail")?.textContent).toBe(
      "Amphetamine 1.11.0 is the latest version.",
    );
    expect(document.title).toBe("Amphetamine");
    expect(mockSetHeight).toHaveBeenCalledWith(1, 280);
    // Open animation runs only after height settles.
    expect(document.getElementById("app")?.classList.contains("ready")).toBe(true);
  });

  it("pauses aurora stage when document is hidden and unpauses when visible", async () => {
    vi.resetModules();
    await import("../../src/renderer/utility-dialog/index.js");
    await vi.advanceTimersByTimeAsync(100);

    const stage = document.querySelector(".icon-aurora-stage");
    expect(stage).toBeInstanceOf(HTMLElement);
    expect(stage?.classList.contains("is-paused")).toBe(false);

    setDocumentVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(stage?.classList.contains("is-paused")).toBe(true);

    setDocumentVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(stage?.classList.contains("is-paused")).toBe(false);
  });

  it("mirrors fancy aurora leaf markup", async () => {
    vi.resetModules();
    await import("../../src/renderer/utility-dialog/index.js");
    await vi.advanceTimersByTimeAsync(0);

    expect(document.querySelector(".icon-aurora")?.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelectorAll(".aurora-blob")).toHaveLength(4);
    expect(document.querySelectorAll(".aurora-ring")).toHaveLength(2);
    expect(document.querySelector(".aurora-sheen")).not.toBeNull();
    expect(document.querySelector(".aurora-flare")).not.toBeNull();
  });

  it.each([0, 1])("renders multi-button actions and returns clicked choice %i", async (index) => {
    mockGetPayload.mockResolvedValue(choicePayload);
    await openDialog();

    const actions = document.getElementById("dialog-actions");
    const buttons = actions?.querySelectorAll<HTMLButtonElement>("button");
    expect(actions?.hidden).toBe(false);
    expect(Array.from(buttons ?? [], (button) => button.textContent)).toEqual(
      choicePayload.buttons,
    );
    expect(buttons?.[1]?.classList.contains("dialog-btn-primary")).toBe(true);
    expect(document.activeElement).toBe(buttons?.[1]);

    buttons?.[index]?.click();
    expect(mockRespond).toHaveBeenCalledExactlyOnceWith(1, index);
  });

  it.each(["Escape", "Enter"])("dismisses an info-only dialog with %s", async (key) => {
    await openDialog();
    const root = document.getElementById("app");
    expect(document.getElementById("dialog-actions")?.hidden).toBe(true);
    expect(root?.classList.contains("no-actions")).toBe(true);
    expect(document.activeElement).toBe(root);

    const event = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true });
    root?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(mockRespond).toHaveBeenCalledExactlyOnceWith(1, 0);
  });

  it.each(["Escape", "Enter"])("uses the configured %s choice outside buttons", async (key) => {
    mockGetPayload.mockResolvedValue({
      ...choicePayload,
      buttons: ["Later", "Install", "Skip"],
      cancelId: 2,
    });
    await openDialog();
    document.querySelector<HTMLButtonElement>(".dialog-btn-primary")?.blur();

    const event = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true });
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(mockRespond).toHaveBeenCalledExactlyOnceWith(1, key === "Escape" ? 2 : 1);
  });

  it("leaves Enter on a focused action to native button activation", async () => {
    mockGetPayload.mockResolvedValue(choicePayload);
    await openDialog();
    const button = document.querySelector<HTMLButtonElement>("#dialog-actions button");
    button?.focus();

    const event = new KeyboardEvent("keydown", { key: "Enter", cancelable: true, bubbles: true });
    button?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(mockRespond).not.toHaveBeenCalled();
  });

  it("sends only the first response when clicked and dismissed repeatedly", async () => {
    mockGetPayload.mockResolvedValue(choicePayload);
    await openDialog();
    const buttons = document.querySelectorAll<HTMLButtonElement>("#dialog-actions button");

    buttons[1]?.click();
    buttons[0]?.click();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(mockRespond).toHaveBeenCalledExactlyOnceWith(1, 1);
  });

  it("re-applies an info-only payload after dismissal and resets the response", async () => {
    mockGetPayload.mockResolvedValue(choicePayload);
    await openDialog();
    document.querySelector<HTMLButtonElement>(".dialog-btn-primary")?.click();

    retire(1);
    present({ ...samplePayload, presentationId: 2, title: "Status", message: "All set" });
    await vi.advanceTimersByTimeAsync(400);
    const actions = document.getElementById("dialog-actions");
    expect(document.title).toBe("Status");
    expect(document.getElementById("dialog-message")?.textContent).toBe("All set");
    expect(actions?.hidden).toBe(true);
    expect(actions?.children).toHaveLength(0);
    expect(document.activeElement).toBe(document.getElementById("app"));

    document
      .getElementById("app")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(mockRespond.mock.calls).toEqual([
      [1, 1],
      [2, 0],
    ]);
  });

  it("restores actions and default focus when re-applied after an info-only payload", async () => {
    await openDialog();
    present({ ...choicePayload, presentationId: 2 });
    await vi.advanceTimersByTimeAsync(400);

    const actions = document.getElementById("dialog-actions");
    expect(actions?.hidden).toBe(false);
    expect(document.getElementById("app")?.classList.contains("no-actions")).toBe(false);
    expect(actions?.querySelectorAll("button")).toHaveLength(2);
    expect(document.activeElement).toBe(actions?.querySelectorAll("button")[1]);
  });

  it("waits for height settlement before revealing and restores intrinsic sizing styles", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(281.2);
    const root = document.getElementById("app");
    root?.style.setProperty("min-height", "200px");
    root?.style.setProperty("height", "300px");
    let settleHeight: (() => void) | undefined;
    mockSetHeight.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settleHeight = resolve;
        }),
    );
    await openDialog();

    expect(mockSetHeight).toHaveBeenCalledWith(1, 282);
    expect(root?.classList.contains("pre-animate")).toBe(true);
    expect(root?.classList.contains("ready")).toBe(false);
    expect(root?.style.minHeight).toBe("200px");
    expect(root?.style.height).toBe("300px");

    settleHeight?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(root?.classList.contains("ready")).toBe(true);
  });

  it("reveals the dialog when the height request fails", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(280);
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockSetHeight.mockRejectedValue(new Error("resize unavailable"));
    await openDialog();

    expect(mockSetHeight).toHaveBeenCalledWith(1, 280);
    expect(document.getElementById("app")?.classList.contains("ready")).toBe(true);
    expect(mockRespond).not.toHaveBeenCalled();
  });

  it("waits for an applied payload when the first payload is unavailable", async () => {
    mockGetPayload.mockRejectedValue(new Error("no presentation yet"));
    await openDialog();
    expect(document.getElementById("dialog-message")?.textContent).toBe("");

    present(choicePayload);
    await vi.advanceTimersByTimeAsync(400);
    expect(document.getElementById("dialog-message")?.textContent).toBe(choicePayload.message);
    expect(document.querySelectorAll("#dialog-actions button")).toHaveLength(2);
    expect(document.getElementById("app")?.classList.contains("ready")).toBe(true);
  });

  it("ignores keys while no presentation is live", async () => {
    mockGetPayload.mockRejectedValue(new Error("no presentation yet"));
    await openDialog();

    expect(pressKey("Escape").defaultPrevented).toBe(false);
    expect(pressKey("Enter").defaultPrevented).toBe(false);
    expect(mockRespond).not.toHaveBeenCalled();
  });

  it("marks a Windows dialog for platform-specific chrome", async () => {
    window.utilityDialogApi.os = "win32";
    await openDialog();

    expect(document.body.classList.contains("platform-win32")).toBe(true);
    expect(document.activeElement).toBe(document.getElementById("app"));
  });

  it("keeps an empty action list dismissible as an info-only dialog", async () => {
    mockGetPayload.mockResolvedValue({ ...samplePayload, buttons: [], defaultId: 9, cancelId: 9 });
    await openDialog();

    const root = document.getElementById("app");
    expect(document.getElementById("dialog-actions")?.hidden).toBe(true);
    expect(root?.classList.contains("no-actions")).toBe(true);
    expect(document.activeElement).toBe(root);

    const event = new KeyboardEvent("keydown", { key: "Enter", cancelable: true, bubbles: true });
    root?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(mockRespond).toHaveBeenCalledExactlyOnceWith(1, 0);
  });

  it.each([-1, 1.5, 8])(
    "focuses the last action for invalid default index %s",
    async (defaultId) => {
      mockGetPayload.mockResolvedValue({ ...choicePayload, defaultId });
      await openDialog();

      const actions = document.querySelectorAll<HTMLButtonElement>("#dialog-actions button");
      expect(actions[1]?.classList.contains("dialog-btn-primary")).toBe(true);
      expect(document.activeElement).toBe(actions[1]);

      actions[1]?.click();
      expect(mockRespond).toHaveBeenCalledExactlyOnceWith(1, 1);
    },
  );

  it.each([-1, 1.5, 8])(
    "dismisses with the first action for invalid cancel index %s",
    async (cancelId) => {
      mockGetPayload.mockResolvedValue({ ...choicePayload, cancelId });
      await openDialog();

      const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(mockRespond).toHaveBeenCalledExactlyOnceWith(1, 0);
    },
  );

  it("preserves an existing dialog tab stop when focusing an info-only alert", async () => {
    const root = document.getElementById("app");
    root?.setAttribute("tabindex", "0");
    await openDialog();

    expect(root?.getAttribute("tabindex")).toBe("0");
    expect(document.activeElement).toBe(root);
    expect(document.getElementById("dialog-actions")?.hidden).toBe(true);
  });

  it("leaves unrelated keys available without dismissing the dialog", async () => {
    await openDialog();
    const event = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });

    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(mockRespond).not.toHaveBeenCalled();
    expect(document.getElementById("app")?.classList.contains("ready")).toBe(true);
  });

  it("reports a failed dismissal and accepts a choice on the next presentation", async () => {
    const error = new Error("dialog response unavailable");
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetPayload.mockResolvedValue(choicePayload);
    mockRespond.mockRejectedValueOnce(error);
    await openDialog();

    document.querySelector<HTMLButtonElement>(".dialog-btn-primary")?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(console.error).toHaveBeenCalledWith("[utility-dialog] respond failed:", error);
    expect(mockRespond).toHaveBeenCalledExactlyOnceWith(1, 1);

    present({ ...choicePayload, presentationId: 2, message: "Try again" });
    expect(document.getElementById("dialog-message")?.textContent).toBe("Try again");
    expect(document.activeElement).toBe(document.querySelector(".dialog-btn-primary"));
    document.querySelector<HTMLButtonElement>("#dialog-actions button")?.click();
    expect(mockRespond.mock.calls).toEqual([
      [1, 1],
      [2, 0],
    ]);
  });

  it("opens without motion preferences when matchMedia is unavailable", async () => {
    Object.defineProperty(window, "matchMedia", { value: undefined, configurable: true });
    await openDialog();

    const root = document.getElementById("app");
    expect(root?.classList.contains("ready")).toBe(true);
    expect(root?.classList.contains("pre-animate")).toBe(false);
    expect(document.activeElement).toBe(root);
  });

  it("opens when reading motion preferences throws", async () => {
    Object.defineProperty(window, "matchMedia", {
      value: () => {
        throw new Error("motion preference unavailable");
      },
      configurable: true,
    });
    await openDialog();

    const root = document.getElementById("app");
    expect(root?.classList.contains("ready")).toBe(true);
    expect(root?.classList.contains("pre-animate")).toBe(false);
    expect(document.activeElement).toBe(root);
  });

  it("reveals motion-enabled content after sizing and two animation frames", async () => {
    enableMotion();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(280);
    await openDialog();

    const root = document.getElementById("app");
    expect(mockSetHeight).not.toHaveBeenCalled();
    expect(root?.classList.contains("pre-animate")).toBe(true);
    frames.shift()?.(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSetHeight).toHaveBeenCalledWith(1, 280);
    expect(root?.classList.contains("ready")).toBe(false);

    frames.shift()?.(16);
    expect(root?.classList.contains("ready")).toBe(false);
    frames.shift()?.(32);
    expect(root?.classList.contains("ready")).toBe(true);
    expect(root?.classList.contains("pre-animate")).toBe(false);
  });

  it("reveals a motion-enabled dialog if animation frames stop arriving", async () => {
    enableMotion();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    await openDialog();
    frames.shift()?.(0);
    await vi.advanceTimersByTimeAsync(0);

    const root = document.getElementById("app");
    expect(root?.classList.contains("pre-animate")).toBe(true);
    await vi.advanceTimersByTimeAsync(399);
    expect(root?.classList.contains("ready")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(root?.classList.contains("ready")).toBe(true);
    expect(root?.classList.contains("pre-animate")).toBe(false);
  });

  it("sizes and reveals without requestAnimationFrame support", async () => {
    enableMotion();
    vi.stubGlobal("requestAnimationFrame", undefined);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(276);
    await openDialog();

    expect(mockSetHeight).toHaveBeenCalledWith(1, 276);
    expect(document.getElementById("app")?.classList.contains("ready")).toBe(true);
    expect(document.activeElement).toBe(document.getElementById("app"));
  });

  it("reveals the shell and declines the live presentation if action markup is missing", async () => {
    document.getElementById("dialog-actions")?.remove();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetPayload.mockResolvedValue({ ...choicePayload, presentationId: 7, cancelId: 1 });
    await openDialog();

    const root = document.getElementById("app");
    expect(console.error).toHaveBeenCalledWith(
      "[utility-dialog] bootstrap failed:",
      expect.objectContaining({ message: "[utility-dialog] Missing element #dialog-actions" }),
    );
    expect(root?.classList.contains("ready")).toBe(true);
    expect(root?.classList.contains("pre-animate")).toBe(false);
    expect(mockOnApply).not.toHaveBeenCalled();
    expect(mockRespond).toHaveBeenCalledExactlyOnceWith(7, 1);
  });

  it("declines nothing after a bootstrap failure when no presentation is live", async () => {
    document.getElementById("dialog-message")?.remove();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetPayload.mockRejectedValue(new Error("[utility-dialog] No active dialog payload"));
    await openDialog();

    expect(console.error).toHaveBeenCalledWith(
      "[utility-dialog] bootstrap failed:",
      expect.objectContaining({ message: "[utility-dialog] Missing element #dialog-message" }),
    );
    expect(mockRespond).not.toHaveBeenCalled();
  });

  it("declines an unrenderable dialog when the root is missing", async () => {
    document.getElementById("app")?.remove();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockRespond.mockRejectedValue(new Error("preload unavailable"));
    await openDialog();

    expect(console.error).toHaveBeenCalledWith(
      "[utility-dialog] bootstrap failed:",
      expect.objectContaining({ message: "[utility-dialog] Missing element #app" }),
    );
    expect(document.getElementById("app")).toBeNull();
    expect(mockRespond).toHaveBeenCalledExactlyOnceWith(1, 0);
  });

  it("survives a bootstrap failure when the preload bridge is missing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    Reflect.deleteProperty(window, "utilityDialogApi");
    await openDialog();

    expect(console.error).toHaveBeenCalledWith(
      "[utility-dialog] bootstrap failed:",
      expect.any(TypeError),
    );
    expect(requireRoot().classList.contains("ready")).toBe(true);
    expect(mockRespond).not.toHaveBeenCalled();
  });

  describe("presentation lifetimes", () => {
    it("ignores a stale initial payload read that settles after a newer presentation", async () => {
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(280);
      const initialRead = Promise.withResolvers<UtilityDialogPayload>();
      mockGetPayload.mockReturnValue(initialRead.promise);
      await openDialog();

      present({ ...choicePayload, presentationId: 2, message: "Newer request" });
      await vi.advanceTimersByTimeAsync(400);
      const buttons = actionButtons();
      initialRead.resolve({ ...samplePayload, message: "Older request" });
      await vi.advanceTimersByTimeAsync(400);

      expect(document.getElementById("dialog-message")?.textContent).toBe("Newer request");
      expect(actionButtons()).toEqual(buttons);
      expect(mockSetHeight.mock.calls.map(([id]) => id)).toEqual([2]);
      buttons[1]?.click();
      expect(mockRespond).toHaveBeenCalledExactlyOnceWith(2, 1);
    });

    it("ignores an initial payload read for a presentation main already retired", async () => {
      const initialRead = Promise.withResolvers<UtilityDialogPayload>();
      mockGetPayload.mockReturnValue(initialRead.promise);
      await openDialog();

      retire(1);
      initialRead.resolve(choicePayload);
      await vi.advanceTimersByTimeAsync(400);

      expect(document.getElementById("dialog-message")?.textContent).toBe("");
      expect(actionButtons()).toHaveLength(0);
      expect(pressKey("Escape").defaultPrevented).toBe(false);
      expect(mockRespond).not.toHaveBeenCalled();
      expect(mockSetHeight).not.toHaveBeenCalled();
    });

    it("does not rebuild, refocus, re-measure, or re-arm on duplicate deliveries", async () => {
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(280);
      mockGetPayload.mockResolvedValue(choicePayload);
      await openDialog();
      const buttons = actionButtons();
      buttons[0]?.focus();

      present(choicePayload);
      expect(actionButtons()).toEqual(buttons);
      expect(document.activeElement).toBe(buttons[0]);
      buttons[1]?.click();
      present({ ...choicePayload, message: "Duplicate with new text" });
      expect(document.getElementById("dialog-message")?.textContent).toBe(choicePayload.message);
      pressKey("Escape");
      buttons[0]?.click();

      expect(mockRespond).toHaveBeenCalledExactlyOnceWith(1, 1);
      expect(mockSetHeight).toHaveBeenCalledOnce();
    });

    it("keeps a retired presentation's controls and keys from responding", async () => {
      mockGetPayload.mockResolvedValue(choicePayload);
      await openDialog();
      const staleButtons = actionButtons();

      retire(1);
      staleButtons[1]?.click();
      expect(pressKey("Escape").defaultPrevented).toBe(false);
      expect(pressKey("Enter").defaultPrevented).toBe(false);
      expect(mockRespond).not.toHaveBeenCalled();
      // Older retirements and presents cannot resurrect it.
      retire(0);
      present(choicePayload);
      staleButtons[0]?.click();
      expect(mockRespond).not.toHaveBeenCalled();

      present({ ...choicePayload, presentationId: 2 });
      staleButtons[1]?.click();
      expect(mockRespond).not.toHaveBeenCalled();
      actionButtons()[0]?.click();
      expect(mockRespond).toHaveBeenCalledExactlyOnceWith(2, 0);
    });

    it("lets a later retirement supersede a presentation the renderer never saw", async () => {
      mockGetPayload.mockResolvedValue(choicePayload);
      await openDialog();

      retire(3);
      present({ ...choicePayload, presentationId: 2, message: "Already dismissed" });
      expect(document.getElementById("dialog-message")?.textContent).toBe(choicePayload.message);
      expect(pressKey("Escape").defaultPrevented).toBe(false);
      expect(mockRespond).not.toHaveBeenCalled();
    });

    it("never lets a late height settlement reveal the next presentation", async () => {
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(280);
      vi.spyOn(console, "error").mockImplementation(() => {});
      const heights: PromiseWithResolvers<void>[] = [];
      mockSetHeight.mockImplementation(() => {
        const height = Promise.withResolvers<void>();
        heights.push(height);
        return height.promise;
      });
      mockGetPayload.mockResolvedValue(choicePayload);
      await openDialog();
      const root = requireRoot();

      retire(1);
      present({ ...choicePayload, presentationId: 2, message: "Next request" });
      present({ ...choicePayload, presentationId: 2 });
      await vi.advanceTimersByTimeAsync(20);
      expect(mockSetHeight.mock.calls).toEqual([
        [1, 280],
        [2, 280],
      ]);

      heights[0]?.resolve();
      await vi.advanceTimersByTimeAsync(400);
      expect(root.classList.contains("ready")).toBe(false);
      expect(root.classList.contains("pre-animate")).toBe(true);

      retire(2);
      present({ ...choicePayload, presentationId: 3 });
      heights[1]?.reject(new Error("window resized away"));
      await vi.advanceTimersByTimeAsync(400);
      expect(root.classList.contains("ready")).toBe(false);
      expect(console.error).toHaveBeenCalledWith(
        "[utility-dialog] setHeight failed:",
        expect.any(Error),
      );

      heights[2]?.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(root.classList.contains("ready")).toBe(true);
    });

    it("skips measuring a presentation retired before its frame runs", async () => {
      const frames = captureAnimationFrames();
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(280);
      mockGetPayload.mockResolvedValue(choicePayload);
      await openDialog();

      retire(1);
      frames.runAll();
      await vi.advanceTimersByTimeAsync(400);
      expect(mockSetHeight).not.toHaveBeenCalled();
      expect(requireRoot().classList.contains("ready")).toBe(false);
    });

    it("never lets a dismissed presentation's open animation reveal the next one", async () => {
      enableMotion();
      const frames = captureAnimationFrames();
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(280);
      mockGetPayload.mockResolvedValue(choicePayload);
      await openDialog();
      const root = requireRoot();

      frames.runAll();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockSetHeight).toHaveBeenCalledExactlyOnceWith(1, 280);
      const firstAnimationFrames = [...frames.pending.keys()];
      expect(firstAnimationFrames).toHaveLength(1);

      retire(1);
      present({ ...choicePayload, presentationId: 2 });
      const secondMeasureFrames = [...frames.pending.keys()].filter(
        (id) => !firstAnimationFrames.includes(id),
      );
      for (const id of firstAnimationFrames) frames.run(id);
      for (const id of [...frames.pending.keys()]) {
        if (!secondMeasureFrames.includes(id)) frames.run(id);
      }
      await vi.advanceTimersByTimeAsync(400);
      expect(root.classList.contains("ready")).toBe(false);
      expect(root.classList.contains("pre-animate")).toBe(true);

      frames.runAll();
      await vi.advanceTimersByTimeAsync(0);
      expect(mockSetHeight.mock.calls).toEqual([
        [1, 280],
        [2, 280],
      ]);
      frames.runAll();
      frames.runAll();
      expect(root.classList.contains("ready")).toBe(true);
    });

    it("disposes subscriptions, aurora pause, keys, and scheduled work only on actual unload", async () => {
      enableMotion();
      const frames = captureAnimationFrames();
      const unsubscribe = vi.fn();
      mockOnApply.mockImplementation(() => unsubscribe);
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(280);
      mockGetPayload.mockResolvedValue(choicePayload);
      await openDialog();
      const root = requireRoot();
      const stage = document.querySelector(".icon-aurora-stage");
      frames.runAll();
      await vi.advanceTimersByTimeAsync(0);
      expect(frames.pending.size).toBe(1);

      // Warm hide (window.hide → visibilitychange) keeps everything wired.
      setDocumentVisibility("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      expect(stage?.classList.contains("is-paused")).toBe(true);
      setDocumentVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      expect(stage?.classList.contains("is-paused")).toBe(false);
      window.dispatchEvent(new nativeWindow.PageTransitionEvent("pagehide", { persisted: true }));
      expect(unsubscribe).not.toHaveBeenCalled();

      const pendingFrames = [...frames.pending.keys()];
      window.dispatchEvent(new nativeWindow.PageTransitionEvent("pagehide", { persisted: false }));
      window.dispatchEvent(new nativeWindow.PageTransitionEvent("pagehide", { persisted: false }));
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(frames.cancel.mock.calls.map(([id]) => id)).toEqual(pendingFrames);

      setDocumentVisibility("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      expect(stage?.classList.contains("is-paused")).toBe(false);
      expect(pressKey("Escape").defaultPrevented).toBe(false);
      actionButtons()[1]?.click();
      await vi.advanceTimersByTimeAsync(400);
      expect(root.classList.contains("ready")).toBe(false);
      expect(mockRespond).not.toHaveBeenCalled();
    });

    it("drops a payload read and height reply that settle after unload", async () => {
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(280);
      const initialRead = Promise.withResolvers<UtilityDialogPayload>();
      mockGetPayload.mockReturnValueOnce(initialRead.promise);
      const height = Promise.withResolvers<void>();
      mockSetHeight.mockReturnValueOnce(height.promise);
      await openDialog();

      present(choicePayload);
      window.dispatchEvent(new nativeWindow.PageTransitionEvent("pagehide", { persisted: false }));
      initialRead.resolve({ ...choicePayload, presentationId: 2, message: "After unload" });
      height.resolve();
      await vi.advanceTimersByTimeAsync(400);

      expect(document.getElementById("dialog-message")?.textContent).toBe(choicePayload.message);
      expect(requireRoot().classList.contains("ready")).toBe(false);
    });
  });
});
