import { describe, expect, it } from "vitest";
import { captureRunObservation } from "@/tests/support/runObservation";
import { workspaceMcpFailure, workspaceOperationFailureResult } from "./operationFailure";
import { observeWorkspaceToolExecution, retainWorkspaceResultCode } from "./toolObservability";

const wire = (value: unknown, isError = true) => ({ isError, content: [{ type: "text", text: JSON.stringify(value) }] });
describe("Workspace confirmed operation failures", () => {
  it.each([true, false])("retains known nonzero and bounded output without upstream diagnostics, isError=%s", isError => {
    const output = { exitCode: 3, stdout: "output ".repeat(2000), stderr: "failure ".repeat(2000) + "LAST_LINE", private: "PRIVATE_DETAIL" };
    const upstream = isError ? { ok: false, error: { code: "exec_failed", message: "PRIVATE_EXCEPTION", details: output } } : { ok: true, data: output };
    const result = workspaceMcpFailure(wire(upstream, isError), 16384, "sandbox_shell")!;
    expect(result).toMatchObject({ status: "error", exitCode: 3, errorCode: "workspace_command_failed", truncated: true });
    const text = result.content[0]!.text!;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16384);
    expect(Buffer.byteLength(text)).toBeGreaterThan(16384 - 64);
    const envelope = JSON.parse(text);
    expect(envelope.data).toMatchObject({ exitCode: 3, truncated: true });
    expect(envelope.data.stderr).toMatch(/bytes omitted/u);
    expect(envelope.data.stderr.endsWith("LAST_LINE")).toBe(true);
    expect(Buffer.byteLength(envelope.data.stderr)).toBeGreaterThan(Buffer.byteLength(envelope.data.stdout));
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });

  it.each([128 * 1024, 1024 * 1024])("gives failed output the success budget so a mid-log cause stays visible, maximum=%i", maximum => {
    const half = "passing test line\n".repeat(1200);
    const stdout = `${half}ROOT_CAUSE: expected 3 but received 4 at src/sum.ts:12\n${half}`;
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(40 * 1024);
    const result = workspaceMcpFailure(wire({ ok: true, data: { exitCode: 1, stdout, stderr: "1 test failed" } }, false), maximum, "sandbox_shell")!;
    expect(result).toMatchObject({ errorCode: "workspace_command_failed", exitCode: 1, truncated: false });
    const envelope = JSON.parse(result.content[0]!.text!);
    expect(envelope.data).toEqual({ exitCode: 1, stdout, stderr: "1 test failed", truncated: false });
    expect(Buffer.byteLength(result.content[0]!.text!)).toBeLessThanOrEqual(maximum);
  });

  it("keeps head and tail of oversized output with an exact omitted-bytes marker", () => {
    const stdout = `HEAD_LINE\n${"x".repeat(300 * 1024)}\nTAIL_LINE`;
    const maximum = 128 * 1024;
    const bounded = workspaceMcpFailure(wire({ ok: true, data: { exitCode: 2, stdout, stderr: "" } }, false), maximum, "sandbox_exec")!;
    const text = bounded.content[0]!.text!;
    expect(bounded).toMatchObject({ truncated: true });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(maximum);
    expect(Buffer.byteLength(text)).toBeGreaterThan(maximum - 64);
    const data = JSON.parse(text).data;
    expect(data.truncated).toBe(true);
    expect(data.stdout.startsWith("HEAD_LINE")).toBe(true);
    expect(data.stdout.endsWith("TAIL_LINE")).toBe(true);
    const marker = /\n… \[(\d+) bytes omitted\] …\n/u.exec(data.stdout)!;
    const kept = Buffer.byteLength(data.stdout) - Buffer.byteLength(marker[0]);
    expect(kept + Number(marker[1])).toBe(Buffer.byteLength(stdout));
  });

  it("does not infer missing, denied, timeout or retry from opaque text or nested causes", () => {
    for (const error of [
      { code: "operation_failed", message: "ENOENT EACCES timeout /host/PRIVATE_PATH?token=PRIVATE_TOKEN", cause: { code: "ENOENT" } },
      { code: "exec_failed", details: { exitCode: -1 }, message: "PRIVATE_EXCEPTION" },
      { code: "unreviewed", message: "PRIVATE_EXCEPTION", headers: { authorization: "PRIVATE_TOKEN" } }
    ]) {
      const result = workspaceMcpFailure(wire({ error }), 1024, "sandbox_exec")!;
      expect(result).toMatchObject({ status: "error", errorCode: "workspace_operation_failed" });
      expect(result.exitCode).toBeUndefined();
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|ENOENT|EACCES/u);
    }
    expect(workspaceMcpFailure({ isError: true, content: [{ type: "text", text: "x".repeat(32768) }] }, 1024, "sandbox_fs_read"))
      .toEqual(workspaceOperationFailureResult("workspace_operation_failed"));
  });

  it("keeps encoded command diagnostics within the configured output boundary", () => {
    const result = workspaceMcpFailure(wire({ ok: true, data: { exitCode: 9, stderr: "\u0001".repeat(2000) } }, false), 1024, "sandbox_exec")!;
    expect(Buffer.byteLength(result.content[0]!.text!)).toBeLessThanOrEqual(1024);
    expect(result).toMatchObject({ errorCode: "workspace_command_failed", exitCode: 9 });
  });

  it.each([1024, 4096, 128 * 1024])("bounds escape-heavy output by its serialized size, maximum=%i", maximum => {
    // Sized to stay inside the upstream parse bound while exceeding the budget after cleanup.
    const noisy = "\"\\\t\u0001\u001b[31m\ud800😀é\u2028".repeat(maximum / 8);
    const result = workspaceMcpFailure(wire({ ok: true, data: { exitCode: 4, stdout: noisy, stderr: noisy } }, false), maximum, "sandbox_shell")!;
    const text = result.content[0]!.text!;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(maximum);
    expect(Buffer.byteLength(text)).toBeGreaterThan(maximum - 64);
    const data = JSON.parse(text).data;
    expect(data).toMatchObject({ exitCode: 4, truncated: true });
    for (const stream of [data.stdout, data.stderr]) {
      expect(stream).not.toMatch(/[\u0001\u001b]/u);
      // An emoji is never split into a lone surrogate half at a cut.
      expect(stream).not.toMatch(/\ud83d|\ude00/u);
    }
    expect(data.stderr).toMatch(/bytes omitted/u);
  });

  it("uses the actual upstream policy code without exposing the denied host path", () => {
    const result = workspaceMcpFailure(wire({ error: { code: "host_path_denied", message: "PRIVATE_HOST_PATH", details: { path: "PRIVATE_HOST_PATH" } } }), 4096, "sandbox_fs_read");
    expect(result).toMatchObject({ errorCode: "workspace_path_access_denied" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_HOST_PATH");
  });

  it("does not interpret file contents or an async poll as a synchronous command failure", () => {
    expect(workspaceMcpFailure(wire({ data: { exitCode: 9 } }, false), 4096, "sandbox_fs_read")).toBeNull();
    expect(workspaceMcpFailure(wire({ data: { done: true, exitStatus: { code: 9 }, events: [] } }, false), 4096, "sandbox_exec_poll")).toBeNull();
    expect(workspaceMcpFailure(wire({ data: { exitCode: 0 } }, false), 4096, "sandbox_shell")).toBeNull();
  });
});

describe("Workspace command failure telemetry", () => {
  const records = async (code: "workspace_command_failed" | "workspace_operation_failed") => {
    const observation = await captureRunObservation();
    await observeWorkspaceToolExecution(async () => retainWorkspaceResultCode({ status: "error" as const }, code));
    return observation.records().filter((record) => record.event === "tool_execution" && record.outcome === "failed");
  };

  it("logs a model command's non-zero exit as the tool's result, not as an error", async () => {
    const result = workspaceMcpFailure(wire({ ok: true, data: { exitCode: 1, stdout: "", stderr: "no match" } }, false), 4096, "sandbox_shell")!;
    expect(result.errorCode).toBe("workspace_command_failed");
    const failed = await records(result.errorCode as "workspace_command_failed");
    expect(failed.map((record) => [record.stage, record.code, record.level])).toEqual([
      ["execution", "workspace_command_failed", "info"], ["result", "workspace_command_failed", "info"]]);
  });

  it("keeps a failed workspace operation an error", async () => {
    const failed = await records("workspace_operation_failed");
    expect(failed.map((record) => [record.stage, record.level])).toEqual([["execution", "error"], ["result", "error"]]);
  });
});
