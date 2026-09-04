import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  workspaceAttachmentPath,
  workspaceRunOutputDirectory,
  workspaceSandboxName
} from "@/lib/domain/workspace";
import { getWorkspaceConfig } from "./config";
import { DeterministicWorkspaceRuntime } from "./deterministicRuntime";

const config = getWorkspaceConfig({
  AIQSA_TEST_MODE: "1",
  AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1",
  NODE_ENV: "test"
});

function stream(value: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(value);
      controller.close();
    }
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    size += next.value.byteLength;
  }
  reader.releaseLock();
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

describe("deterministic Workspace runtime", () => {
  it("uses the official catalog and preserves staged/project state across stop/start", async () => {
    const runtime = new DeterministicWorkspaceRuntime(config);
    await expect(runtime.health()).resolves.toMatchObject({ state: "ready" });
    const sessionId = "0199aabc-12ef-7abc-8abc-0123456789ab";
    const sandboxName = workspaceSandboxName(sessionId);
    const created = await runtime.ensureSession({
      cpus: config.cpus,
      diskMiB: config.diskMiB,
      imageRef: config.imageRef,
      internetEnabled: true,
      memoryMiB: config.memoryMiB,
      runtimeSandboxId: null,
      sandboxName,
      sessionId
    });
    const catalog = await runtime.loadBoundTools({
      runtimeSandboxId: created.runtimeSandboxId,
      sessionId
    });
    expect(catalog.tools).toHaveLength(16);

    const attachment = new TextEncoder().encode("opaque bytes\0");
    const attachmentPath = workspaceAttachmentPath({
      attachmentId: "att_1",
      messageId: "msg_1",
      originalName: "payload.bin"
    });
    await runtime.stageAttachments({
      attachments: [{
        attachmentId: "att_1",
        body: stream(attachment),
        byteSize: attachment.byteLength,
        checksum: createHash("sha256").update(attachment).digest("hex"),
        kind: "file",
        messageId: "msg_1",
        mimeType: "application/octet-stream",
        originalName: "payload.bin",
        sandboxPath: attachmentPath
      }],
      inboxIndex: { attachments: [{ attachmentId: "att_1" }] },
      manifests: [{ body: { attachments: [{ attachmentId: "att_1" }] }, messageId: "msg_1" }],
      runtimeSandboxId: created.runtimeSandboxId,
      sessionId
    });

    await runtime.callBoundTool({
      arguments: {
        content: "generated",
        path: `${workspaceRunOutputDirectory("run_1")}/result.tar.gz`
      },
      modelRunId: "run_1",
      modelRunToolCallId: "call_1",
      originalName: "sandbox_fs_write",
      runtimeSandboxId: created.runtimeSandboxId,
      sessionId
    });
    const beforeStop = await runtime.callBoundTool({
      arguments: { path: attachmentPath },
      modelRunId: "run_1",
      modelRunToolCallId: "call_2",
      originalName: "sandbox_fs_read",
      runtimeSandboxId: created.runtimeSandboxId,
      sessionId
    });
    expect(beforeStop.content[0]?.text).toContain("opaque bytes");

    await runtime.stopSession({
      runtimeSandboxId: created.runtimeSandboxId,
      sessionId
    });
    const restarted = await runtime.ensureSession({
      cpus: config.cpus,
      diskMiB: config.diskMiB,
      imageRef: config.imageRef,
      internetEnabled: true,
      memoryMiB: config.memoryMiB,
      runtimeSandboxId: created.runtimeSandboxId,
      sandboxName,
      sessionId
    });
    expect(restarted.runtimeSandboxId).toBe(created.runtimeSandboxId);
    const outputs = await runtime.collectOutputs({
      modelRunId: "run_1",
      outputDirectory: workspaceRunOutputDirectory("run_1"),
      runtimeSandboxId: restarted.runtimeSandboxId,
      sessionId
    });
    expect(outputs).toHaveLength(1);
    expect(new TextDecoder().decode(await collect(outputs[0]!.body))).toBe("generated");
    expect(outputs[0]!.checksum).toBe(createHash("sha256").update("generated").digest("hex"));
    expect(outputs[0]!.mimeType).toBe("application/gzip");

    await runtime.callBoundTool({
      arguments: {
        content: "persisted project file",
        path: "/workspace/project/marker.txt"
      },
      modelRunId: "run_1",
      modelRunToolCallId: "call_3",
      originalName: "sandbox_fs_write",
      runtimeSandboxId: restarted.runtimeSandboxId,
      sessionId
    });
    const projectArchive = await runtime.createProjectArchive({
      runtimeSandboxId: restarted.runtimeSandboxId,
      sessionId
    });
    const archiveBytes = await collect(projectArchive.body);
    const tarBytes = gunzipSync(archiveBytes);
    expect(Buffer.from(tarBytes).includes(Buffer.from("marker.txt"))).toBe(true);
    expect(Buffer.from(tarBytes).includes(Buffer.from("persisted project file"))).toBe(true);
    expect(projectArchive.checksum).toBe(createHash("sha256").update(archiveBytes).digest("hex"));
  });

  it("binds long exec ids to one run and removes state idempotently", async () => {
    const runtime = new DeterministicWorkspaceRuntime(config);
    const sessionId = "0199aabc-12ef-7abc-8abc-0123456789ac";
    const session = await runtime.ensureSession({
      cpus: 2,
      diskMiB: 10_240,
      imageRef: config.imageRef,
      internetEnabled: false,
      memoryMiB: 4_096,
      runtimeSandboxId: null,
      sandboxName: workspaceSandboxName(sessionId),
      sessionId
    });
    const started = await runtime.callBoundTool({
      arguments: { command: "sleep 60" },
      modelRunId: "run_a",
      modelRunToolCallId: "call_a",
      originalName: "sandbox_exec_start",
      runtimeSandboxId: session.runtimeSandboxId,
      sessionId
    });
    const id = (JSON.parse(started.content[0]!.text!) as { data: { execSessionId: string } }).data.execSessionId;
    await expect(runtime.callBoundTool({
      arguments: { execSessionId: id },
      modelRunId: "run_b",
      modelRunToolCallId: "call_b",
      originalName: "sandbox_exec_poll",
      runtimeSandboxId: session.runtimeSandboxId,
      sessionId
    })).resolves.toMatchObject({ status: "error" });
    await expect(runtime.collectOutputs({
      modelRunId: "run_a",
      outputDirectory: workspaceRunOutputDirectory("run_a"),
      runtimeSandboxId: session.runtimeSandboxId,
      sessionId
    })).resolves.toEqual([]);
    await expect(runtime.callBoundTool({
      arguments: { execSessionId: id },
      modelRunId: "run_a",
      modelRunToolCallId: "call_c",
      originalName: "sandbox_exec_poll",
      runtimeSandboxId: session.runtimeSandboxId,
      sessionId
    })).resolves.toMatchObject({ status: "error" });
    await runtime.removeSession({ runtimeSandboxId: session.runtimeSandboxId, sessionId });
    await runtime.removeSession({ runtimeSandboxId: session.runtimeSandboxId, sessionId });
    await expect(runtime.ensureSession({
      cpus: 2,
      diskMiB: 10_240,
      imageRef: config.imageRef,
      internetEnabled: false,
      memoryMiB: 4_096,
      runtimeSandboxId: session.runtimeSandboxId,
      sandboxName: workspaceSandboxName(sessionId),
      sessionId
    })).rejects.toThrow("workspace_session_lost");
  });
});

