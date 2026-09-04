import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
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
