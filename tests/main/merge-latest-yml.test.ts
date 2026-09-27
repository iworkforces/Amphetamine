import { describe, it, expect } from "vitest";
import { parseLatestYml, mergeFeeds, serializeLatestYml } from "../../scripts/merge-latest-yml.js";

const ARM64 = `version: 1.10.2
files:
  - url: Amphetamine-1.10.2-arm64-mac.zip
    sha512: aaa
    size: 100
path: Amphetamine-1.10.2-arm64-mac.zip
sha512: aaa
releaseDate: '2026-07-31T00:00:00.000Z'
`;

const X64 = `version: 1.10.2
files:
  - url: Amphetamine-1.10.2-mac.zip
    sha512: bbb
    size: 200
path: Amphetamine-1.10.2-mac.zip
sha512: bbb
releaseDate: '2026-07-31T00:00:00.000Z'
`;

describe("merge-latest-yml", () => {
  it("parses electron-builder feed shape", () => {
    const feed = parseLatestYml(ARM64);
    expect(feed.version).toBe("1.10.2");
    expect(feed.files).toHaveLength(1);
    expect(feed.files[0]?.url).toBe("Amphetamine-1.10.2-arm64-mac.zip");
    expect(feed.files[0]?.size).toBe(100);
  });

  it("merges dual-arch feeds into one files list", () => {
    const merged = mergeFeeds([parseLatestYml(ARM64), parseLatestYml(X64)]);
    expect(merged.version).toBe("1.10.2");
    expect(merged.files.map((f) => f.url).sort()).toEqual([
      "Amphetamine-1.10.2-arm64-mac.zip",
      "Amphetamine-1.10.2-mac.zip",
    ]);
    // Prefer non-arm64 path as generic entry
    expect(merged.path).toBe("Amphetamine-1.10.2-mac.zip");
    expect(merged.sha512).toBe("bbb");
  });

  it("refuses to merge different versions", () => {
    const other = parseLatestYml(X64.replaceAll("1.10.2", "1.10.3"));
    expect(() => mergeFeeds([parseLatestYml(ARM64), other])).toThrow(/different versions/);
  });

  it("round-trips serialize → parse", () => {
    const merged = mergeFeeds([parseLatestYml(ARM64), parseLatestYml(X64)]);
    const again = parseLatestYml(serializeLatestYml(merged));
    expect(again.files).toHaveLength(2);
    expect(again.version).toBe("1.10.2");
  });

  it.each([
    "files:\n",
    "files: []\n",
    "files: null\n",
    "files:\n  - sha512: aaa\n",
    "files:\n  - url: one\n    size: 10\n",
    "files:\n  - url: one\n    sha512: aaa\n    size: 10\n  - broken\n",
  ])("rejects a present malformed or empty file list: %s", (block) => {
    const raw = ARM64.replace(/files:\n[\s\S]*?(?=path:)/, block);
    expect(() => parseLatestYml(raw)).toThrow(/files|file entry/);
  });

  it.each(["-1", "1.5", "Infinity", "NaN", "1e999", "abc", ""])(
    "rejects invalid explicit size %s",
    (size) => {
      expect(() => parseLatestYml(ARM64.replace("size: 100", `size: ${size}`))).toThrow(/size/);
    },
  );

  it.each(["\n", "\r\n"])("parses quoted scalars with %j line endings", (ending) => {
    const raw = ARM64.replace("version: 1.10.2", 'version: "1.10.2"')
      .replace("url: Amphetamine-1.10.2-arm64-mac.zip", "url: 'Amphetamine-1.10.2-arm64-mac.zip'")
      .replaceAll("sha512: aaa", 'sha512: "aaa"')
      .replace("size: 100", 'size: "100"')
      .replace("path: Amphetamine-1.10.2-arm64-mac.zip", 'path: "Amphetamine-1.10.2-arm64-mac.zip"')
      .replace("releaseDate: '2026-07-31T00:00:00.000Z'", 'releaseDate: "2026-07-31T00:00:00.000Z"')
      .replaceAll("\n", ending);
    const parsed = parseLatestYml(raw);
    expect(parsed.files).toEqual([
      { url: "Amphetamine-1.10.2-arm64-mac.zip", sha512: "aaa", size: 100 },
    ]);
    expect(parsed.releaseDate).toBe("2026-07-31T00:00:00.000Z");
  });

  it("preserves unknown legacy size and resolves it with known metadata", () => {
    const legacy = parseLatestYml(ARM64.replace(/files:\n[\s\S]*?(?=path:)/, ""));
    expect(legacy.files[0]?.size).toBeNull();
    const merged = mergeFeeds([legacy, parseLatestYml(ARM64)]);
    expect(merged.files).toEqual([
      { url: "Amphetamine-1.10.2-arm64-mac.zip", sha512: "aaa", size: 100 },
    ]);
    expect(mergeFeeds([parseLatestYml(ARM64), legacy]).files).toEqual(merged.files);
    expect(serializeLatestYml(mergeFeeds([legacy]))).not.toContain("size:");
    expect(parseLatestYml(serializeLatestYml(mergeFeeds([legacy]))).files[0]?.size).toBeNull();
  });

  it.each([
    ["sha512: aaa", "sha512: other", /sha512|checksum/],
    ["size: 100", "size: 101", /size/],
  ])("rejects conflicting duplicate URL metadata", (original, replacement, error) => {
    const changed = ARM64.replace(original, replacement);
    const other = parseLatestYml(
      original.startsWith("sha512")
        ? changed.replace("sha512: aaa\nreleaseDate", "sha512: other\nreleaseDate")
        : changed,
    );
    expect(() => mergeFeeds([parseLatestYml(ARM64), other])).toThrow(error);
  });

  it("rejects an input whose top-level path or checksum disagrees with its file", () => {
    expect(() =>
      mergeFeeds([
        parseLatestYml(
          ARM64.replace("path: Amphetamine-1.10.2-arm64-mac.zip", "path: missing.zip"),
        ),
      ]),
    ).toThrow(/path/);
    expect(() =>
      mergeFeeds([
        parseLatestYml(ARM64.replace("sha512: aaa\nreleaseDate", "sha512: wrong\nreleaseDate")),
      ]),
    ).toThrow(/sha512|checksum/);
  });

  it("rejects contradictory repeated URLs in a single feed", () => {
    const repeated = ARM64.replace(
      "path:",
      "  - url: Amphetamine-1.10.2-arm64-mac.zip\n    sha512: other\n    size: 100\npath:",
    );
    expect(() => mergeFeeds([parseLatestYml(repeated)])).toThrow(/sha512/);
  });

  it("selects the same generic path, date, and bytes under permutations and ties", () => {
    const alternative = parseLatestYml(
      X64.replaceAll("Amphetamine-1.10.2-mac.zip", "Amphetamine-1.10.2-x64-mac.zip")
        .replaceAll("bbb", "ccc")
        .replace("2026-07-31", "2026-08-01"),
    );
    const arm = parseLatestYml(ARM64);
    const generic = parseLatestYml(X64);
    const genericTie = parseLatestYml(X64.replace("2026-07-31", "2026-08-02"));
    const expected = serializeLatestYml(mergeFeeds([arm, generic, alternative, genericTie]));
    expect(serializeLatestYml(mergeFeeds([alternative, arm, genericTie, generic]))).toBe(expected);
    expect(serializeLatestYml(mergeFeeds([genericTie, generic, alternative, arm]))).toBe(expected);
    expect(parseLatestYml(expected).path).toBe("Amphetamine-1.10.2-mac.zip");
    expect(parseLatestYml(expected).releaseDate).toBe("2026-07-31T00:00:00.000Z");
    const output = parseLatestYml(expected);
    expect(output.files.find((file) => file.url === output.path)?.sha512).toBe(output.sha512);
  });
});
