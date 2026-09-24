import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AboutInfo } from "../../src/shared/types.js";

const mockGetAbout = vi.fn<() => Promise<AboutInfo>>();
const mockClose = vi.fn();
const mockOpen = vi.fn();

const mockApi = {
  app: {
    getAbout: mockGetAbout,
    getVersion: vi.fn().mockResolvedValue("1.0.0"),
    quit: vi.fn(),
  },
  platform: { os: "darwin" as string },
  window: { setHeight: vi.fn() },
  settings: { get: vi.fn(), set: vi.fn(), open: vi.fn() },
  session: { start: vi.fn(), cancel: vi.fn(), getStatus: vi.fn() },
  onSettingsChanged: vi.fn(() => vi.fn()),
  onShortcutRegistrationFailed: vi.fn(() => vi.fn()),
  onWindowHide: vi.fn(() => vi.fn()),
  onSessionStatusUpdate: vi.fn(() => vi.fn()),
  autoUpdater: { checkForUpdates: vi.fn(), onStatus: vi.fn(() => vi.fn()) },
  benchmark: { isEnabled: () => false },
};

function setupDom(): void {
  document.body.innerHTML = `
    <div id="app" class="about" role="dialog" aria-labelledby="product-name">
      <div class="icon-aurora-stage app-icon-stage">
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
        <img id="app-icon" class="app-icon" alt="" draggable="false" role="button" tabindex="0" aria-label="View source on GitHub" />
      </div>
      <h1 id="product-name">Amphetamine</h1>
      <div id="version" class="version"></div>
      <div id="description" class="description"></div>
      <div id="copyright" class="copyright"></div>
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

describe("renderer about", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    setupDom();
    setDocumentVisibility("visible");
    mockGetAbout.mockResolvedValue({
      productName: "Amphetamine",
      version: "1.10.5",
      description: "Keep awake",
      repository: "https://github.com/iworkforces/Amphetamine",
      author: "iworkforces Engineers",
    });
    Object.defineProperty(globalThis, "window", {
      value: {
        ...globalThis.window,
        api: mockApi,
        close: mockClose,
        open: mockOpen,
        matchMedia: (query: string) => ({
          // Exact match so tests can exercise motion-on path when needed.
          matches: query === "(prefers-reduced-motion: reduce)",
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }),
        requestAnimationFrame: (cb: FrameRequestCallback) => {
          cb(0);
          return 0;
        },
        dispatchEvent: globalThis.window.dispatchEvent.bind(globalThis.window),
        addEventListener: globalThis.window.addEventListener.bind(globalThis.window),
        removeEventListener: globalThis.window.removeEventListener.bind(globalThis.window),
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("fills product metadata from getAbout", async () => {
    vi.resetModules();
    await import("../../src/renderer/about/index.js");
    await vi.advanceTimersByTimeAsync(0);

    expect(document.getElementById("product-name")?.textContent).toBe("Amphetamine");
    expect(document.getElementById("version")?.textContent).toBe("Version 1.10.5");
    expect(document.getElementById("description")?.textContent).toBe("Keep awake");
    expect(document.getElementById("copyright")?.textContent).toMatch(
      /Copyright © \d{4} iworkforces Engineers\. All rights reserved\./,
    );
    expect(document.title).toBe("About Amphetamine");
  });

  it("closes on Escape", async () => {
    vi.resetModules();
    await import("../../src/renderer/about/index.js");
    await vi.advanceTimersByTimeAsync(0);

    expect(document.getElementById("close-btn")).toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(mockClose).toHaveBeenCalled();
  });

  it("opens repository when icon is activated", async () => {
    vi.resetModules();
    await import("../../src/renderer/about/index.js");
    await vi.advanceTimersByTimeAsync(0);

    document.getElementById("app-icon")?.click();
    expect(mockOpen).toHaveBeenCalledWith(
      "https://github.com/iworkforces/Amphetamine",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("stays visible when getAbout fails", async () => {
    mockGetAbout.mockRejectedValueOnce(new Error("ipc failed"));
    vi.resetModules();
    await import("../../src/renderer/about/index.js");
    await vi.advanceTimersByTimeAsync(0);

    const root = document.getElementById("app");
    expect(root?.classList.contains("ready") || !root?.classList.contains("pre-animate")).toBe(
      true,
    );
    expect(document.getElementById("version")?.textContent).toBe("Version unknown");
  });

  it("pauses aurora stage when document is hidden and unpauses when visible", async () => {
    vi.resetModules();
    await import("../../src/renderer/about/index.js");
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

  it("mirrors fancy aurora leaf markup (core/blobs/rings/sheen/flare)", async () => {
    vi.resetModules();
    await import("../../src/renderer/about/index.js");
    await vi.advanceTimersByTimeAsync(0);

    const aurora = document.querySelector(".icon-aurora");
    expect(aurora?.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelectorAll(".aurora-blob")).toHaveLength(4);
    expect(document.querySelectorAll(".aurora-ring")).toHaveLength(2);
    expect(document.querySelector(".aurora-sheen")).not.toBeNull();
    expect(document.querySelector(".aurora-flare")).not.toBeNull();
  });
});
