// @vitest-environment node
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Writable } from "node:stream";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { version } from "../../../package.json";
import {
  MAX_OUTPUT_BYTES, MAX_RECORD_BYTES, bindContext, createTraceId, createWriter,
  getContext, registerRouteTemplates, runInBackground, runWithContext,
  serializeEvent, setProcessRole, writeEmergencyFailure
} from "./runtime.cjs";

const require = createRequire(import.meta.url);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const completion = { outcome: "completed", status: 200 } as const;
function record(event: Parameters<typeof serializeEvent>[0], fields: Parameters<typeof serializeEvent>[1]) {
  return JSON.parse(serializeEvent(event, fields)!);
}
class Sink extends EventEmitter {
  writable = true;
  destroyed = false;
  writableNeedDrain = false;
  writableLength = 0;
  lines: string[] = [];
  write = vi.fn((line: string) => { this.lines.push(line); return true; });
}
afterEach(() => { setProcessRole("app"); vi.restoreAllMocks(); });

describe("bounded observability runtime", () => {
  it("shares CJS and bundled entry context, including concurrent callbacks and fresh job roots", async () => {
    const cjs = require("./runtime.cjs") as typeof import("./runtime.cjs");
    const seen: Array<{ run: string; trace: string; callback: string; job: string; jobRun: string | undefined }> = [];
    await Promise.all(["run-a", "run-b"].map((run_id) => runInBackground(async () => {
      const trace = getContext()!.trace_id;
      await runWithContext({ run_id }, async () => {
        expect(cjs.getContext()).toBe(getContext());
        const bound = bindContext(() => getContext()!.run_id!);
        await tick();
        const job = await runInBackground(() => runWithContext({ job_id: "job-1" }, async () => {
          await tick();
          return getContext()!;
        }));
        seen.push({ run: getContext()!.run_id!, trace, callback: bound(), job: job.trace_id, jobRun: job.run_id });
      });
      expect(getContext()!.run_id).toBeUndefined();
    })));
    expect(seen.map((item) => item.run).sort()).toEqual(["run-a", "run-b"]);
    expect(new Set(seen.flatMap((item) => [item.trace, item.job])).size).toBe(4);
    for (const item of seen) {
      expect(item.callback).toBe(item.run);
      expect(item.jobRun).toBeUndefined();
    }
    expect(getContext()).toBeUndefined();
  });

  it("generates nonzero lowercase trace ids and immutable allowlisted contexts", () => {
    for (let index = 0; index < 100; index += 1) expect(createTraceId()).toMatch(/^(?!0{32}$)[a-f0-9]{32}$/);
    runWithContext({ trace_id: "0".repeat(32), run_id: "run-1", user_id: "secret-canary" } as never, () => {
      expect(getContext()).toEqual({ trace_id: expect.stringMatching(/^(?!0{32}$)[a-f0-9]{32}$/), run_id: "run-1" });
      expect(Object.isFrozen(getContext())).toBe(true);
    });
  });

  it("emits bounded single-line positive projections without touching raw objects", () => {
    registerRouteTemplates(["/api/runs/[runId]", "/share/[token]", "https://private.invalid/secret"]);
    const fields = {
      ...completion, routePath: "/api/runs/[runId]", route_source: "manifest", method: "POST",
      prompt: "secret-canary", answer: "secret-canary", query: "secret-canary", headers: { authorization: "secret-canary" },
      error: new Error("secret-canary"), user_id: "secret-canary", trace_id: "client-selected", statusCode: 500,
      toJSON() { throw new Error("must-not-call"); },
      get url() { throw new Error("must-not-read"); }
    };
    const line = serializeEvent("http.request_completed", fields as never)!;
    expect(line.trim().split("\n")).toHaveLength(1);
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    expect(line).not.toContain("secret-canary");
    expect(JSON.parse(line)).toEqual({
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/), level: "info", event: "http.request_completed",
      role: "app", app_version: version, instance_id: expect.stringMatching(/^[a-f0-9]{32}$/),
      method: "POST", routePath: "/api/runs/[runId]", route_source: "manifest", status: 200, outcome: "completed"
    });
    expect(record("http.request_completed", { ...completion, routePath: "/share/private-secret-canary" })).not.toHaveProperty("routePath");
    expect(record("http.request_completed", { ...completion, get status() { throw new Error("secret-canary"); } })).not.toHaveProperty("status");
    expect(serializeEvent("__proto__" as never, completion as never)).toBeUndefined();
    expect(serializeEvent("http.request_completed", new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("secret-canary"); } }) as never)).toBeUndefined();
  });

  it("rejects malformed values and arbitrary provider errors without inferring reasons", () => {
    const item = record("provider_request", {
      providerFamily: "openrouter", adapterKind: "openrouter_chat_completions", connectionId: "connection-1", providerModelId: "model-1",
      outcome: "failed", code: "secret-canary", reason: "unknown", httpStatus: 503, duration_ms: 1.2,
      providerBody: "secret-canary", endpoint: "https://private.invalid", abort_source: "secret-canary", attempt: -1,
      timeout_ms: Infinity, delay_ms: 1e99, message: "secret-canary", stack: "secret-canary"
    } as never);
    expect(item).toMatchObject({ code: "unknown", reason: "unknown", level: "warn", httpStatus: 503, duration_ms: 1 });
    for (const key of ["attempt", "abort_source", "timeout_ms", "delay_ms", "message", "stack", "endpoint", "providerBody"]) expect(item).not.toHaveProperty(key);
    expect(JSON.stringify(item)).not.toContain("secret-canary");
    expect(record("run_persistence", { run_id: "run-1", stage: "fail", outcome: "unconfirmed", prisma_code: "P1001" })).toMatchObject({ prisma_code: "P1001", level: "error" });
    expect(record("run_persistence", { run_id: "run-1", stage: "fail", outcome: "unconfirmed", prisma_code: "P1001 secret-canary" })).toMatchObject({ prisma_code: "unknown" });
  });

  it("keeps HTTP, accepted operation, cancellation, and persistence severity distinct", () => {
    expect(record("http.request_completed", completion).level).toBe("info");
    expect(record("http.request_completed", { ...completion, status: 400 }).level).toBe("warn");
    expect(record("http.request_completed", { ...completion, status: 500 }).level).toBe("error");
    expect(record("run_execution", { run_id: "run-1", stage: "execution", outcome: "cancelled" }).level).toBe("info");
    expect(record("provider_retry", { action: "retry", attempt: 1 }).level).toBe("warn");
    expect(record("provider_request", { outcome: "failed", httpStatus: 503 }).level).toBe("warn");
    expect(record("provider_operation", { outcome: "failed", httpStatus: 503 }).level).toBe("error");
    expect(record("process.failure", { stage: "unhandled_rejection", outcome: "framework_managed" }).level).toBe("error");
    expect(record("process.failure", { stage: "uncaught_exception", outcome: "terminated" }).level).toBe("fatal");
  });

  it("uses the current event schema after HMR while preserving the singleton sink and context", () => {
    const runtimeUrl = new URL("./runtime.cjs", import.meta.url);
    const source = readFileSync(runtimeUrl, "utf8");
    const sink = new Sink();
    const realm = createContext({ require: createRequire(runtimeUrl), process: { stdout: sink }, Buffer });
    const reload = (code: string) => runInContext(
      `(() => { const module = { exports: {} }; ${code}; return module.exports; })()`, realm
    ) as typeof import("./runtime.cjs");
    const before = reload(source);
    before.logEvent("provider_request", { outcome: "completed", httpStatus: 200 });
    const after = reload(source
      .replace("httpStatus: integer(100, 599),", "")
      .replace('"logging.dropped_records": { fields:', '"hmr_event": { fields: { count: integer(1, 10) }, level: "info" },\n  "logging.dropped_records": { fields:'));
    before.runWithContext({ run_id: "run-hmr" }, () => {
      expect(after.getContext()).toBe(before.getContext());
      after.logEvent("hmr_event" as never, { count: 1 } as never);
      after.logEvent("provider_request", { outcome: "completed", httpStatus: 200 });
    });
    const records = sink.lines.map((line) => JSON.parse(line));
    expect(records).toHaveLength(3);
    expect(records[0]).toHaveProperty("httpStatus", 200);
    expect(records[1]).toMatchObject({ event: "hmr_event", count: 1, run_id: "run-hmr" });
    expect(records[2]).not.toHaveProperty("httpStatus");
    expect(new Set(records.map((item) => item.instance_id)).size).toBe(1);
    expect(sink.listenerCount("error")).toBe(1);
    expect(sink.listenerCount("drain")).toBe(1);
  });

  it("stops writes under backpressure and reports bounded losses on drain outside request context", () => {
    const sink = new Sink();
    sink.write.mockImplementationOnce((line) => { sink.lines.push(line); return false; });
    const writer = createWriter(sink as unknown as Writable);
    runWithContext({ run_id: "run-1" }, () => {
      writer.logEvent("http.request_completed", completion);
      for (let index = 0; index < 10000; index += 1) writer.logEvent("http.request_completed", completion);
      expect(sink.write).toHaveBeenCalledTimes(1);
      sink.emit("drain");
    });
    expect(sink.write).toHaveBeenCalledTimes(2);
    const loss = JSON.parse(sink.lines[1]!);
    expect(loss).toMatchObject({ event: "logging.dropped_records", count: 10000 });
    expect(loss).not.toHaveProperty("run_id");
    expect(loss).not.toHaveProperty("trace_id");
    writer.logEvent("http.request_completed", completion);
    expect(sink.write).toHaveBeenCalledTimes(3);
  });

  it("honors total sink pressure, contains I/O errors, and resumes with a loss count", () => {
    const sink = new Sink();
    sink.writableLength = MAX_OUTPUT_BYTES;
    const writer = createWriter(sink as unknown as Writable);
    writer.logEvent("http.request_completed", completion);
    expect(sink.write).not.toHaveBeenCalled();
    sink.writableLength = 0;
    sink.write.mockImplementationOnce(() => { throw new Error("secret-canary"); });
    expect(() => sink.emit("drain")).not.toThrow();
    sink.emit("error", new Error("secret-canary"));
    sink.emit("drain");
    expect(JSON.parse(sink.lines[0]!)).toMatchObject({ event: "logging.dropped_records", count: 2 });
    expect(sink.lines.join("")).not.toContain("secret-canary");
  });

  it("does not suppress distinct accepted-operation failures", () => {
    const sink = new Sink();
    const writer = createWriter(sink as unknown as Writable);
    for (let index = 0; index < 100; index += 1) writer.logEvent("run_execution", {
      run_id: `run-${index}`, stage: "execution", outcome: "failed", code: "provider_stream_failed"
    });
    expect(sink.lines).toHaveLength(100);
    expect(new Set(sink.lines.map((line) => JSON.parse(line).run_id)).size).toBe(100);
  });

  it("writes emergency evidence synchronously once even when ordinary output is blocked", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const emergency = vi.spyOn(fs, "writeSync").mockImplementation(() => 1);
    writeEmergencyFailure({ stage: "uncaught_exception", outcome: "terminated", code: "unexpected" });
    expect(emergency).toHaveBeenCalledTimes(1);
    expect(emergency.mock.calls[0]![0]).toBe(2);
    expect(JSON.parse(String(emergency.mock.calls[0]![1]))).toMatchObject({ event: "process.failure", level: "fatal" });
    emergency.mockImplementation(() => { throw new Error("secret-canary"); });
    expect(() => writeEmergencyFailure({ stage: "startup", outcome: "terminated" })).not.toThrow();
    expect(emergency).toHaveBeenCalledTimes(2);
  });
});
