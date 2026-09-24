import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "electron/main";

const mockValidateSenderUrl = vi.hoisted(() => vi.fn());
const mockLogWarn = vi.hoisted(() => vi.fn());

vi.mock("../../src/main/ipc-utils.js", () => ({
  validateSenderUrl: mockValidateSenderUrl,
}));

vi.mock("electron-log", () => ({
  default: { warn: mockLogWarn, info: vi.fn(), error: vi.fn() },
}));

describe("hardenWebContents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("blocks navigation when URL fails validation", async () => {
    mockValidateSenderUrl.mockReturnValue(false);
    const { hardenWebContents } = await import("../../src/main/security.js");
    const preventDefault = vi.fn();
    let navHandler: ((e: { preventDefault: () => void }, url: string) => void) | undefined;
    const win = {
      webContents: {
        on: vi.fn((event: string, cb: typeof navHandler) => {
          if (event === "will-navigate") navHandler = cb;
        }),
        setWindowOpenHandler: vi.fn(),
      },
    };
    hardenWebContents(win as never);
    expect(navHandler).toBeDefined();
    navHandler!({ preventDefault }, "https://evil.com");
    expect(preventDefault).toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalled();
  });

  it("allows navigation when URL passes validation", async () => {
    mockValidateSenderUrl.mockReturnValue(true);
    const { hardenWebContents } = await import("../../src/main/security.js");
    const preventDefault = vi.fn();
    let navHandler: ((e: { preventDefault: () => void }, url: string) => void) | undefined;
    const win = {
      webContents: {
        on: vi.fn((event: string, cb: typeof navHandler) => {
          if (event === "will-navigate") navHandler = cb;
        }),
        setWindowOpenHandler: vi.fn(),
      },
    };
    hardenWebContents(win as never);
    navHandler!({ preventDefault }, "file:///app/index.html");
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("denies window.open", async () => {
    const { hardenWebContents } = await import("../../src/main/security.js");
    let openHandler: (() => { action: string }) | undefined;
    const win = {
      webContents: {
        on: vi.fn(),
        setWindowOpenHandler: vi.fn((cb: typeof openHandler) => {
          openHandler = cb;
        }),
      },
    };
    hardenWebContents(win as never);
    expect(openHandler?.()).toEqual({ action: "deny" });
  });
});

describe("installGlobalWebContentsHardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  function createUnexpectedContents() {
    const contents = {
      on: vi.fn<
        (
          event: string,
          listener: (event: { preventDefault: () => void }, url: string) => void,
        ) => void
      >(),
      setWindowOpenHandler: vi.fn<(listener: () => { action: string }) => void>(),
    };
    const created = vi.mocked(app.on).mock.calls[0]?.[1];
    expect(created).toBeDefined();
    if (created) Reflect.apply(created, app, [{}, contents]);
    return contents;
  }

  it("blocks navigation from unexpected WebContents when the URL is invalid", async () => {
    const invalidUrl = "https://evil.com";
    mockValidateSenderUrl.mockImplementation((url: string) => url === "file:///app/index.html");
    const { installGlobalWebContentsHardening } = await import("../../src/main/security.js");
    installGlobalWebContentsHardening();
    const contents = createUnexpectedContents();
    const preventDefault = vi.fn();

    expect(contents.on).toHaveBeenCalledWith("will-navigate", expect.any(Function));
    contents.on.mock.calls[0]?.[1]({ preventDefault }, invalidUrl);

    expect(mockValidateSenderUrl).toHaveBeenCalledWith(invalidUrl);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(mockLogWarn).toHaveBeenCalledWith("[security] Blocked navigation (global):", invalidUrl);
  });

  it("allows navigation from unexpected WebContents when the URL is valid", async () => {
    const validUrl = "file:///app/index.html";
    mockValidateSenderUrl.mockImplementation((url: string) => url === validUrl);
    const { installGlobalWebContentsHardening } = await import("../../src/main/security.js");
    installGlobalWebContentsHardening();
    const contents = createUnexpectedContents();
    const preventDefault = vi.fn();

    contents.on.mock.calls[0]?.[1]({ preventDefault }, validUrl);

    expect(mockValidateSenderUrl).toHaveBeenCalledWith(validUrl);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("denies window.open from unexpected WebContents", async () => {
    const { installGlobalWebContentsHardening } = await import("../../src/main/security.js");
    installGlobalWebContentsHardening();
    const contents = createUnexpectedContents();

    expect(contents.setWindowOpenHandler).toHaveBeenCalledOnce();
    expect(contents.setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({ action: "deny" });
  });

  it("registers once until an explicit reset permits one new registration", async () => {
    const { installGlobalWebContentsHardening, resetGlobalWebContentsHardeningForTests } =
      await import("../../src/main/security.js");

    installGlobalWebContentsHardening();
    installGlobalWebContentsHardening();
    expect(app.on).toHaveBeenCalledOnce();
    expect(app.on).toHaveBeenCalledWith("web-contents-created", expect.any(Function));

    resetGlobalWebContentsHardeningForTests();
    installGlobalWebContentsHardening();
    installGlobalWebContentsHardening();
    expect(app.on).toHaveBeenCalledTimes(2);
    expect(app.on).toHaveBeenNthCalledWith(2, "web-contents-created", expect.any(Function));
  });
});
