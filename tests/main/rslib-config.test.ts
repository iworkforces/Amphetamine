import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Rslib compiler caches", () => {
  it("isolates persistent caches for parallel main and preload builds", () => {
    const output = execFileSync(
      "bun",
      [
        "-e",
        `
          import { createRslib } from "@rslib/core";
          for (const file of ["./rslib.config.ts", "./rslib.config.preload.ts"]) {
            const { default: config } = await import(file);
            const rslib = await createRslib({ config });
            rslib.onAfterCreateRsbuild(async ({ rsbuild }) => {
              for (const compiler of await rsbuild.initConfigs()) {
                const cache = compiler.cache;
                if (cache.type !== "persistent" || cache.storage.type !== "filesystem") {
                  throw new Error("Expected a persistent filesystem cache");
                }
                console.log(JSON.stringify([cache.storage.directory, cache.version]));
              }
            });
            await rslib.inspectConfig({ writeToDisk: false });
          }
        `,
      ],
      { encoding: "utf8", env: { ...process.env, NODE_ENV: "production" }, timeout: 15_000 },
    );

    const cacheLocations = output.trim().split(/\r?\n/);
    expect(cacheLocations).toHaveLength(2);
    expect(new Set(cacheLocations).size).toBe(2);
  });
});
