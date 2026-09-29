import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

type BetaAsset = { readonly location: string; readonly name: string };
type BetaMatrix = { readonly errors: readonly string[]; readonly assets: readonly BetaAsset[] };

const ARCHES = [
  { dir: "arm64", platform: "mac", arch: "arm64", targets: ["dmg", "zip"] },
  { dir: "x64", platform: "mac", arch: "x64", targets: ["dmg", "zip"] },
  { dir: "win-x64", platform: "win", arch: "x64", targets: ["nsis", "portable"] },
  { dir: "win-arm64", platform: "win", arch: "arm64", targets: ["nsis", "portable"] },
] as const;

function read(location: string, errors: string[]): string | null {
  try {
    if (!lstatSync(location).isFile()) throw new Error("not a regular file");
    return readFileSync(location, "utf8");
  } catch (error: unknown) {
    errors.push(`${location}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function section(config: string, name: string): string {
  return (
    config.match(
      new RegExp(`^${name}:\\n([\\s\\S]*?)(?=^[a-zA-Z][\\w]*:|$(?![\\s\\S]))`, "m"),
    )?.[1] ?? ""
  );
}

function targets(config: string, platform: string, arch: string): string[] {
  return [
    ...section(config, platform).matchAll(
      /^    - target: ([a-zA-Z]+)\n((?:      .*(?:\n|$)|        .*(?:\n|$))*)/gm,
    ),
  ]
    .filter((match) => {
      const archList = match[2]?.match(/^      arch:\n((?:        .*(?:\n|$))*)/m)?.[1] ?? "";
      return new RegExp(`^        - ${arch}(?:[ \\t]+#.*)?[ \\t]*$`, "m").test(archList);
    })
    .map((match) => match[1] ?? "")
    .sort();
}

function template(config: string, name: string): string | null {
  return section(config, name).match(/^  artifactName: (.+)$/m)?.[1] ?? null;
}

function publishedName(
  pattern: string,
  product: string,
  version: string,
  arch: string,
  beta: string,
): string {
  const name = pattern
    .replaceAll("${productName}", product)
    .replaceAll("${version}", version)
    .replaceAll("${arch}", arch)
    .replaceAll("${ext}", "exe");
  return name.replace(/\.exe$/, `-beta-${beta}.exe`);
}

function inventory(dir: string, errors: string[]): string[] {
  try {
    if (!lstatSync(dir).isDirectory()) throw new Error("not a directory");
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .map((entry) => path.join(entry.parentPath, entry.name))
      .sort();
  } catch (error: unknown) {
    errors.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

export function validateBetaReleaseMatrix(root: string, version: string, beta: string): BetaMatrix {
  const errors: string[] = [];
  const assets: BetaAsset[] = [];
  const config = read(path.join(root, "electron-builder.yml"), errors);
  const packageJson = read(path.join(root, "package.json"), errors);
  if (config === null || packageJson === null) return { errors: errors.sort(), assets };

  let product: string;
  try {
    const parsed: unknown = JSON.parse(packageJson);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      !("productName" in parsed) ||
      typeof parsed.version !== "string" ||
      typeof parsed.productName !== "string"
    )
      throw new Error("missing version/productName");
    if (parsed.version !== version)
      errors.push(`package version ${parsed.version} != prepared ${version}`);
    product = parsed.productName;
  } catch (error: unknown) {
    errors.push(`package.json: ${error instanceof Error ? error.message : String(error)}`);
    return { errors: errors.sort(), assets };
  }

  const winPattern = template(config, "win");
  const portablePattern = template(config, "portable");
  if (winPattern === null || portablePattern === null) {
    errors.push("electron-builder.yml: missing Windows artifactName template");
  }

  const basenames = new Map<string, string>();
  const suffix = new RegExp(`-beta-${beta}\\.(dmg|zip|exe)$`);
  const macPrefix = `${product}-${version}`;
  for (const { dir: label, platform, arch, targets: required } of ARCHES) {
    const dir = path.join(root, "artifacts", label);
    const configured = targets(config, platform, arch);
    if (configured.join(",") !== [...required].sort().join(",")) {
      errors.push(
        `${dir}: configured ${platform}/${arch} targets ${configured.join(", ") || "none"}; expected ${required.join(", ")}`,
      );
    }
    const found = new Map<string, string[]>();
    for (const target of required) found.set(target, []);
    for (const location of inventory(dir, errors)) {
      const name = path.basename(location);
      if (!suffix.test(name)) continue;
      const ext = path.extname(name);
      const target =
        platform === "mac"
          ? ext === ".dmg"
            ? "dmg"
            : ext === ".zip"
              ? "zip"
              : null
          : ext === ".exe" &&
              winPattern !== null &&
              name === publishedName(winPattern, product, version, arch, beta)
            ? "nsis"
            : ext === ".exe" &&
                portablePattern !== null &&
                name === publishedName(portablePattern, product, version, arch, beta)
              ? "portable"
              : null;
      const valid =
        target !== null &&
        path.dirname(location) === dir &&
        (platform !== "mac" ||
          (name.startsWith(`${macPrefix}-`) && name.endsWith(`-beta-${beta}${ext}`)));
      if (!valid) {
        errors.push(
          `${location}: unexpected publishable beta artifact (check version, target, architecture and directory)`,
        );
      } else {
        found.get(target)?.push(location);
      }
      const previous = basenames.get(name);
      if (previous !== undefined) errors.push(`basename collision: ${previous} and ${location}`);
      basenames.set(name, location);
      try {
        const stat = lstatSync(location);
        if (!stat.isFile()) errors.push(`${location}: not a regular file`);
        else if (stat.size === 0) errors.push(`${location}: empty file`);
      } catch (error: unknown) {
        errors.push(`${location}: ${error instanceof Error ? error.message : String(error)}`);
      }
      assets.push({ location, name });
    }
    for (const target of required) {
      const matches = found.get(target) ?? [];
      if (matches.length === 0)
        errors.push(
          `${dir}: missing ${target} package for ${platform}/${arch} (${macPrefix}-*-beta-${beta})`,
        );
      if (matches.length > 1)
        errors.push(`${dir}: multiple ${target} packages: ${matches.join(", ")}`);
    }
  }
  const observed = new Set(assets.map((asset) => asset.location));
  for (const location of inventory(path.join(root, "artifacts"), errors)) {
    if (suffix.test(path.basename(location)) && !observed.has(location)) {
      errors.push(
        `${location}: unexpected publishable beta artifact outside an architecture directory`,
      );
    }
  }
  return { errors: errors.sort(), assets };
}
