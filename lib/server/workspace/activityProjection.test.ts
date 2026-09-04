import { describe, expect, it } from "vitest";
import type { ToolExecutionResult } from "@/lib/server/tools/types";
import { decodeThreadWorkspaceActivityEntry } from "@/lib/contracts/workspace";
import {
  boundedOutputPreview,
  commandPreview,
  displayPath,
  foldWorkspaceActivityEntries,
  projectWorkspaceActivity,
  workspaceActivityEvent,
  workspaceExecutionGroupId,
  workspaceLifecycleActivity,
  type ExecOutputBuffer
} from "./activityProjection";
import { isRunOutputArtifactEvent, projectRunOutputArtifactEvent } from "@/lib/server/runs/runOutputEvents";

function official(data: unknown, status: "complete" | "error" = "complete"): ToolExecutionResult {
  return {
    callId: "call",
    content: [{
      text: JSON.stringify(status === "complete"
        ? { data, ok: true }
        : { error: { code: "operation_failed", message: "failed" }, ok: false }),
      type: "text"
    }],
    name: "mcp_workspace_tool",
    rawPreview: { truncated: false },
    status
  };
}

describe("workspace activity projection", () => {
  it("projects commands with exit code, bounded output, and no raw identifiers", () => {
    const entry = projectWorkspaceActivity({
      arguments: { command: "npm test\necho ignored", cwd: "/workspace/project" },
      callId: "toolcall-1",
      durationMs: 3_700,
      originalName: "sandbox_shell",
      result: official({ exitCode: 1, stderr: "TypeError: boom", stdout: "18 tests", success: false }),
      runId: "run-1",
      startedAt: new Date("2026-09-04T10:00:00.000Z")
    }, "settled");
    expect(entry).toEqual({
      command: {
        cwd: "project",
        exitCode: 1,
        preview: "npm test",
        stderrPreview: "TypeError: boom",
        stdoutPreview: "18 tests"
      },
      durationMs: 3_700,
      id: expect.stringMatching(/^call:[a-f0-9]{24}$/u),
      kind: "command",
      phase: "failed",
      startedAt: "2026-09-04T10:00:00.000Z"
    });
    expect(JSON.stringify(entry)).not.toContain("sandbox");
    expect(decodeThreadWorkspaceActivityEntry(entry)).toEqual(entry);

    const running = projectWorkspaceActivity({
      arguments: { args: ["-la", "my dir"], command: "ls" },
      callId: "toolcall-2",
      originalName: "sandbox_exec",
      runId: "run-1"
    }, "running");
    expect(running).toMatchObject({ command: { preview: 'ls -la "my dir"' }, kind: "command", phase: "running" });
  });

  it("maps file operations to /workspace-relative paths and original inbox names", () => {
    const inboxNames = new Map([[
      "/workspace/inbox/messages/msg1/att1--report.xlsx",
      "Quarterly report.xlsx"
    ]]);
    const copy = projectWorkspaceActivity({
      arguments: {
        from: "/workspace/inbox/messages/msg1/att1--report.xlsx",
        to: "/workspace/project/report.xlsx"
      },
      callId: "toolcall-3",
      inboxNames,
      originalName: "sandbox_fs_copy",
      result: official({ copied: true }),
      runId: "run-1"
    }, "settled");
    expect(copy).toMatchObject({
      file: { displayPath: "inbox/Quarterly report.xlsx", targetPath: "project/report.xlsx" },
      kind: "file_copy",
      phase: "succeeded"
    });
    expect(displayPath("/workspace/inbox/messages/msg9/att9--unknown.bin")).toBe("inbox/unknown.bin");
    expect(displayPath("/workspace")).toBe(".");
    const write = projectWorkspaceActivity({
      arguments: { content: "héllo", path: "/workspace/output/run-1/report.md" },
      callId: "toolcall-4",
      originalName: "sandbox_fs_write",
      result: official({ written: 6 }),
      runId: "run-1"
    }, "settled");
    expect(write).toMatchObject({ file: { byteSize: 6, displayPath: "output/run-1/report.md" }, kind: "file_write" });
    const check = projectWorkspaceActivity({
      arguments: { path: "/workspace/project/a.txt" },
      callId: "toolcall-5",
      originalName: "sandbox_fs_exists",
      result: official({ exists: false }, "error"),
      runId: "run-1"
    }, "settled");
    expect(check).toMatchObject({ kind: "file_check", phase: "failed" });
    expect(projectWorkspaceActivity({
      arguments: { data: "input", execSessionId: "x" },
      callId: "toolcall-6",
      originalName: "sandbox_exec_write_stdin",
      result: official({ accepted: true }),
      runId: "run-1"
    }, "settled")).toBeNull();
  });

  it("groups start, polls, and close of one execution into a single entry", () => {
    const execOutputs = new Map<string, ExecOutputBuffer>();
    const groupId = workspaceExecutionGroupId("run-1", "exec-abc");
    const started = projectWorkspaceActivity({
      arguments: { command: "pytest -q", shell: true },
      callId: "toolcall-7",
      execOutputs,
      originalName: "sandbox_exec_start",
      result: official({ execSessionId: "exec-abc" }),
      runId: "run-1"
    }, "settled");
    expect(started).toEqual({
      command: { preview: "pytest -q" },
      groupId,
      id: groupId,
      kind: "command",
      phase: "running"
    });
    const quiet = projectWorkspaceActivity({
      arguments: { execSessionId: "exec-abc" },
      callId: "toolcall-8",
      execOutputs,
      originalName: "sandbox_exec_poll",
      result: official({ done: false, error: null, events: [], exitStatus: null, nextCursor: 0 }),
      runId: "run-1"
    }, "settled");
    expect(quiet).toBeNull();
    const chunk = projectWorkspaceActivity({
      arguments: { execSessionId: "exec-abc" },
      callId: "toolcall-9",
      execOutputs,
      originalName: "sandbox_exec_poll",
      result: official({
        done: false,
        events: [{ event: { data: "collecting…\n", kind: "stdout" } }, { event: { data: "warn\n", kind: "stderr" } }],
        exitStatus: null
      }),
      runId: "run-1"
    }, "settled");
    expect(chunk).toMatchObject({ command: { preview: "…", stderrPreview: "warn\n", stdoutPreview: "collecting…\n" }, id: groupId, phase: "running" });
    const finished = projectWorkspaceActivity({
      arguments: { execSessionId: "exec-abc" },
      callId: "toolcall-10",
      execOutputs,
      originalName: "sandbox_exec_poll",
      result: official({
        done: true,
        events: [{ event: { data: "18 passed\n", kind: "stdout" } }],
        exitStatus: { code: 0 }
      }),
      runId: "run-1"
    }, "settled");
    expect(finished).toMatchObject({
      command: { exitCode: 0, stdoutPreview: "collecting…\n18 passed\n" },
      id: groupId,
      phase: "succeeded"
    });
    const closed = projectWorkspaceActivity({
      arguments: { execSessionId: "exec-abc" },
      callId: "toolcall-11",
      execOutputs,
      originalName: "sandbox_exec_close",
      result: official({ closed: true }),
      runId: "run-1"
    }, "settled");
    expect(closed).toMatchObject({ id: groupId, phase: "succeeded" });
    const folded = foldWorkspaceActivityEntries([started!, chunk!, finished!, closed!], null);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ command: { exitCode: 0, preview: "pytest -q" }, phase: "succeeded" });
  });

  it("keeps head and tail of oversized output inside 8 KiB without splitting characters", () => {
    const stdout = "Ж".repeat(6_000);
    const stderr = "é".repeat(6_000) + "END";
    const preview = boundedOutputPreview({ failed: true, stderr, stdout });
    const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
    expect(preview.truncated).toBe(true);
    expect(bytes(preview.stdoutPreview) + bytes(preview.stderrPreview)).toBeLessThanOrEqual(8 * 1_024);
    expect(preview.stderrPreview.endsWith("END")).toBe(true);
    expect(preview.stderrPreview).toContain("\n…\n");
    expect(bytes(preview.stderrPreview)).toBeGreaterThan(bytes(preview.stdoutPreview));
    for (const text of [preview.stdoutPreview, preview.stderrPreview]) {
      expect(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(text))).toBe(text);
    }
    expect(commandPreview({ command: "x".repeat(5_000) })?.length).toBe(2_048);
  });

  it("settles running entries from the run outcome and crosses the durable event boundary exactly", () => {
    const running = projectWorkspaceActivity({
      arguments: { command: "sleep 300" },
      callId: "toolcall-12",
      originalName: "sandbox_shell",
      runId: "run-1"
    }, "running")!;
    expect(foldWorkspaceActivityEntries([running], "cancelled")[0]).toMatchObject({ phase: "cancelled" });
    expect(foldWorkspaceActivityEntries([running], "failed")[0]).toMatchObject({ phase: "failed" });
    const lifecycle = workspaceLifecycleActivity({
      count: 2,
      kind: "attachments_prepare",
      ordinal: 1,
      phase: "succeeded",
      runId: "run-1"
    });
    const event = workspaceActivityEvent(lifecycle);
    const projected = projectRunOutputArtifactEvent(event);
    expect(projected).toEqual(event);
    expect(isRunOutputArtifactEvent(projected!)).toBe(true);
    expect(isRunOutputArtifactEvent({
      data: { artifactType: "workspace_activity", payload: { ...lifecycle, runtimeSandboxId: "leak" } },
      type: "artifact"
    })).toBe(false);
    expect(projectRunOutputArtifactEvent({
      data: { artifactType: "workspace_activity", payload: { id: "bad id!", kind: "command", phase: "running" } },
      type: "artifact"
    })).toBeNull();
  });
});
