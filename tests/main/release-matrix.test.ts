import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergeFeeds, parseLatestYml, serializeLatestYml } from "../../scripts/merge-latest-yml.js";
import { validateReleaseMatrix } from "../../scripts/release-matrix.js";

const roots: string[] = [];
const version = "2.0.0";
const names = {
  arm64: { zip: "custom-arm64.zip", dmg: "disk-arm64.dmg" },
  x64: { zip: "custom-x64.zip", dmg: "disk-x64.dmg" },
} as const;

function put(root: string, location: string, bytes: string): void {
  const destination = path.join(root, location);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
}

function feed(name: string, bytes: Buffer): string {
  const sha = createHash("sha512").update(bytes).digest("base64");
  return `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha}\n    size: ${bytes.length}\npath: ${name}\nsha512: ${sha}\nreleaseDate: '2026-07-31T00:00:00.000Z'\n`;
}

function fixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "release-matrix-"));
  roots.push(root);
  cpSync("electron-builder.yml", path.join(root, "electron-builder.yml"));
  put(root, "package.json", JSON.stringify({ version, productName: "Amphetamine" }));
  for (const arch of ["arm64", "x64"] as const) {
    const dir = `artifacts/${arch}`;
    put(root, `${dir}/${names[arch].dmg}`, `${arch} disk`);
    put(root, `${dir}/${names[arch].zip}`, `${arch} zip`);
    put(root, `${dir}/${names[arch].zip}.blockmap`, `${arch} map`);
    put(
      root,
      `${dir}/latest-mac.yml`,
      feed(names[arch].zip, readFileSync(path.join(root, dir, names[arch].zip))),
    );
  }
  for (const arch of ["x64", "arm64"] as const) {
    const dir = `artifacts/win-${arch}`;
    const installer = `Amphetamine-${version}-${arch}.exe`;
    put(root, `${dir}/${installer}`, `${arch} installer`);
    put(root, `${dir}/${installer}.blockmap`, `${arch} map`);
    put(root, `${dir}/Amphetamine-${version}-${arch}-portable.exe`, `${arch} portable`);
    put(root, `${dir}/latest.yml`, feed(installer, readFileSync(path.join(root, dir, installer))));
  }
  return root;
}

