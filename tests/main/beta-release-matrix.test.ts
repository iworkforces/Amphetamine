import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateBetaReleaseMatrix } from "../../scripts/beta-release-matrix.js";

const roots: string[] = [];
const version = "2.0.5";
const beta = "3";
const binaries = [
  "arm64/Amphetamine-2.0.5-arm64-beta-3.dmg",
  "arm64/Amphetamine-2.0.5-arm64-beta-3.zip",
  "x64/Amphetamine-2.0.5-x64-beta-3.dmg",
  "x64/Amphetamine-2.0.5-x64-beta-3.zip",
  "win-x64/Amphetamine-2.0.5-x64-beta-3.exe",
  "win-x64/Amphetamine-2.0.5-x64-portable-beta-3.exe",
  "win-arm64/Amphetamine-2.0.5-arm64-beta-3.exe",
  "win-arm64/Amphetamine-2.0.5-arm64-portable-beta-3.exe",
] as const;

function fixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "beta-matrix-"));
  roots.push(root);
  cpSync("electron-builder.yml", path.join(root, "electron-builder.yml"));
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ version, productName: "Amphetamine" }),
  );
  for (const name of binaries) {
    const location = path.join(root, "artifacts", name);
    mkdirSync(path.dirname(location), { recursive: true });
    writeFileSync(location, `bytes for ${name}`);
  }
  return root;
}

