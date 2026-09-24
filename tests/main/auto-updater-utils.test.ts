import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetPackageInfo = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    repository: "https://github.com/iworkforces/Amphetamine",
  }),
);

vi.mock("../../src/main/utils/packageInfo.js", () => ({
  getPackageInfo: mockGetPackageInfo,
}));

vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("auto-updater-utils", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetPackageInfo.mockReturnValue({
      repository: "https://github.com/iworkforces/Amphetamine",
    });
  });

  it("getReleaseUrlBase derives github releases tag base", async () => {
    const { getReleaseUrlBase } = await import("../../src/main/auto-updater-utils.js");
    expect(getReleaseUrlBase()).toBe(
      "https://github.com/iworkforces/Amphetamine/releases/tag/v",
    );
  });

  it("getReleaseUrlBase returns null for non-github repo", async () => {
    mockGetPackageInfo.mockReturnValue({ repository: "https://gitlab.com/org/repo" });
    const { getReleaseUrlBase } = await import("../../src/main/auto-updater-utils.js");
    expect(getReleaseUrlBase()).toBeNull();
  });

  it("deriveReleaseUrlBase is pure and strips .git", async () => {
    const { deriveReleaseUrlBase } = await import(
      "../../src/infrastructure/updater/auto-updater-utils.js"
    );
    expect(deriveReleaseUrlBase("https://github.com/org/repo.git")).toBe(
      "https://github.com/org/repo/releases/tag/v",
    );
  });

  it("parseGitHubRepoIdentity extracts owner/repo", async () => {
    const { parseGitHubRepoIdentity } = await import(
      "../../src/infrastructure/updater/auto-updater-utils.js"
    );
    expect(parseGitHubRepoIdentity("https://github.com/iworkforces/Amphetamine.git")).toEqual({
      owner: "iworkforces",
      repo: "Amphetamine",
    });
    expect(parseGitHubRepoIdentity("https://gitlab.com/org/repo")).toBeNull();
  });

  it("categorizeUpdaterError classifies network errors", async () => {
    const { categorizeUpdaterError } = await import(
      "../../src/infrastructure/updater/auto-updater-utils.js"
    );
    expect(categorizeUpdaterError(new Error("ENOTFOUND host"))).toBe("network");
    expect(categorizeUpdaterError(new Error("HttpError: 404 Not Found"))).toBe("feed-missing");
    expect(categorizeUpdaterError(new Error("network timeout"))).toBe("network");
    expect(categorizeUpdaterError(new Error("connect ENETUNREACH"))).toBe("network");
    expect(categorizeUpdaterError(new Error("EHOSTUNREACH 1.2.3.4"))).toBe("network");
    expect(categorizeUpdaterError(new Error("read ECONNRESET"))).toBe("network");
    expect(categorizeUpdaterError(new Error("getaddrinfo EAI_AGAIN api.github.com"))).toBe(
      "network",
    );
    expect(categorizeUpdaterError(new Error("net::ERR_INTERNET_DISCONNECTED"))).toBe("network");
    expect(categorizeUpdaterError(new Error("code-signing failed"))).toBe("signature");
    expect(categorizeUpdaterError(new Error("ENOSPC"))).toBe("io");
    expect(categorizeUpdaterError(new Error("mystery"))).toBe("unknown");
  });
});
