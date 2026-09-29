#!/usr/bin/env bun
import { validateBetaReleaseMatrix } from "./beta-release-matrix.js";

const [version, beta, root, ...extra] = process.argv.slice(2);
if (
  !version ||
  !/^\d+\.\d+\.\d+$/.test(version) ||
  !beta ||
  !/^[1-9]\d*$/.test(beta) ||
  extra.length > 0
) {
  process.stderr.write(
    "Usage: bun run scripts/verify-beta-release-matrix.ts <prepared-version> <beta-n> [repo-root]\n",
  );
  process.exitCode = 2;
} else {
  const result = validateBetaReleaseMatrix(root ?? process.cwd(), version, beta);
  for (const error of result.errors) process.stderr.write(`[beta-release-matrix] ${error}\n`);
  if (result.errors.length > 0) process.exitCode = 1;
  else process.stdout.write(`[beta-release-matrix] OK (${result.assets.length} binaries)\n`);
}
