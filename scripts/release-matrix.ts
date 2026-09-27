import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseLatestYml } from "./merge-latest-yml.js";

type Feed = ReturnType<typeof parseLatestYml>;
type Asset = { readonly location: string; readonly bytes: Buffer };
type Matrix = { readonly errors: readonly string[]; readonly assets: readonly Asset[] };
const ARCHES = [
  { dir: "arm64", platform: "mac", arch: "arm64", feed: "latest-mac.yml" },
  { dir: "x64", platform: "mac", arch: "x64", feed: "latest-mac.yml" },
  { dir: "win-x64", platform: "win", arch: "x64", feed: "latest.yml" },
  { dir: "win-arm64", platform: "win", arch: "arm64", feed: "latest.yml" },
] as const;

function file(location: string, errors: string[]): Buffer | null {
  try {
    if (!lstatSync(location).isFile()) throw new Error("not a regular file");
    return readFileSync(location);
  } catch (error: unknown) {
    errors.push(`${location}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function inventory(dir: string, errors: string[]): string[] {
  try {
    if (!lstatSync(dir).isDirectory()) throw new Error("not a directory");
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .map((entry) => path.join(entry.parentPath, entry.name))
      .sort();
  } catch (error: unknown) {
    errors.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function feedAt(location: string, errors: string[]): Feed | null {
  const bytes = file(location, errors);
  if (bytes === null) return null;
  try {
    return parseLatestYml(bytes.toString("utf8"));
  } catch (error: unknown) {
    errors.push(`${location}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function targets(config: string, platform: "mac" | "win", arch: string): string[] {
  const section =
    config.match(
      new RegExp(`^${platform}:\\n([\\s\\S]*?)(?=^[a-zA-Z][\\w]*:|$(?![\\s\\S]))`, "m"),
    )?.[1] ?? "";
  return [
    ...section.matchAll(/^    - target: ([a-zA-Z]+)\n((?:      .*(?:\n|$)|        .*(?:\n|$))*)/gm),
  ]
    .filter((match) => match[2]?.includes(`- ${arch}`))
    .map((match) => match[1] ?? "");
}

function template(config: string, section: string): string | null {
  const body =
    config.match(
      new RegExp(`^${section}:\\n([\\s\\S]*?)(?=^[a-zA-Z][\\w]*:|$(?![\\s\\S]))`, "m"),
    )?.[1] ?? "";
  return body.match(/^  artifactName: (.+)$/m)?.[1] ?? null;
}

function resolvedName(pattern: string, product: string, version: string, arch: string): string {
  return pattern
    .replaceAll("${productName}", product)
    .replaceAll("${version}", version)
    .replaceAll("${arch}", arch)
    .replaceAll("${ext}", "exe");
}

function safeUrl(url: string): boolean {
  return (
    url.length > 0 &&
    url !== "." &&
    url !== ".." &&
    !/[\\/%?#]/.test(url) &&
    ![...url].some((character) => character.charCodeAt(0) < 32) &&
    path.basename(url) === url
  );
}

function checkFeed(feed: Feed, dir: string, version: string, errors: string[]): void {
  if (feed.version !== version) errors.push(`${dir}: feed version ${feed.version} != ${version}`);
  const seen = new Map<string, { sha512: string; size: number | null }>();
  const top = feed.files.find((entry) => entry.url === feed.path);
  if (top === undefined || top.sha512 !== feed.sha512) {
    errors.push(`${dir}: feed path/sha512 mismatch: ${feed.path}`);
  }
  for (const entry of feed.files) {
    const prior = seen.get(entry.url);
    if (prior !== undefined && (prior.sha512 !== entry.sha512 || prior.size !== entry.size)) {
      errors.push(`${dir}: conflicting duplicate URL ${entry.url}`);
    }
    seen.set(entry.url, entry);
    if (!safeUrl(entry.url)) {
      errors.push(`${dir}: unsafe feed URL ${entry.url}`);
      continue;
    }
    const location = path.join(dir, entry.url);
    const bytes = file(location, errors);
    if (bytes === null) continue;
    if (entry.size === null || entry.size !== bytes.length) {
      errors.push(`${location}: feed size mismatch`);
    }
    const digest = createHash("sha512").update(bytes).digest("base64");
    if (entry.sha512 !== digest) errors.push(`${location}: feed sha512 mismatch`);
  }
}

export function validateReleaseMatrix(root: string, stage: "source" | "staged"): Matrix {
  const errors: string[] = [];
  const assets: Asset[] = [];
  const configBytes = file(path.join(root, "electron-builder.yml"), errors);
  const packageBytes = file(path.join(root, "package.json"), errors);
  if (configBytes === null || packageBytes === null) return { errors: errors.sort(), assets };
  const config = configBytes.toString("utf8");
  let version: string;
  let product: string;
  try {
    const parsed: unknown = JSON.parse(packageBytes.toString("utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      !("productName" in parsed) ||
      typeof parsed.version !== "string" ||
      typeof parsed.productName !== "string"
    )
      throw new Error("missing version/productName");
    version = parsed.version;
    product = parsed.productName;
  } catch (error: unknown) {
    return {
      errors: [`package.json: ${error instanceof Error ? error.message : String(error)}`],
      assets,
    };
  }
  const winPattern = template(config, "win");
  const portablePattern = template(config, "portable");
  if (winPattern === null || portablePattern === null) {
    errors.push("electron-builder.yml: missing target or Windows artifactName configuration");
  }
  const feeds = new Map<string, Feed>();
  if (stage === "staged") {
    for (const name of ["latest-mac.yml", "latest.yml"]) {
      const feed = feedAt(path.join(root, "artifacts/release-staging", name), errors);
      if (feed !== null) feeds.set(name, feed);
    }
  }
  for (const { dir: label, platform, arch, feed: feedName } of ARCHES) {
    const dir = path.join(root, "artifacts", label);
    const files = inventory(dir, errors);
    const feed =
      stage === "source" ? feedAt(path.join(dir, feedName), errors) : feeds.get(feedName);
    const entries =
      feed?.files.filter(
        (entry) => safeUrl(entry.url) && files.includes(path.join(dir, entry.url)),
      ) ?? [];
    if (feed !== undefined && feed !== null) {
      if (stage === "source") checkFeed(feed, dir, version, errors);
      if (entries.length === 0) errors.push(`${dir}: no updater payload in ${feedName}`);
    }
    const targetsForPlatform = targets(config, platform, arch);
    if (targetsForPlatform.length === 0)
      errors.push(`${dir}: no configured ${platform}/${arch} targets`);
    for (const target of targetsForPlatform) {
      const expected =
        platform === "mac"
          ? target === "zip"
            ? entries.filter((entry) => entry.url.endsWith(".zip")).map((entry) => entry.url)
            : files
                .filter((name) => path.extname(name) === `.${target}`)
                .map((name) => path.basename(name))
          : target === "nsis" && winPattern !== null
            ? [resolvedName(winPattern, product, version, arch)]
            : target === "portable" && portablePattern !== null
              ? [resolvedName(portablePattern, product, version, arch)]
              : [];
      if (expected.length === 0 || !expected.some((name) => files.includes(path.join(dir, name)))) {
        errors.push(`${dir}: missing ${target} package`);
      }
    }
    const updater = platform === "mac" ? "zip" : "exe";
    const payloads = entries.filter(
      (entry) =>
        path.extname(entry.url) === `.${updater}` &&
        (platform === "mac" ||
          (winPattern !== null && entry.url === resolvedName(winPattern, product, version, arch))),
    );
    if (payloads.length === 0) errors.push(`${dir}: missing ${updater} updater payload`);
    for (const entry of payloads) {
      const blockmap = path.join(dir, `${entry.url}.blockmap`);
      if (!files.includes(blockmap)) errors.push(`${blockmap}: missing updater blockmap`);
    }
    for (const location of files) {
      if (
        !/\.(dmg|zip|exe|blockmap)$/i.test(location) &&
        !path.basename(location).includes(".blockmap")
      )
        continue;
      const bytes = file(location, errors);
      if (bytes !== null) assets.push({ location, bytes });
    }
  }
  const basenames = new Map<string, string>();
  for (const asset of assets) {
    const name = path.basename(asset.location);
    const prior = basenames.get(name);
    if (prior !== undefined) errors.push(`basename collision: ${prior} and ${asset.location}`);
    basenames.set(name, asset.location);
  }
  if (stage === "staged") {
    const dir = path.join(root, "artifacts/release-staging");
    for (const asset of assets) {
      const staged = file(path.join(dir, path.basename(asset.location)), errors);
      if (staged !== null && !staged.equals(asset.bytes))
        errors.push(`${asset.location}: staged bytes differ`);
    }
    for (const [name, feed] of feeds) {
      if (feed.version !== version)
        errors.push(`${name}: feed version ${feed.version} != ${version}`);
      checkFeed(feed, dir, version, errors);
      for (const { dir: label, feed: expectedFeed } of ARCHES) {
        if (name !== expectedFeed) continue;
        const source = path.join(root, "artifacts", label);
        if (
          !feed.files.some(
            (entry) =>
              safeUrl(entry.url) &&
              assets.some(
                (asset) =>
                  asset.location === path.join(source, entry.url) &&
                  createHash("sha512").update(asset.bytes).digest("base64") === entry.sha512 &&
                  entry.size === asset.bytes.length,
              ),
          )
        ) {
          errors.push(`${name}: missing ${label} updater entry`);
        }
      }
    }
  }
  return { errors: errors.sort(), assets };
}