function cli(root: string, sequence = beta) {
  return spawnSync(
    "bun",
    ["run", "scripts/verify-beta-release-matrix.ts", version, sequence, root],
    {
      encoding: "utf8",
    },
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("beta release matrix", () => {
  it("accepts exactly eight binaries and leaves their bytes unchanged", () => {
    const root = fixture();
    const original = binaries.map((name) => readFileSync(path.join(root, "artifacts", name)));

    const result = validateBetaReleaseMatrix(root, version, beta);

    expect(result.errors).toEqual([]);
    expect(result.assets).toHaveLength(8);
    expect(cli(root).status).toBe(0);
    expect(binaries.map((name) => readFileSync(path.join(root, "artifacts", name)))).toEqual(
      original,
    );
  });

  it("accepts macOS names without an architecture segment when basenames remain distinct", () => {
    const root = fixture();
    const before = path.join(root, "artifacts/arm64", path.basename(binaries[0]));
    const after = path.join(root, "artifacts/arm64/Amphetamine-2.0.5-disk-beta-3.dmg");
    const bytes = readFileSync(before);
    rmSync(before);
    writeFileSync(after, bytes);

    expect(validateBetaReleaseMatrix(root, version, beta).errors).toEqual([]);
  });

  it("uses the configured Windows naming templates", () => {
    const root = fixture();
    const configPath = path.join(root, "electron-builder.yml");
    const config = readFileSync(configPath, "utf8");
    writeFileSync(
      configPath,
      config.replace(
        "${productName}-${version}-${arch}-portable.${ext}",
        "${productName}-${version}-portable-${arch}.${ext}",
      ),
    );
    for (const arch of ["x64", "arm64"]) {
      const dir = path.join(root, "artifacts", `win-${arch}`);
      const original = path.join(dir, `Amphetamine-${version}-${arch}-portable-beta-${beta}.exe`);
      const renamed = path.join(dir, `Amphetamine-${version}-portable-${arch}-beta-${beta}.exe`);
      const bytes = readFileSync(original);
      rmSync(original);
      writeFileSync(renamed, bytes);
    }

    expect(validateBetaReleaseMatrix(root, version, beta).errors).toEqual([]);
  });

  it("rejects a configured target missing from an architecture", () => {
    const root = fixture();
    const configPath = path.join(root, "electron-builder.yml");
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace(
        "    - target: portable\n      arch:\n        - x64\n        - arm64",
        "    - target: portable\n      arch:\n        - x64",
      ),
    );

    expect(validateBetaReleaseMatrix(root, version, beta).errors.join("\n")).toContain(
      "configured win/arm64 targets nsis; expected nsis, portable",
    );
  });

  it("rejects a commented architecture even when all eight binaries exist", () => {
    const root = fixture();
    const configPath = path.join(root, "electron-builder.yml");
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace(
        "    - target: portable\n      arch:\n        - x64\n        - arm64",
        "    - target: portable\n      arch:\n        - x64\n        # - arm64",
      ),
    );

    expect(validateBetaReleaseMatrix(root, version, beta).errors.join("\n")).toContain(
      "configured win/arm64 targets nsis; expected nsis, portable",
    );
    expect(cli(root).status).toBe(1);
  });

  it.each(binaries)("rejects a missing target when %s is absent", (name) => {
    const root = fixture();
    rmSync(path.join(root, "artifacts", name));

    expect(validateBetaReleaseMatrix(root, version, beta).errors.join("\n")).toContain(
      `missing ${name.endsWith(".dmg") ? "dmg" : name.endsWith(".zip") ? "zip" : name.includes("portable") ? "portable" : "nsis"} package`,
    );
  });

  it("rejects an absent architecture directory", () => {
    const root = fixture();
    rmSync(path.join(root, "artifacts/win-arm64"), { recursive: true });

    expect(cli(root).stderr).toContain("artifacts/win-arm64");
    expect(cli(root).status).toBe(1);
  });

  it.each([
    ["arm64/Amphetamine-9.0.0-arm64-beta-3.dmg", "version"],
    ["x64/Amphetamine-2.0.5-x64-beta-4.zip", "missing zip"],
    ["win-x64/Amphetamine-9.0.0-x64-beta-3.exe", "unexpected publishable"],
    ["win-arm64/Amphetamine-2.0.5-arm64-portable-beta-4.exe", "missing portable"],
  ])("rejects incorrect identity %s", (renamed, diagnostic) => {
    const root = fixture();
    const original = binaries.find(
      (name) =>
        name.split("/")[0] === renamed.split("/")[0] &&
        name.endsWith(path.extname(renamed)) &&
        name.includes("portable") === renamed.includes("portable"),
    );
    expect(original).toBeDefined();
    if (original === undefined) return;
    const source = path.join(root, "artifacts", original);
    const destination = path.join(root, "artifacts", renamed);
    const bytes = readFileSync(source);
    rmSync(source);
    writeFileSync(destination, bytes);

    expect(validateBetaReleaseMatrix(root, version, beta).errors.join("\n")).toContain(diagnostic);
  });

  it("rejects a different prepared version or sequence", () => {
    const root = fixture();

    expect(validateBetaReleaseMatrix(root, "9.0.0", beta).errors.join("\n")).toContain(
      "package version",
    );
    expect(cli(root, "4").status).toBe(1);
  });

  it("rejects colliding basenames across architecture directories", () => {
    const root = fixture();
    const old = path.join(root, "artifacts/x64", path.basename(binaries[2]));
    const collision = path.join(root, "artifacts/x64", path.basename(binaries[0]));
    rmSync(old);
    writeFileSync(collision, "collision");

    expect(validateBetaReleaseMatrix(root, version, beta).errors.join("\n")).toContain(
      "basename collision",
    );
  });

  it("rejects empty and non-regular publishable files", () => {
    const root = fixture();
    const empty = path.join(root, "artifacts", binaries[0]);
    const link = path.join(root, "artifacts", binaries[1]);
    rmSync(link);
    symlinkSync(empty, link);
    writeFileSync(empty, "");

    const errors = validateBetaReleaseMatrix(root, version, beta).errors.join("\n");
    expect(errors).toContain("empty file");
    expect(errors).toContain("not a regular file");
  });

  it("rejects extra matching binaries including nested matches in sorted order", () => {
    const root = fixture();
    const extra = path.join(root, "artifacts/x64/extra-beta-3.dmg");
    const nested = path.join(root, "artifacts/arm64/nested/extra-beta-3.zip");
    mkdirSync(path.dirname(nested), { recursive: true });
    writeFileSync(extra, "extra");
    writeFileSync(nested, "nested");

    const errors = validateBetaReleaseMatrix(root, version, beta).errors;
    expect(errors.filter((error) => error.includes("unexpected publishable"))).toHaveLength(2);
    expect(errors).toEqual([...errors].sort());
    expect(cli(root).status).toBe(1);
  });

  it("rejects a publishable file outside the four downloaded directories", () => {
    const root = fixture();
    const location = path.join(root, "artifacts/other/extra-beta-3.exe");
    mkdirSync(path.dirname(location), { recursive: true });
    writeFileSync(location, "extra");

    expect(validateBetaReleaseMatrix(root, version, beta).errors.join("\n")).toContain(
      "unexpected publishable beta artifact outside an architecture directory",
    );
  });

  it("rejects invalid CLI inputs with usage status", () => {
    const result = spawnSync(
      "bun",
      ["run", "scripts/verify-beta-release-matrix.ts", "2.0.5", "bad"],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });
});
