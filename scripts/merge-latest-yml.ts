#!/usr/bin/env bun
/**
 * Merge electron-builder `latest*.yml` update feeds from separate arch CI jobs.
 *
 * Dual-arch packaging produces one feed file per job (same basename). GitHub
 * release assets must be unique, so CD must publish a single merged feed with
 * every arch's file entry for electron-updater.
 *
 * Usage:
 *   bun run scripts/merge-latest-yml.ts <a.yml> <b.yml> ... --out <out.yml>
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

type FeedFile = {
  readonly url: string;
  readonly sha512: string;
  readonly size: number | null;
};

type Feed = {
  readonly version: string;
  readonly files: readonly FeedFile[];
  readonly path: string;
  readonly sha512: string;
  readonly releaseDate: string;
};

function usage(): never {
  process.stderr.write("Usage: bun run scripts/merge-latest-yml.ts <yml...> --out <path>\n");
  process.exit(2);
}

function parseArgs(argv: readonly string[]): { inputs: string[]; outPath: string } {
  const inputs: string[] = [];
  let outPath: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      const next = argv[i + 1];
      if (typeof next !== "string" || next.startsWith("--")) usage();
      outPath = next;
      i += 1;
      continue;
    }
    if (arg === undefined || arg.startsWith("--")) usage();
    inputs.push(arg);
  }
  if (inputs.length === 0 || outPath === null) usage();
  return { inputs, outPath };
}

/**
 * Minimal parser for electron-builder latest*.yml (no full YAML dependency).
 * Supports the fixed shape electron-builder emits for GitHub provider feeds.
 */
export function parseLatestYml(raw: string): Feed {
  const scalars = new Map<string, string>();
  const files: FeedFile[] = [];
  let inFiles = false;
  let fileFields = new Map<string, string>();
  const finishFile = (): void => {
    if (fileFields.size === 0) return;
    const url = fileFields.get("url");
    const sha512 = fileFields.get("sha512");
    const sizeRaw = fileFields.get("size");
    if (url === undefined || sha512 === undefined) {
      throw new Error("latest.yml file entry incomplete (url/sha512)");
    }
    if (sizeRaw !== undefined && !/^(0|[1-9][0-9]*)$/.test(sizeRaw)) {
      throw new Error(`latest.yml invalid file size: ${sizeRaw}`);
    }
    const size = sizeRaw === undefined ? null : Number(sizeRaw);
    if (size !== null && !Number.isSafeInteger(size)) {
      throw new Error(`latest.yml invalid file size: ${sizeRaw}`);
    }
    files.push({ url, sha512, size });
    fileFields = new Map<string, string>();
  };

  for (const line of raw.replaceAll("\r\n", "\n").split("\n")) {
    if (line.trim() === "") continue;
    if (line.startsWith("files:")) {
      if (scalars.has("files")) throw new Error("latest.yml duplicate files field");
      if (line !== "files:") throw new Error("latest.yml files must be a nonempty list");
      scalars.set("files", "present");
      inFiles = true;
      continue;
    }
    if (line.startsWith("  ")) {
      if (!inFiles) throw new Error(`latest.yml unexpected file entry: ${line}`);
      const start = line.match(/^  - url: (.+)$/);
      if (start !== null) {
        finishFile();
        fileFields.set("url", parseScalar(start[1] ?? ""));
        continue;
      }
      const field = line.match(/^    (sha512|size): (.+)$/);
      if (field === null || fileFields.size === 0 || fileFields.has(field[1] ?? "")) {
        throw new Error(`latest.yml malformed file entry: ${line}`);
      }
      fileFields.set(field[1] ?? "", parseScalar(field[2] ?? ""));
      continue;
    }
    if (!/^[a-zA-Z][a-zA-Z0-9]*:/.test(line)) {
      throw new Error(`latest.yml malformed field: ${line}`);
    }
    if (inFiles) finishFile();
    inFiles = false;
    const scalar = line.match(/^([a-zA-Z][a-zA-Z0-9]*): (.+)$/);
    if (scalar === null) throw new Error(`latest.yml malformed field: ${line}`);
    const key = scalar[1] ?? "";
    if (scalars.has(key)) throw new Error(`latest.yml duplicate field: ${key}`);
    scalars.set(key, parseScalar(scalar[2] ?? ""));
  }
  finishFile();

  const version = scalars.get("version");
  const pathValue = scalars.get("path");
  const sha512 = scalars.get("sha512");
  const releaseDate = scalars.get("releaseDate");
  if (
    version === undefined ||
    pathValue === undefined ||
    sha512 === undefined ||
    releaseDate === undefined
  ) {
    throw new Error(
      "latest.yml missing required top-level fields (version/path/sha512/releaseDate)",
    );
  }
  if (scalars.has("files") && files.length === 0) {
    throw new Error("latest.yml files must be a nonempty list");
  }
  return {
    version,
    files: files.length > 0 ? files : [{ url: pathValue, sha512, size: null }],
    path: pathValue,
    sha512,
    releaseDate,
  };
}