describe("deterministic Workspace harness", () => {
  async function session(runtime: DeterministicWorkspaceRuntime, sessionId: string) {
    return runtime.ensureSession({
      cpus: 2,
      diskMiB: 10_240,
      imageRef: config.imageRef,
      internetEnabled: false,
      memoryMiB: 4_096,
      runtimeSandboxId: null,
      sandboxName: workspaceSandboxName(sessionId),
      sessionId
    });
  }

  function execId(result: Awaited<ReturnType<DeterministicWorkspaceRuntime["callBoundTool"]>>): string {
    return (JSON.parse(result.content[0]!.text!) as { data: { execSessionId: string } }).data.execSessionId;
  }

  it("prevents the delayed side effect of a quiesced async execution", async () => {
    vi.useFakeTimers();
    try {
      const runtime = new DeterministicWorkspaceRuntime(config);
      const sessionId = "0199aabc-12ef-7abc-8abc-0123456789b1";
      const created = await session(runtime, sessionId);
      const call = (originalName: "sandbox_exec_start" | "sandbox_exec_poll" | "sandbox_exec_signal" | "sandbox_exec_close" | "sandbox_fs_exists", args: Record<string, unknown>, id = "call") =>
        runtime.callBoundTool({
          arguments: args,
          modelRunId: "run_async",
          modelRunToolCallId: `${id}_${originalName}`,
          originalName,
          runtimeSandboxId: created.runtimeSandboxId,
          sessionId
        });

      const stopped = execId(await call("sandbox_exec_start", {
        command: "sleep 12 && echo late > /workspace/project/after-stop.txt"
      }, "stopped"));
      await expect(call("sandbox_exec_poll", { execSessionId: stopped })).resolves.toMatchObject({
        content: [{ text: expect.stringContaining("\"done\":false") }]
      });
      await call("sandbox_exec_signal", { execSessionId: stopped, signal: "term" });
      await vi.advanceTimersByTimeAsync(13_000);
      await expect(call("sandbox_fs_exists", { path: "/workspace/project/after-stop.txt" })).resolves.toMatchObject({
        content: [{ text: expect.stringContaining("\"exists\":false") }]
      });
      await expect(call("sandbox_exec_poll", { execSessionId: stopped })).resolves.toMatchObject({
        content: [{ text: expect.stringContaining("\"exitStatus\":{\"code\":143}") }]
      });

      const completed = execId(await call("sandbox_exec_start", {
        command: "sleep 2; touch /workspace/project/after-delay.txt"
      }, "completed"));
      await vi.advanceTimersByTimeAsync(2_500);
      await expect(call("sandbox_fs_exists", { path: "/workspace/project/after-delay.txt" })).resolves.toMatchObject({
        content: [{ text: expect.stringContaining("\"exists\":true") }]
      });
      await expect(call("sandbox_exec_poll", { execSessionId: completed })).resolves.toMatchObject({
        content: [{ text: expect.stringContaining("\"done\":true") }]
      });

      execId(await call("sandbox_exec_start", {
        command: "sleep 5 && echo late > /workspace/project/after-vm-stop.txt"
      }, "vm"));
      await runtime.stopSession({ runtimeSandboxId: created.runtimeSandboxId, sessionId });
      await vi.advanceTimersByTimeAsync(6_000);
      await runtime.ensureSession({
        cpus: 2,
        diskMiB: 10_240,
        imageRef: config.imageRef,
        internetEnabled: false,
        memoryMiB: 4_096,
        runtimeSandboxId: created.runtimeSandboxId,
        sandboxName: workspaceSandboxName(sessionId),
        sessionId
      });
      await expect(call("sandbox_fs_exists", { path: "/workspace/project/after-vm-stop.txt" })).resolves.toMatchObject({
        content: [{ text: expect.stringContaining("\"exists\":false") }]
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a synchronous sleep on abort without writing its marker", async () => {
    vi.useFakeTimers();
    try {
      const runtime = new DeterministicWorkspaceRuntime(config);
      const sessionId = "0199aabc-12ef-7abc-8abc-0123456789b2";
      const created = await session(runtime, sessionId);
      const controller = new AbortController();
      const pending = runtime.callBoundTool({
        arguments: { command: "sleep 300 && echo late > /workspace/project/late.txt" },
        modelRunId: "run_sync",
        modelRunToolCallId: "call_sync",
        originalName: "sandbox_shell",
        runtimeSandboxId: created.runtimeSandboxId,
        sessionId,
        signal: controller.signal
      });
      await vi.advanceTimersByTimeAsync(1_000);
      controller.abort();
      await expect(pending).rejects.toThrow("workspace_tool_cancelled");
      await vi.advanceTimersByTimeAsync(400_000);
      await expect(runtime.callBoundTool({
        arguments: { path: "/workspace/project/late.txt" },
        modelRunId: "run_sync",
        modelRunToolCallId: "call_exists",
        originalName: "sandbox_fs_exists",
        runtimeSandboxId: created.runtimeSandboxId,
        sessionId
      })).resolves.toMatchObject({ content: [{ text: expect.stringContaining("\"exists\":false") }] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports staging metrics, arms one-shot export faults, and can lose its session", async () => {
    const runtime = new DeterministicWorkspaceRuntime(config);
    const sessionId = "0199aabc-12ef-7abc-8abc-0123456789b3";
    const created = await session(runtime, sessionId);
    const payload = new TextEncoder().encode("staged");
    const attachment = {
      attachmentId: "att_metrics",
      byteSize: payload.byteLength,
      checksum: createHash("sha256").update(payload).digest("hex"),
      kind: "file" as const,
      messageId: "msg_metrics",
      mimeType: "application/octet-stream",
      originalName: "payload.bin",
      sandboxPath: workspaceAttachmentPath({
        attachmentId: "att_metrics",
        messageId: "msg_metrics",
        originalName: "payload.bin"
      })
    };
    const stage = (attachments: (typeof attachment)[]) => runtime.stageAttachments({
      attachments: attachments.map((entry) => ({ ...entry, body: stream(payload) })),
      inboxIndex: { attachments: [] },
      manifests: [],
      outputDirectory: workspaceRunOutputDirectory("run_metrics"),
      runtimeSandboxId: created.runtimeSandboxId,
      sessionId
    });
    await stage([attachment]);
    await stage([]);
    expect(runtime.metrics(sessionId)).toEqual({
      guestFileWrites: 1,
      indexWrites: 2,
      lastStagedAttachmentIds: [],
      stageCalls: 2,
      stagedAttachmentBodies: 1
    });
    const shell = (command: string, id: string) => runtime.callBoundTool({
      arguments: { command },
      modelRunId: "run_metrics",
      modelRunToolCallId: id,
      originalName: "sandbox_shell",
      runtimeSandboxId: created.runtimeSandboxId,
      sessionId
    });
    const metrics = await shell("aiqsa-test metrics", "call_metrics");
    expect(JSON.parse((JSON.parse(metrics.content[0]!.text!) as { data: { stdout: string } }).data.stdout)).toMatchObject({
      stageCalls: 2,
      stagedAttachmentBodies: 1
    });
    await expect(shell("aiqsa-test unknown", "call_unknown")).resolves.toMatchObject({ exitCode: 127 });

    await runtime.callBoundTool({
      arguments: { content: "first", path: `${workspaceRunOutputDirectory("run_metrics")}/a.txt` },
      modelRunId: "run_metrics",
      modelRunToolCallId: "call_write_a",
      originalName: "sandbox_fs_write",
      runtimeSandboxId: created.runtimeSandboxId,
      sessionId
    });
    await runtime.callBoundTool({
      arguments: { content: "second", path: `${workspaceRunOutputDirectory("run_metrics")}/b.txt` },
      modelRunId: "run_metrics",
      modelRunToolCallId: "call_write_b",
      originalName: "sandbox_fs_write",
      runtimeSandboxId: created.runtimeSandboxId,
      sessionId
    });
    const outputs = () => runtime.collectOutputs({
      modelRunId: "run_metrics",
      outputDirectory: workspaceRunOutputDirectory("run_metrics"),
      runtimeSandboxId: created.runtimeSandboxId,
      sessionId
    });
    await shell("aiqsa-test fault export-list-once", "call_fault_list");
    await expect(outputs()).rejects.toThrow("workspace_output_export_failed");
    await expect(outputs()).resolves.toHaveLength(2);

    await shell("aiqsa-test fault export-stream-once", "call_fault_stream");
    const faulted = await outputs();
    expect(new TextDecoder().decode(await collect(faulted[0]!.body))).toBe("first");
    await expect(collect(faulted[1]!.body)).rejects.toThrow("workspace_output_export_failed");
    const healthy = await outputs();
    expect(new TextDecoder().decode(await collect(healthy[1]!.body))).toBe("second");

    await expect(shell("aiqsa-test lose-session", "call_lose")).resolves.toMatchObject({ exitCode: 0 });
    await expect(shell("pwd", "call_after_loss")).rejects.toThrow("workspace_session_lost");
    const recreated = await session(runtime, sessionId);
    expect(recreated.runtimeSandboxId).not.toBe(created.runtimeSandboxId);
    expect(runtime.metrics(sessionId)).toMatchObject({ stageCalls: 0 });
  });
});
