import { describe, expect, it } from "vitest";
import {
  SpikeUsageError,
  cgroupMemory,
  groupProcesses,
  parseCgroupStat,
  parseProcStatus,
  parseSpikeArgs,
  phaseStats,
  prewarmDecision,
  shellSucceeded,
  splitEnsure,
  summarizeIdle
} from "./workspace-vm-latency-support";

describe("workspace VM latency spike helpers", () => {
  it("parses flags with the documented defaults and rejects unknown ones", () => {
    expect(parseSpikeArgs([], {})).toEqual({
      allowExistingSessions: false, idleSeconds: 180, internet: false, runnerUrl: "http://127.0.0.1:4310",
      sdk: true, sessions: 3, stopResume: false, warm: 5
    });
    expect(parseSpikeArgs(["--sessions", "1", "--warm", "0", "--idle-seconds", "60", "--stop-resume", "--no-sdk"],
      { AIQSA_WORKSPACE_RUNNER_URL: "http://runner:4310" })).toMatchObject({
      idleSeconds: 60, runnerUrl: "http://runner:4310", sdk: false, sessions: 1, stopResume: true, warm: 0
    });
    expect(() => parseSpikeArgs(["--sessions", "0"], {})).toThrow(SpikeUsageError);
    expect(() => parseSpikeArgs(["--warm"], {})).toThrow(SpikeUsageError);
    expect(() => parseSpikeArgs(["--fast"], {})).toThrow(SpikeUsageError);
  });

  it("reads resident memory from /proc status and groups it by executable", () => {
    const vm = parseProcStatus("Name:\tmsb\nVmRSS:\t  409600 kB\nRssAnon:\t 400000 kB\nRssFile:\t 9600 kB\nRssShmem:\t 0 kB\n");
    expect(vm).toEqual({ anonKb: 400_000, fileKb: 9_600, name: "msb", rssKb: 409_600, shmemKb: 0 });
    expect(parseProcStatus("Name:\tkthreadd\nState:\tS\n")).toBeNull();
    const mcp = parseProcStatus("Name:\tnode\nVmRSS:\t51200 kB\nRssAnon:\t40960 kB\n")!;
    expect(groupProcesses([mcp, vm!, mcp])).toEqual([
      { anonMB: 390.6, comm: "msb", count: 1, rssMB: 400, shmemMB: 0 },
      { anonMB: 80, comm: "node", count: 2, rssMB: 100, shmemMB: 0 }
    ]);
  });

  it("reads cgroup v1 and v2 memory counters", () => {
    expect(cgroupMemory(2, 1_073_741_824, parseCgroupStat("anon 524288000\nfile 104857600\nshmem 0\n")))
      .toEqual({ anonMB: 500, currentMB: 1_024, fileMB: 100, version: 2 });
    expect(cgroupMemory(1, 1_048_576, parseCgroupStat("cache 2097152\nrss 1048576\ntotal_rss 3145728\n")))
      .toEqual({ anonMB: 3, currentMB: 1, fileMB: 2, version: 1 });
  });

  it("splits ensure by the first observed guest status", () => {
    expect(splitEnsure({ created: 900, starting: 1_000, running: 4_000 }, 5_500))
      .toEqual({ bootMs: 3_100, guestInitMs: 1_500, prepareMs: 900 });
    // A resume starts from a stopped guest, which is not a beginning.
    expect(splitEnsure({ stopped: 0, starting: 300, running: 2_300 }, 2_600))
      .toEqual({ bootMs: 2_000, guestInitMs: 300, prepareMs: 300 });
    // Only "running" seen: all time before it counts as preparation.
    expect(splitEnsure({ running: 1_200 }, 1_000)).toEqual({ bootMs: 0, guestInitMs: 0, prepareMs: 1_200 });
    expect(splitEnsure({ created: 100 }, 2_000)).toBeNull();
  });

  it("summarizes phases and idle memory", () => {
    expect(phaseStats([])).toBeNull();
    expect(phaseStats([30, 10, 20])).toEqual({ max: 30, mean: 20, min: 10, n: 3, p50: 20 });
    expect(phaseStats([10, 40, 20, 30])?.p50).toBe(25);
    expect(summarizeIdle([
      { cgroupMB: 900, elapsedS: 0, sdkHostResidentMB: 410, vmProcessMB: 480 },
      { cgroupMB: 950, elapsedS: 30, sdkHostResidentMB: 430, vmProcessMB: 520 },
      { cgroupMB: 870, elapsedS: 60, sdkHostResidentMB: 400, vmProcessMB: 455.5 }
    ])).toEqual({
      cgroupFirstMB: 900, cgroupLastMB: 870, samples: 3, sdkHostResidentLastMB: 400,
      shrankMB: 24.5, vmFirstMB: 480, vmLastMB: 455.5, vmMaxMB: 520
    });
  });

  it("prewarms only for a slow cold start and a cheap idle VM", () => {
    expect(prewarmDecision({ coldP50Ms: 8_000, idleVmMB: 300, takeoverP50Ms: 900 }))
      .toEqual({ coldP50Ms: 8_000, idleVmMB: 300, prewarm: "yes", reason: "slow_cold_start_cheap_idle_vm", savedP50Ms: 7_100 });
    expect(prewarmDecision({ coldP50Ms: 3_000, idleVmMB: 300, takeoverP50Ms: null }))
      .toMatchObject({ prewarm: "no", reason: "cold_start_fast", savedP50Ms: null });
    expect(prewarmDecision({ coldP50Ms: 8_000, idleVmMB: 900, takeoverP50Ms: 900 }))
      .toMatchObject({ prewarm: "no", reason: "idle_vm_expensive" });
    expect(prewarmDecision({ coldP50Ms: null, idleVmMB: 300, takeoverP50Ms: null }))
      .toMatchObject({ prewarm: "undecided", reason: "measurement_missing" });
  });

  it("accepts only a completed shell result that reports success", () => {
    const text = (value: unknown) => ({ content: [{ text: JSON.stringify(value) }], status: "complete" });
    expect(shellSucceeded(text({ data: { success: true }, ok: true }))).toBe(true);
    expect(shellSucceeded(text({ data: { success: false }, ok: true }))).toBe(false);
    expect(shellSucceeded({ content: [{ text: "not json" }], status: "complete" })).toBe(false);
    expect(shellSucceeded({ ...text({ data: { success: true }, ok: true }), status: "error" })).toBe(false);
  });
});
