#!/usr/bin/env bun
import { validateReleaseMatrix } from "./release-matrix.js";

const mode = process.argv[2];
if (mode !== "source" && mode !== "staged") {
  process.stderr.write(
    "Usage: bun run scripts/verify-release-matrix.ts source|staged [repo-root]\n",
  );
  process.exitCode = 2;
} else {
  const result = validateReleaseMatrix(process.argv[3] ?? process.cwd(), mode);
  for (const error of result.errors) process.stderr.write(`[release-matrix] ${error}\n`);
  if (result.errors.length > 0) process.exitCode = 1;
  else process.stdout.write(`[release-matrix] ${mode} OK (${result.assets.length} assets)\n`);
}
