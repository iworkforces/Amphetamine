import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { collectBenchmarkOutput } from "../../scripts/benchmark-output.js";
import { benchmarkFixture } from "../infrastructure/benchmark-fixture.js";

const record = `AMPHETAMINE_BENCHMARK_RESULT:${JSON.stringify(benchmarkFixture)}`;

function launch(program: string) {
  return spawn(process.execPath, ["-e", program], {
    detached: true,
    env: { ...process.env, BENCHMARK_RECORD: record },
  });
}

describe("benchmark child output", () => {
  it("frames split UTF-8 and CRLF and waits for the successful close", async () => {
    const child = launch(
      `const text = Buffer.from('log\\r\\n' + process.env.BENCHMARK_RECORD + '\\r\\n'); const index = text.indexOf(Buffer.from('é')); process.stdout.write(text.subarray(0, index + 1)); process.stdout.write(text.subarray(index + 1)); process.stderr.write('drained');`,
    );
    const result = await collectBenchmarkOutput(child, "idle");
    expect(result.payload.label).toBe("café");
    expect(result.stderr).toBe("drained");
    expect(child.exitCode).toBe(0);
  });

  it("accepts a final unterminated result", async () => {
    const child = launch("process.stdout.write(process.env.BENCHMARK_RECORD)");
    await expect(collectBenchmarkOutput(child, "idle")).resolves.toMatchObject({
      payload: { scenario: "idle" },
    });
  });

  it.each([
    ["malformed", "process.stdout.write('AMPHETAMINE_BENCHMARK_RESULT:{\\n')"],
    [
      "duplicate",
      "process.stdout.write(process.env.BENCHMARK_RECORD + '\\n' + process.env.BENCHMARK_RECORD + '\\n')",
    ],
    ["missing", "process.stdout.write('log\\n')"],
    [
      "nonzero after result",
      "process.stdout.write(process.env.BENCHMARK_RECORD + '\\n'); process.exitCode = 2",
    ],
  ])("rejects %s", async (_name, program) => {
    await expect(collectBenchmarkOutput(launch(program), "idle")).rejects.toThrow();
  });

  it("terminates and waits for close after timeout", async () => {
    const child = launch("setInterval(() => {}, 1000)");
    await expect(collectBenchmarkOutput(child, "idle", 50)).rejects.toThrow(/timed out/);
    expect(child.signalCode !== null || child.exitCode !== null).toBe(true);
  });

  it("escalates termination when a child ignores SIGTERM", async () => {
    const child = launch(
      "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)",
    );
    await once(child.stdout, "data");
    await expect(collectBenchmarkOutput(child, "idle", 50)).rejects.toThrow(/timed out/);
    if (process.platform === "win32")
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    else expect(child.signalCode).toBe("SIGKILL");
  });

  it("rejects a result from the wrong requested scenario", async () => {
    const child = launch("process.stdout.write(process.env.BENCHMARK_RECORD + '\\n')");
    await expect(collectBenchmarkOutput(child, "active-session")).rejects.toThrow(/Invalid/);
  });

  it("terminates and waits for close when the run is interrupted", async () => {
    const child = launch("setInterval(() => {}, 1000)");
    const controller = new AbortController();
    const result = collectBenchmarkOutput(child, "idle", 60000, controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow(/interrupted/);
    expect(child.signalCode !== null || child.exitCode !== null).toBe(true);
  });
});
