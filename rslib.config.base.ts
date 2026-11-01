import * as rspack from "@rspack/core";

const isDev = process.env.NODE_ENV !== "production";

export interface ElectronLibOptions {
  /** Entry point, e.g. { index: './src/main/index.ts' } */
  entry: Record<string, string>;
  /** Output directory, e.g. './lib/main' */
  distRoot: string;
  /** Output filename pattern, e.g. '[name].cjs' or 'index.cjs' */
  filename: string;
  /** Rspack target, e.g. 'electron-main' or 'electron-preload' */
  electronTarget: string;
  /** Path to tsconfig.json */
  tsconfigPath: string;
}

export function createElectronLibConfig(options: ElectronLibOptions) {
  return {
    // Rslib uses the library id to namespace persistent caches across parallel builds.
    id: options.electronTarget,
    format: "cjs" as const,
    bundle: true,
    dts: false,
    source: {
      entry: options.entry,
    },
    output: {
      distPath: { root: options.distRoot },
      target: "node" as const,
      filename: {
        js: options.filename,
      },
      // === PRODUCTION OPTIMIZATIONS ===
      minify: !isDev,
      sourceMap: isDev,
    },
    tools: {
      bundlerChain(chain: any) {
        chain.target(options.electronTarget);
      },
      rspack(config: any) {
        // === OPTIMIZATION FLAGS ===
        config.optimization = {
          minimize: !isDev,
          usedExports: !isDev,
          sideEffects: !isDev,
          concatenateModules: !isDev,
          innerGraph: !isDev,
          minimizer: isDev
            ? []
            : [
                new rspack.SwcJsMinimizerRspackPlugin({
                  minimizerOptions: {
                    compress: {
                      drop_console: true,
                    },
                  },
                }),
              ],
        };

        // Externalize electron core and runtime dependencies (loaded from node_modules at runtime)
        const existing = config.externals ?? [];
        const arr = Array.isArray(existing) ? existing : [existing];
        arr.push(function (ctx: any, callback: any) {
          const req = ctx.request ?? "";
          if (
            req === "electron" ||
            req.startsWith("electron/") ||
            req === "electron-log" ||
            req.startsWith("electron-log/") ||
            req === "electron-updater" ||
            req.startsWith("electron-updater/")
          ) {
            return callback(undefined, `commonjs ${req}`);
          }
          callback();
        });
        config.externals = arr;
        // Configure extension alias for TypeScript imports
        config.resolve = config.resolve ?? {};
        config.resolve.extensionAlias = { ".js": [".ts", ".js"] };
        return config;
      },
    },
  };
}
