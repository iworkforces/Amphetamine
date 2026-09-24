import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { UtilityDialogPayload } from "../../src/shared/utility-dialog.js";

const mockGetPayload = vi.fn<() => Promise<UtilityDialogPayload>>();
const mockRespond = vi.fn<(response: number) => Promise<void>>();
const mockSetHeight = vi.fn<(height: number) => Promise<void>>();
const mockOnApply = vi.fn<(callback: (payload: UtilityDialogPayload) => void) => () => void>();

const samplePayload: UtilityDialogPayload = {
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
const keydownListeners: EventListenerOrEventListenerObject[] = [];

async function openDialog(): Promise<void> {
  vi.resetModules();
  await import("../../src/renderer/utility-dialog/index.js");
  await vi.advanceTimersByTimeAsync(400);
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
    mockGetPayload.mockResolvedValue(samplePayload);
    mockRespond.mockResolvedValue(undefined);
    mockSetHeight.mockResolvedValue(undefined);
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
          if (type === "keydown") keydownListeners.push(listener);
        },
        removeEventListener: nativeWindow.removeEventListener.bind(nativeWindow),
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    for (const listener of keydownListeners) nativeWindow.removeEventListener("keydown", listener);
    keydownListeners.length = 0;
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
    expect(mockSetHeight).toHaveBeenCalledWith(280);
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
    expect(mockRespond).toHaveBeenCalledExactlyOnceWith(index);
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
    expect(mockRespond).toHaveBeenCalledExactlyOnceWith(0);
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
    expect(mockRespond).toHaveBeenCalledExactlyOnceWith(key === "Escape" ? 2 : 1);
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
    expect(mockRespond).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("re-applies an info-only payload after dismissal and resets the response", async () => {
    mockGetPayload.mockResolvedValue(choicePayload);
    await openDialog();
    document.querySelector<HTMLButtonElement>(".dialog-btn-primary")?.click();

    mockOnApply.mock.calls[0]?.[0]({ ...samplePayload, title: "Status", message: "All set" });
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
    expect(mockRespond.mock.calls).toEqual([[1], [0]]);
  });

  it("restores actions and default focus when re-applied after an info-only payload", async () => {
    await openDialog();
    mockOnApply.mock.calls[0]?.[0](choicePayload);
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

    expect(mockSetHeight).toHaveBeenCalledWith(282);
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

    expect(mockSetHeight).toHaveBeenCalledWith(280);
    expect(document.getElementById("app")?.classList.contains("ready")).toBe(true);
    expect(mockRespond).not.toHaveBeenCalled();
  });

  it("waits for an applied payload when the first payload is unavailable", async () => {
    mockGetPayload.mockRejectedValue(new Error("no presentation yet"));
    await openDialog();
    expect(document.getElementById("dialog-message")?.textContent).toBe("");

    mockOnApply.mock.calls[0]?.[0](choicePayload);
    await vi.advanceTimersByTimeAsync(400);
    expect(document.getElementById("dialog-message")?.textContent).toBe(choicePayload.message);
    expect(document.querySelectorAll("#dialog-actions button")).toHaveLength(2);
    expect(document.getElementById("app")?.classList.contains("ready")).toBe(true);
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
    expect(mockRespond).toHaveBeenCalledExactlyOnceWith(0);
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
      expect(mockRespond).toHaveBeenCalledExactlyOnceWith(1);
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
      expect(mockRespond).toHaveBeenCalledExactlyOnceWith(0);
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
    expect(mockRespond).toHaveBeenCalledExactlyOnceWith(1);

    mockOnApply.mock.calls[0]?.[0]({ ...choicePayload, message: "Try again" });
    expect(document.getElementById("dialog-message")?.textContent).toBe("Try again");
    expect(document.activeElement).toBe(document.querySelector(".dialog-btn-primary"));
    document.querySelector<HTMLButtonElement>("#dialog-actions button")?.click();
    expect(mockRespond.mock.calls).toEqual([[1], [0]]);
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
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      value: (query: string) => ({ ...originalMatchMedia(query), matches: false }),
      configurable: true,
    });
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
    expect(mockSetHeight).toHaveBeenCalledWith(280);
    expect(root?.classList.contains("ready")).toBe(false);

    frames.shift()?.(16);
    expect(root?.classList.contains("ready")).toBe(false);
    frames.shift()?.(32);
    expect(root?.classList.contains("ready")).toBe(true);
    expect(root?.classList.contains("pre-animate")).toBe(false);
  });

  it("reveals a motion-enabled dialog if animation frames stop arriving", async () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      value: (query: string) => ({ ...originalMatchMedia(query), matches: false }),
      configurable: true,
    });
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
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      value: (query: string) => ({ ...originalMatchMedia(query), matches: false }),
      configurable: true,
    });
    vi.stubGlobal("requestAnimationFrame", undefined);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(276);
    await openDialog();

    expect(mockSetHeight).toHaveBeenCalledWith(276);
    expect(document.getElementById("app")?.classList.contains("ready")).toBe(true);
    expect(document.activeElement).toBe(document.getElementById("app"));
  });

  it("reveals the shell and declines the dialog if action markup is missing", async () => {
    document.getElementById("dialog-actions")?.remove();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await openDialog();

    const root = document.getElementById("app");
    expect(console.error).toHaveBeenCalledWith(
      "[utility-dialog] bootstrap failed:",
      expect.objectContaining({ message: "[utility-dialog] Missing element #dialog-actions" }),
    );
    expect(root?.classList.contains("ready")).toBe(true);
    expect(root?.classList.contains("pre-animate")).toBe(false);
    expect(mockRespond).toHaveBeenCalledExactlyOnceWith(0);
    expect(mockGetPayload).not.toHaveBeenCalled();
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
    expect(mockRespond).toHaveBeenCalledExactlyOnceWith(0);
    expect(mockGetPayload).not.toHaveBeenCalled();
  });
});
