import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFocus = vi.fn();
const mockShow = vi.fn();
const mockClose = vi.fn();
const mockIsDestroyed = vi.fn().mockReturnValue(false);
const mockLoadURL = vi.fn();
const mockLoadFile = vi.fn();
const mockOnce = vi.fn();
const mockOn = vi.fn();
const mockSetWindowOpenHandler = vi.fn();
const mockHarden = vi.fn();
const mockOpenExternal = vi.fn();

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => "/tmp/app",
  },
  BrowserWindow: vi.fn(function (this: Record<string, unknown>) {
    this.focus = mockFocus;
    this.show = mockShow;
    this.close = mockClose;
    this.hide = vi.fn();
    this.destroy = vi.fn();
    this.isDestroyed = mockIsDestroyed;
    this.isVisible = vi.fn().mockReturnValue(false);
    this.loadURL = mockLoadURL;
    this.loadFile = mockLoadFile;
    this.once = mockOnce;
    this.on = mockOn;
    this.webContents = {
      setWindowOpenHandler: mockSetWindowOpenHandler,
      on: vi.fn(),
      executeJavaScript: vi.fn().mockResolvedValue(undefined),
    };
  }),
  nativeImage: {
    createFromPath: vi.fn().mockReturnValue({
      toPNG: vi.fn().mockReturnValue(Buffer.from("png")),
    }),
  },
  shell: { openExternal: mockOpenExternal },
}));

vi.mock("../../src/infrastructure/benchmark/benchmark-env.js", () => ({
  isBenchmarkMode: () => false,
}));

vi.mock("../../src/main/security.js", () => ({
  hardenWebContents: mockHarden,
}));

vi.mock("../../src/main/platform/index.js", () => ({
  aboutWindowChrome: () => ({ skipTaskbar: true }),
  popoverWindowChrome: () => ({ skipTaskbar: true }),
  settingsWindowChrome: () => ({ skipTaskbar: false }),
  utilityDialogWindowChrome: () => ({ skipTaskbar: false, titleBarStyle: "hidden" }),
  appIconFileName: () => "icon.icns",
  isDarwin: () => false,
  enterForegroundMode: vi.fn(),
  enterTrayOnlyMode: vi.fn(),
  setDockIcon: vi.fn(),
  acquireUtilityForeground: vi.fn(),
  releaseUtilityForeground: vi.fn(),
  setUtilityDockIcon: vi.fn(),
  isUtilityForegroundHeld: () => false,
}));

vi.mock("../../src/main/utils/packageInfo.js", () => ({
  getPackageInfo: () => ({
    productName: "Amphetamine",
    version: "1.0.0",
    description: "Keep awake",
    repository: "https://github.com/iworkforces/Amphetamine",
    author: "Test",
  }),
}));

describe("about-window", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockIsDestroyed.mockReturnValue(false);
  });

  it("creates a BrowserWindow with shared secure prefs and preload", async () => {
    const { showAbout } = await import("../../src/main/about-window.js");
    const { BrowserWindow } = await import("electron");
    showAbout();
    expect(BrowserWindow).toHaveBeenCalled();
    expect(mockHarden).toHaveBeenCalled();
    const opts = vi.mocked(BrowserWindow).mock.calls[0]![0] as {
      webPreferences: Record<string, unknown>;
    };
    expect(opts.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    expect(String(opts.webPreferences.preload)).toContain("preload");
    expect(mockLoadURL).toHaveBeenCalledWith(expect.stringContaining("/about.html"));
  });

  it("focuses existing window when not destroyed", async () => {
    const { showAbout } = await import("../../src/main/about-window.js");
    const { BrowserWindow } = await import("electron");
    showAbout();
    const firstCalls = vi.mocked(BrowserWindow).mock.calls.length;
    showAbout();
    expect(mockFocus).toHaveBeenCalled();
    expect(vi.mocked(BrowserWindow).mock.calls.length).toBe(firstCalls);
  });

  it("closeAboutWindow force-destroys open window", async () => {
    const { showAbout, closeAboutWindow } = await import("../../src/main/about-window.js");
    const { BrowserWindow } = await import("electron");
    showAbout();
    closeAboutWindow();
    const instance = vi.mocked(BrowserWindow).mock.results[0]?.value as {
      destroy: ReturnType<typeof vi.fn>;
    };
    expect(instance.destroy).toHaveBeenCalled();
  });

  it("reuses warm-cached About window on second showAbout", async () => {
    mockOnce.mockImplementation((event: string, cb: () => void) => {
      if (event === "ready-to-show") cb();
    });
    const { showAbout } = await import("../../src/main/about-window.js");
    const { BrowserWindow } = await import("electron");
    showAbout();
    const calls = vi.mocked(BrowserWindow).mock.calls.length;
    showAbout();
    expect(vi.mocked(BrowserWindow).mock.calls.length).toBe(calls);
    expect(mockFocus).toHaveBeenCalled();
  });

  it("closeAboutWindow is safe when nothing open", async () => {
    const { closeAboutWindow } = await import("../../src/main/about-window.js");
    expect(() => closeAboutWindow()).not.toThrow();
  });

  it("ready-to-show shows the window", async () => {
    mockOnce.mockImplementation((event: string, cb: () => void) => {
      if (event === "ready-to-show") cb();
    });
    const { showAbout } = await import("../../src/main/about-window.js");
    showAbout();
    expect(mockShow).toHaveBeenCalled();
  });

  it("window open handler opens package repository github URLs only", async () => {
    let openHandler: ((arg: { url: string }) => { action: string }) | undefined;
    mockSetWindowOpenHandler.mockImplementation((cb: typeof openHandler) => {
      openHandler = cb;
    });
    const { showAbout } = await import("../../src/main/about-window.js");
    showAbout();
    const repo = "https://github.com/iworkforces/Amphetamine";
    expect(openHandler?.({ url: repo })).toEqual({ action: "deny" });
    expect(mockOpenExternal).toHaveBeenCalledWith(repo);
    mockOpenExternal.mockClear();
    expect(openHandler?.({ url: "https://github.com/evil/phish" })).toEqual({ action: "deny" });
    expect(mockOpenExternal).not.toHaveBeenCalled();
    expect(openHandler?.({ url: "https://evil.example/x" })).toEqual({ action: "deny" });
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });
});
