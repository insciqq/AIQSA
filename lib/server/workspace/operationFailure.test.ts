import { describe, expect, it } from "vitest";
import { workspaceMcpFailure, workspaceOperationFailureResult } from "./operationFailure";

const wire = (value: unknown, isError = true) => ({ isError, content: [{ type: "text", text: JSON.stringify(value) }] });
describe("Workspace confirmed operation failures", () => {
  it.each([true, false])("retains known nonzero and bounded output without upstream diagnostics, isError=%s", isError => {
    const output = { exitCode: 3, stdout: "output ".repeat(2000), stderr: "failure ".repeat(2000), private: "PRIVATE_DETAIL" };
    const upstream = isError ? { ok: false, error: { code: "exec_failed", message: "PRIVATE_EXCEPTION", details: output } } : { ok: true, data: output };
    const result = workspaceMcpFailure(wire(upstream, isError), 65536, "sandbox_shell")!;
    expect(result).toMatchObject({ status: "error", exitCode: 3, errorCode: "workspace_command_failed", truncated: true });
    const envelope = JSON.parse(result.content[0]!.text!);
    expect(envelope.data.exitCode).toBe(3);
    expect(Buffer.byteLength(envelope.data.stdout + envelope.data.stderr)).toBeLessThanOrEqual(8192);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
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
