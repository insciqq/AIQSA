// @vitest-environment node
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
type Runtime = typeof import("./runtime.cjs");
type Observed = Record<string, unknown>;

/** A fresh process-global runtime per test, so the observer slot and its
 * early buffer never leak between tests or into this worker's own logging. */
function isolatedRuntime() {
  const url = new URL("./runtime.cjs", import.meta.url);
  const lines: string[] = [];
  const sink = Object.assign(new EventEmitter(), {
    writable: true, destroyed: false, writableNeedDrain: false, writableLength: 0,
    write: vi.fn((line: string) => { lines.push(line); return true; })
  });
  const realm = createContext({ require: createRequire(url), process: { stdout: sink, version: "v22.22.0" }, Buffer });
  const runtime = runInContext(
    `(() => { const module = { exports: {} }; ${readFileSync(url, "utf8")}; return module.exports; })()`, realm
  ) as Runtime;
  const observed: Observed[] = [];
  return { lines, observed, runtime, sink, collect: (record: Observed) => { observed.push(record); } };
}

const failure = { run_id: "run-1", stage: "execution", outcome: "failed", code: "provider_stream_failed" } as const;

afterEach(() => { vi.restoreAllMocks(); });

describe("validated record observer", () => {
  it("receives each validated record frozen and identical to its line, even when stdout drops the line", () => {
    const { lines, observed, runtime, sink, collect } = isolatedRuntime();
    runtime.setRecordObserver(collect);
    sink.write.mockImplementationOnce((line: string) => { lines.push(line); return false; });
    runtime.runWithContext({ run_id: "run-1" }, () => {
      runtime.logEvent("run_execution", { ...failure, prompt: "PRIVATE_PROMPT" } as never);
      runtime.logEvent("run_execution", { ...failure, outcome: "completed" });
    });
    runtime.logEvent("not_an_event" as never, {} as never);

    expect(lines).toHaveLength(1);
    expect(observed).toHaveLength(2);
    expect(observed[0]).toEqual(JSON.parse(lines[0]!));
    expect(observed[0]).toMatchObject({ event: "run_execution", level: "error", run_id: "run-1", code: "provider_stream_failed" });
    expect(observed[0]!.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(observed[1]).toMatchObject({ event: "run_execution", level: "info", outcome: "completed" });
    expect(observed.every((record) => Object.isFrozen(record))).toBe(true);
    expect(JSON.stringify(observed)).not.toContain("PRIVATE_");
  });

  it("keeps the line when the observer throws or logs, and never observes its own records", () => {
    const { lines, observed, runtime } = isolatedRuntime();
    let calls = 0;
    runtime.setRecordObserver((record) => {
      calls += 1;
      if (calls === 1) throw new Error("observer-canary");
      observed.push(record);
      runtime.logEvent("logging.dropped_records", { count: 1 });
    });
    runtime.logEvent("run_execution", failure);
    runtime.logEvent("run_execution", { ...failure, outcome: "completed" });

    // The observer runs before its record is written, so its own line comes first.
    expect(lines.map((line) => JSON.parse(line).event)).toEqual(["run_execution", "logging.dropped_records", "run_execution"]);
    expect(calls).toBe(2);
    expect(observed).toEqual([expect.objectContaining({ event: "run_execution", outcome: "completed" })]);
    expect(lines.join("")).not.toContain("observer-canary");
  });

  it("delivers a bounded backlog of startup records to the first observer only", () => {
    const { observed, runtime, collect } = isolatedRuntime();
    runtime.setProcessRole("memory_search");
    runtime.announceProcess();
    for (let index = 0; index < 40; index += 1) runtime.logEvent("run_execution", failure);
    runtime.setRecordObserver(collect);
    expect(observed).toHaveLength(32);
    expect(observed[0]).toMatchObject({ event: "process.started", role: "memory_search", level: "info" });
    runtime.logEvent("run_execution", failure);
    expect(observed).toHaveLength(33);

    runtime.setRecordObserver(null);
    runtime.logEvent("run_execution", failure);
    runtime.setRecordObserver(collect);
    expect(observed).toHaveLength(33);
  });

  it("observes dropped-record reports and emergency failures", () => {
    const { observed, runtime, sink, collect } = isolatedRuntime();
    const fs = require("node:fs") as typeof import("node:fs");
    const emergency = vi.spyOn(fs, "writeSync").mockImplementation(() => 1);
    runtime.setRecordObserver(collect);
    sink.write.mockImplementationOnce(() => false);
    for (let index = 0; index < 3; index += 1) runtime.logEvent("run_execution", failure);
    sink.emit("drain");
    runtime.writeEmergencyFailure({ stage: "unhandled_rejection", outcome: "framework_managed", code: "unexpected" });

    expect(observed.map((record) => record.event)).toEqual([
      "run_execution", "run_execution", "run_execution", "logging.dropped_records", "process.failure"
    ]);
    expect(observed[3]).toMatchObject({ count: 2, level: "warn" });
    expect(observed[4]).toMatchObject({ outcome: "framework_managed", level: "error" });
    expect(emergency).toHaveBeenCalledOnce();
  });
});