function stage(root: string): void {
  const source = validateReleaseMatrix(root, "source");
  for (const asset of source.assets)
    put(root, `artifacts/release-staging/${path.basename(asset.location)}`, asset.bytes.toString());
  for (const [name, dirs] of [
    ["latest-mac.yml", ["arm64", "x64"]],
    ["latest.yml", ["win-x64", "win-arm64"]],
  ] as const) {
    const feeds = dirs.map((dir) =>
      parseLatestYml(readFileSync(path.join(root, "artifacts", dir, name), "utf8")),
    );
    put(root, `artifacts/release-staging/${name}`, serializeLatestYml(mergeFeeds(feeds)));
    for (const dir of dirs) rmSync(path.join(root, "artifacts", dir, name));
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("release matrix CLI", () => {
  it("accepts a complete source and flattened staged release without changing source bytes", () => {
    const root = fixture();
    const original = readFileSync(path.join(root, "artifacts/arm64/latest-mac.yml"));
    const cli = spawnSync("bun", ["run", "scripts/verify-release-matrix.ts", "source", root], {
      encoding: "utf8",
    });
    expect(cli.status).toBe(0);
    expect(readFileSync(path.join(root, "artifacts/arm64/latest-mac.yml"))).toEqual(original);
    stage(root);
    const staged = readFileSync(path.join(root, "artifacts/release-staging/latest.yml"));
    const check = spawnSync("bun", ["run", "scripts/verify-release-matrix.ts", "staged", root], {
      encoding: "utf8",
    });
    expect(check.status).toBe(0);
    expect(readFileSync(path.join(root, "artifacts/release-staging/latest.yml"))).toEqual(staged);
  });

  it.each([
    ["artifacts/arm64/disk-arm64.dmg", "missing dmg"],
    ["artifacts/x64/custom-x64.zip", "missing zip"],
    [`artifacts/win-x64/Amphetamine-${version}-x64.exe`, "missing nsis"],
    [`artifacts/win-arm64/Amphetamine-${version}-arm64-portable.exe`, "missing portable"],
    ["artifacts/arm64/latest-mac.yml", "latest-mac.yml"],
    ["artifacts/win-arm64/latest.yml", "latest.yml"],
    ["artifacts/x64/custom-x64.zip.blockmap", "missing updater blockmap"],
    [`artifacts/win-x64/Amphetamine-${version}-x64.exe.blockmap`, "missing updater blockmap"],
  ])("rejects missing %s", (location, expected) => {
    const root = fixture();
    rmSync(path.join(root, location));
    expect(validateReleaseMatrix(root, "source").errors.join("\n")).toContain(expected);
  });

  it("rejects an absent architecture directory through the CLI without changing other inputs", () => {
    const root = fixture();
    const original = readFileSync(path.join(root, "artifacts/arm64/latest-mac.yml"));
    rmSync(path.join(root, "artifacts/win-arm64"), { recursive: true });
    const cli = spawnSync("bun", ["run", "scripts/verify-release-matrix.ts", "source", root], {
      encoding: "utf8",
    });
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain("artifacts/win-arm64");
    expect(readFileSync(path.join(root, "artifacts/arm64/latest-mac.yml"))).toEqual(original);
  });

  it("reports version, size, checksum, traversal and conflicting duplicate URLs together in sorted order", () => {
    const root = fixture();
    const location = "artifacts/arm64/latest-mac.yml";
    const original = readFileSync(path.join(root, location), "utf8");
    const corrupted = original
      .replace("version: 2.0.0", "version: 9.0.0")
      .replace(/size: \d+/, "size: 999")
      .replace(/sha512: [^\n]+/, "sha512: wrong")
      .replace(
        "path:",
        "  - url: ../escape.zip\n    sha512: wrong\n    size: 1\n  - url: custom-arm64.zip\n    sha512: other\n    size: 1\npath:",
      );
    put(root, location, corrupted);
    const before = readFileSync(path.join(root, location));
    const first = validateReleaseMatrix(root, "source").errors;
    expect(first.join("\n")).toMatch(
      /version|size|sha512|unsafe feed URL|conflicting duplicate URL/,
    );
    for (const keyword of [
      "version",
      "size",
      "sha512",
      "unsafe feed URL",
      "conflicting duplicate URL",
    ]) {
      expect(first.join("\n")).toContain(keyword);
    }
    expect(first).toEqual([...first].sort());
    expect(validateReleaseMatrix(root, "source").errors).toEqual(first);
    expect(readFileSync(path.join(root, location))).toEqual(before);
    expect(
      spawnSync("bun", ["run", "scripts/verify-release-matrix.ts", "source", root]).status,
    ).toBe(1);
  });

  it("rejects publishable basename collisions rather than trusting staging's skip behavior", () => {
    const root = fixture();
    put(root, "artifacts/x64/disk-arm64.dmg", "different disk");
    expect(validateReleaseMatrix(root, "source").errors.join("\n")).toContain("basename collision");
  });

  it("rejects colliding blockmap-suffixed assets through the source CLI", () => {
    const root = fixture();
    const name = "same.basename.blockmap.extra";
    put(root, `artifacts/arm64/${name}`, "arm64 bytes");
    put(root, `artifacts/x64/${name}`, "x64 bytes");
    const cli = spawnSync("bun", ["run", "scripts/verify-release-matrix.ts", "source", root], {
      encoding: "utf8",
    });
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain("basename collision");
  });

  it("rejects changed staged bytes for a blockmap name with another suffix", () => {
    const root = fixture();
    const name = "same.basename.blockmap.extra";
    put(root, `artifacts/arm64/${name}`, "source bytes");
    stage(root);
    put(root, `artifacts/release-staging/${name}`, "changed bytes");
    expect(validateReleaseMatrix(root, "staged").errors.join("\n")).toContain("staged bytes differ");
  });

  it("rejects missing merged architecture entries and staged bytes", () => {
    const root = fixture();
    stage(root);
    const merged = path.join(root, "artifacts/release-staging/latest-mac.yml");
    put(
      root,
      "artifacts/release-staging/latest-mac.yml",
      serializeLatestYml(
        mergeFeeds([
          parseLatestYml(
            feed(
              names.arm64.zip,
              readFileSync(path.join(root, "artifacts/arm64", names.arm64.zip)),
            ),
          ),
        ]),
      ),
    );
    put(root, `artifacts/release-staging/${names.x64.dmg}`, "different bytes");
    rmSync(path.join(root, `artifacts/release-staging/${names.arm64.zip}.blockmap`));
    const before = readFileSync(merged);
    const errors = validateReleaseMatrix(root, "staged").errors.join("\n");
    expect(errors).toContain("missing x64 updater entry");
    expect(errors).toContain("staged bytes differ");
    expect(errors).toContain("blockmap");
    expect(readFileSync(merged)).toEqual(before);
  });

  it("rejects a lost Windows architecture entry through the staged CLI", () => {
    const root = fixture();
    stage(root);
    const installer = `Amphetamine-${version}-x64.exe`;
    const merged = path.join(root, "artifacts/release-staging/latest.yml");
    put(
      root,
      "artifacts/release-staging/latest.yml",
      feed(installer, readFileSync(path.join(root, "artifacts/win-x64", installer))),
    );
    const original = readFileSync(merged);
    const cli = spawnSync("bun", ["run", "scripts/verify-release-matrix.ts", "staged", root], {
      encoding: "utf8",
    });
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain("missing win-arm64 updater entry");
    expect(readFileSync(merged)).toEqual(original);
  });

  it("rejects a staged feed with incorrect recorded bytes", () => {
    const root = fixture();
    stage(root);
    const location = "artifacts/release-staging/latest-mac.yml";
    const original = readFileSync(path.join(root, location), "utf8");
    put(root, location, original.replace(/size: \d+/, "size: 999"));
    const errors = validateReleaseMatrix(root, "staged").errors.join("\n");
    expect(errors).toContain("feed size mismatch");
  });

  it("returns usage status for an unknown CLI mode", () => {
    const cli = spawnSync("bun", ["run", "scripts/verify-release-matrix.ts", "unknown"], {
      encoding: "utf8",
    });
    expect(cli.status).toBe(2);
    expect(cli.stderr).toContain("Usage:");
  });
});