function parseScalar(raw: string): string {
  const value = raw.trim();
  const quote = value[0];
  const parsed =
    quote === "'" || quote === '"'
      ? value.length >= 2 && value.at(-1) === quote
        ? value.slice(1, -1)
        : ""
      : value;
  if (
    parsed.length === 0 ||
    /[\r\n]/.test(parsed) ||
    (quote !== "'" && quote !== '"' && /['"]/.test(parsed))
  ) {
    throw new Error(`latest.yml invalid scalar: ${raw}`);
  }
  return parsed;
}

export function mergeFeeds(feeds: readonly Feed[]): Feed {
  if (feeds.length === 0) {
    throw new Error("mergeFeeds requires at least one feed");
  }
  const first = feeds[0];
  if (first === undefined) throw new Error("mergeFeeds requires at least one feed");
  const version = first.version;
  for (const feed of feeds) {
    if (feed.version !== version) {
      throw new Error(
        `Refusing to merge feeds with different versions: ${version} vs ${feed.version}`,
      );
    }
    const topFile = feed.files.find((file) => file.url === feed.path);
    if (topFile === undefined) throw new Error(`latest.yml path has no file entry: ${feed.path}`);
    if (topFile.sha512 !== feed.sha512) {
      throw new Error(`latest.yml path/sha512 mismatch: ${feed.path}`);
    }
  }

  const byUrl = new Map<string, FeedFile>();
  for (const feed of feeds) {
    for (const file of feed.files) {
      const existing = byUrl.get(file.url);
      if (existing !== undefined) {
        if (existing.sha512 !== file.sha512) {
          throw new Error(`latest.yml conflicting sha512 for ${file.url}`);
        }
        if (existing.size !== null && file.size !== null && existing.size !== file.size) {
          throw new Error(`latest.yml conflicting size for ${file.url}`);
        }
        byUrl.set(file.url, { ...file, size: existing.size ?? file.size });
      } else {
        byUrl.set(file.url, file);
      }
    }
  }
  const files = [...byUrl.values()].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

  const preferredMeta = [...feeds].sort((a, b) => {
    const armOrder = Number(a.path.includes("arm64")) - Number(b.path.includes("arm64"));
    if (armOrder !== 0) return armOrder;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.releaseDate < b.releaseDate ? -1 : a.releaseDate > b.releaseDate ? 1 : 0;
  })[0];
  if (preferredMeta === undefined) throw new Error("mergeFeeds requires at least one feed");
  const preferredFile = byUrl.get(preferredMeta.path);
  if (preferredFile === undefined) {
    throw new Error(`latest.yml path has no file entry: ${preferredMeta.path}`);
  }

  return {
    version,
    files,
    path: preferredMeta.path,
    sha512: preferredFile.sha512,
    releaseDate: preferredMeta.releaseDate,
  };
}

export function serializeLatestYml(feed: Feed): string {
  const lines: string[] = [];
  lines.push(`version: ${feed.version}`);
  lines.push("files:");
  for (const file of feed.files) {
    lines.push(`  - url: ${file.url}`);
    lines.push(`    sha512: ${file.sha512}`);
    if (file.size !== null) lines.push(`    size: ${file.size}`);
  }
  lines.push(`path: ${feed.path}`);
  lines.push(`sha512: ${feed.sha512}`);
  // Preserve quoting style electron-builder uses for ISO dates when needed
  const date =
    feed.releaseDate.includes(":") && !feed.releaseDate.startsWith("'")
      ? `'${feed.releaseDate}'`
      : feed.releaseDate;
  lines.push(`releaseDate: ${date}`);
  lines.push("");
  return lines.join("\n");
}

function main(): void {
  const { inputs, outPath } = parseArgs(process.argv.slice(2));
  const feeds = inputs.map((file) => {
    const raw = readFileSync(file, "utf-8");
    return parseLatestYml(raw);
  });
  const merged = mergeFeeds(feeds);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, serializeLatestYml(merged), "utf-8");
  process.stdout.write(
    `[merge-latest-yml] wrote ${outPath} (${merged.files.length} file entries, v${merged.version})\n`,
  );
}

// Only run CLI when executed directly (not when imported by tests).
if (import.meta.main) {
  try {
    main();
  } catch (err: unknown) {
    process.stderr.write(
      `[merge-latest-yml] ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}
