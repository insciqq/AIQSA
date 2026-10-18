import { describe, expect, it } from "vitest";
import { WorkspaceRuntimeError } from "./runtime";
import { WorkspaceCaptureError, workspaceCaptureFailure } from "./selectedCapture";

describe("selected capture runner refusals", () => {
  it.each([
    ["workspace_capture_source_invalid", "workspace_capture_source_invalid"],
    ["workspace_capture_source_busy", "workspace_capture_busy"],
    ["workspace_capture_unsupported", "workspace_capture_unsupported"],
    ["workspace_output_limit_exceeded", "workspace_capture_limit_exceeded"]
  ] as const)("translates %s into %s", (runnerCode, code) => {
    const translated = workspaceCaptureFailure(new WorkspaceRuntimeError(runnerCode));
    expect(translated).toBeInstanceOf(WorkspaceCaptureError);
    expect(translated).toMatchObject({ name: "WorkspaceCaptureError", code, message: code });
  });

  it("passes every other failure through unchanged", () => {
    for (const error of [new WorkspaceRuntimeError("workspace_tool_timeout"), new WorkspaceRuntimeError("workspace_output_export_failed"),
      new WorkspaceCaptureError("workspace_capture_stale"), new Error("workspace_capture_source_invalid"), "workspace_capture_source_invalid"])
      expect(workspaceCaptureFailure(error)).toBe(error);
  });
});
