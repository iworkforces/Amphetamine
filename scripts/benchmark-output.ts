import { spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  isBenchmarkResultPayload,
  type BenchmarkResultPayload,
  type BenchmarkScenario,
} from "../src/shared/benchmark-types.js";

const RESULT_PREFIX = "AMPHETAMINE_BENCHMARK_RESULT:";
const TERMINATION_GRACE_MS = 1000;

export class BenchmarkRunError extends Error {
  override readonly name: string = "BenchmarkRunError";
}

export class BenchmarkTerminationError extends BenchmarkRunError {
  override readonly name = "BenchmarkTerminationError";
}

export function collectBenchmarkOutput(
  child: ChildProcessWithoutNullStreams,
  scenario: BenchmarkScenario,
  timeoutMs = 60000,
  abortSignal?: AbortSignal,
): Promise<{
  readonly payload: BenchmarkResultPayload;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let pending = "";
    let payload: BenchmarkResultPayload | null = null;
    let failure: Error | null = null;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    let forcedTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let treeTerminationFailed = false;

    const signal = (name: NodeJS.Signals): void => {
      if (process.platform === "win32" && typeof child.pid === "number") {
        const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          timeout: TERMINATION_GRACE_MS,
        });
        if (result.status !== 0) {
          treeTerminationFailed = true;
          child.kill(name);
        }
        return;
      }
      if (process.platform !== "win32" && typeof child.pid === "number") {
        try {
          process.kill(-child.pid, name);
          return;
        } catch {
          child.kill(name);
          return;
        }
      }
      child.kill(name);
    };
    const terminate = (error: Error): void => {
      if (failure !== null) return;
      failure = error;
      if (closed) return;
      signal("SIGTERM");
      terminationTimer = setTimeout(() => {
        signal("SIGKILL");
        forcedTimer = setTimeout(() => {
          if (!closed) {
            cleanup();
            child.stdin.destroy();
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref();
            reject(
              new BenchmarkTerminationError(
                "Benchmark process did not close after termination; user data retained.",
              ),
            );
          }
        }, TERMINATION_GRACE_MS);
      }, TERMINATION_GRACE_MS);
    };
    const timeout = setTimeout(
      () => terminate(new BenchmarkRunError(`Electron benchmark timed out after ${timeoutMs}ms.`)),
      timeoutMs,
    );
    const record = (line: string): void => {
      const text = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!text.startsWith(RESULT_PREFIX)) return;
      if (payload !== null) {
        terminate(new BenchmarkRunError("Duplicate benchmark result."));
        return;
      }
      try {
        const parsed: unknown = JSON.parse(text.slice(RESULT_PREFIX.length));
        if (!isBenchmarkResultPayload(parsed) || parsed.scenario !== scenario) {
          terminate(new BenchmarkRunError("Invalid benchmark result."));
          return;
        }
        payload = parsed;
      } catch (error) {
        terminate(
          new BenchmarkRunError(
            `Malformed benchmark result: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    };
    const onStdout = (chunk: string): void => {
      stdout += chunk;
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        record(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    };
    const onStderr = (chunk: string): void => {
      stderr += chunk;
    };
    const onError = (error: Error): void => terminate(error);
    const onAbort = (): void => terminate(new BenchmarkRunError("Benchmark interrupted."));
    const cleanup = (): void => {
      clearTimeout(timeout);
      if (terminationTimer !== undefined) clearTimeout(terminationTimer);
      if (forcedTimer !== undefined) clearTimeout(forcedTimer);
      child.stdout.removeListener("data", onStdout);
      child.stderr.removeListener("data", onStderr);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      abortSignal?.removeEventListener("abort", onAbort);
    };
    const groupIsAlive = (): boolean => {
      if (process.platform === "win32" || typeof child.pid !== "number") return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return !(error instanceof Error && "code" in error && error.code === "ESRCH");
      }
    };
    const onClose = (code: number | null, signalName: NodeJS.Signals | null): void => {
      closed = true;
      if (pending.length > 0) record(pending);
      cleanup();
      if (failure === null && (code !== 0 || signalName !== null)) {
        failure = new BenchmarkRunError(
          `Electron closed with code ${code ?? "unknown"} and signal ${signalName ?? "none"}.`,
        );
      }
      if (failure === null && payload === null) {
        failure = new BenchmarkRunError("Electron closed without a benchmark result.");
      }
      if (groupIsAlive()) {
        failure ??= new BenchmarkRunError("Benchmark process group survived child close.");
        signal("SIGKILL");
        const deadline = performance.now() + TERMINATION_GRACE_MS;
        const waitForGroup = (): void => {
          if (!groupIsAlive()) reject(failure);
          else if (performance.now() >= deadline)
            reject(
              new BenchmarkTerminationError("Process group did not terminate; user data retained."),
            );
          else setTimeout(waitForGroup, 25);
        };
        waitForGroup();
        return;
      }
      if (treeTerminationFailed)
        reject(
          new BenchmarkTerminationError(
            "Could not confirm process-tree termination; user data retained.",
          ),
        );
      else if (failure !== null) reject(failure);
      else if (payload !== null) resolve({ payload, stdout, stderr });
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("error", onError);
    child.on("close", onClose);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (abortSignal?.aborted === true) onAbort();
  });
}
