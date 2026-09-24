import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { app } from "electron/main";

const windowsPages = ["index", "settings", "about"] as const;
const windowsBase = "file:///C:/Program%20Files/Amphetamine/app.asar/lib/renderer/";
type NavigationListener = (event: { preventDefault: () => void }, url: string) => void;
type NavigationContents = {
  readonly on: Mock<(event: string, listener: NavigationListener) => void>;
  readonly setWindowOpenHandler: Mock;
};

function navigate(contents: NavigationContents, url: string): ReturnType<typeof vi.fn> {
  expect(contents.on).toHaveBeenCalledWith("will-navigate", expect.any(Function));
  const listener = vi.mocked(contents.on).mock.calls[0]?.[1];
  expect(listener).toBeDefined();
  const preventDefault = vi.fn();
  if (listener !== undefined) listener({ preventDefault }, url);
  return preventDefault;
}

describe.each(["window", "global"] as const)(
  "%s will-navigate with real sender validation",
  (scope) => {
    beforeEach(() => {
      vi.resetModules();
      vi.clearAllMocks();
      Reflect.set(app, "isPackaged", false);
      vi.mocked(app.getAppPath).mockReturnValue("/path/to/app.asar");
    });

    afterEach(() => {
      Reflect.set(app, "isPackaged", false);
      vi.mocked(app.getAppPath).mockReturnValue("/path/to/app.asar");
      vi.resetModules();
    });

    async function createContents(): Promise<NavigationContents> {
      const { hardenWebContents, installGlobalWebContentsHardening } =
        await import("../../src/main/security.js");
      const contents = {
        on: vi.fn<(event: string, listener: NavigationListener) => void>(),
        setWindowOpenHandler: vi.fn(),
      };
      if (scope === "window") {
        Reflect.apply(hardenWebContents, undefined, [{ webContents: contents }]);
      } else {
        installGlobalWebContentsHardening();
        expect(app.on).toHaveBeenCalledWith("web-contents-created", expect.any(Function));
        const listener = vi.mocked(app.on).mock.calls[0]?.[1];
        expect(listener).toBeDefined();
        if (listener !== undefined) Reflect.apply(listener, app, [{}, contents]);
      }
      return contents;
    }

    it.each(windowsPages)("allows packaged Windows %s.html", async (page) => {
      Reflect.set(app, "isPackaged", true);
      vi.mocked(app.getAppPath).mockReturnValue("C:\\Program Files\\Amphetamine\\app.asar");
      const contents = await createContents();
      const url = `${windowsBase}${page}.html`;

      expect(navigate(contents, url)).not.toHaveBeenCalled();
    });

    it.each([
      `${windowsBase}utility-dialog.html`,
      `${windowsBase}../index.html`,
      "file://server/share/app.asar/lib/renderer/index.html",
      "file:///%ZZ",
      "https://evil.example/index.html",
      "http://localhost:5173/index.html",
    ])("blocks packaged Windows navigation to %s", async (url) => {
      Reflect.set(app, "isPackaged", true);
      vi.mocked(app.getAppPath).mockReturnValue("C:\\Program Files\\Amphetamine\\app.asar");
      const contents = await createContents();
      const { validateSenderUrl } = await import("../../src/main/ipc-utils.js");

      expect(validateSenderUrl(url)).toBe(false);
      expect(navigate(contents, url)).toHaveBeenCalledOnce();
    });

    it("preserves POSIX packaged navigation", async () => {
      Reflect.set(app, "isPackaged", true);
      const contents = await createContents();

      expect(
        navigate(contents, "file:///path/to/app.asar/lib/renderer/index.html"),
      ).not.toHaveBeenCalled();
      expect(
        navigate(contents, "file:///path/to/app.asar/lib/renderer/utility-dialog.html"),
      ).toHaveBeenCalledOnce();
    });

    it("preserves development origins without allowing other ports", async () => {
      const contents = await createContents();

      expect(navigate(contents, "http://localhost:5173/index.html")).not.toHaveBeenCalled();
      expect(navigate(contents, "http://127.0.0.1:5173/settings.html")).not.toHaveBeenCalled();
      expect(navigate(contents, "http://localhost:3000/index.html")).toHaveBeenCalledOnce();
    });
  },
);
