import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  workspaceAttachmentPath,
  workspaceRunOutputDirectory,
  workspaceSandboxName
} from "@/lib/domain/workspace";
import { getWorkspaceConfig, type WorkspaceConfig } from "./config";
import { DeterministicWorkspaceRuntime } from "./deterministicRuntime";
import { RemoteWorkspaceRuntime } from "./remoteRuntime";
import { createWorkspaceRunnerServer } from "./runnerServer";

const token = "workspace-runner-test-token-that-is-long-enough";
const deterministicConfig = getWorkspaceConfig({
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
  const response = await new Response(body).arrayBuffer();
  return new Uint8Array(response);
}

describe("remote Workspace runner protocol", () => {
  const servers: ReturnType<typeof createWorkspaceRunnerServer>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    })));
  });

  it("authenticates and preserves streamed data across the HTTP boundary", async () => {
    const server = createWorkspaceRunnerServer({
      runtime: new DeterministicWorkspaceRuntime(deterministicConfig),
      token
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const runnerUrl = new URL(`http://127.0.0.1:${address.port}`);

    const unauthorized = await fetch(new URL("/health", runnerUrl));
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "workspace_runtime_unavailable" });

    const remoteConfig: WorkspaceConfig = {
      ...deterministicConfig,
      runnerToken: token,
      runnerUrl,
      runtimeMode: "remote"
    };
    const runtime = new RemoteWorkspaceRuntime(remoteConfig);
    await expect(runtime.health()).resolves.toMatchObject({ state: "ready" });

    const sessionId = "0199aabc-12ef-7abc-8abc-0123456789ad";
    const session = await runtime.ensureSession({
      cpus: remoteConfig.cpus,
      diskMiB: remoteConfig.diskMiB,
      imageRef: remoteConfig.imageRef,
      internetEnabled: false,
      memoryMiB: remoteConfig.memoryMiB,
      runtimeSandboxId: null,
      sandboxName: workspaceSandboxName(sessionId),
      sessionId
    });
    const catalog = await runtime.loadBoundTools({
      runtimeSandboxId: session.runtimeSandboxId,
      sessionId
    });
    expect(catalog.tools).toHaveLength(16);

    const attachment = new TextEncoder().encode("streamed opaque bytes\0");
    const sandboxPath = workspaceAttachmentPath({
      attachmentId: "att_http_1",
      messageId: "msg_http_1",
      originalName: "payload.bin"
    });
    await runtime.stageAttachments({
      attachments: [{
        attachmentId: "att_http_1",
        body: stream(attachment),
        byteSize: attachment.byteLength,
        checksum: createHash("sha256").update(attachment).digest("hex"),
        kind: "file",
        messageId: "msg_http_1",
        mimeType: "application/octet-stream",
        originalName: "payload.bin",
        sandboxPath
      }],
      inboxIndex: {
        attachments: [{
          attachmentId: "att_http_1",
          byteSize: attachment.byteLength,
          checksum: createHash("sha256").update(attachment).digest("hex"),
          sandboxPath
        }],
        manifests: [],
        version: 1
      },
      manifests: [{ body: { attachments: [{ attachmentId: "att_http_1" }] }, messageId: "msg_http_1" }],
      runtimeSandboxId: session.runtimeSandboxId,
      sessionId
    });
    const started = await runtime.callBoundTool({
      arguments: { command: "sleep 30" },
      modelRunId: "run_http_1",
      modelRunToolCallId: "call_http_start",
      originalName: "sandbox_exec_start",
      runtimeSandboxId: session.runtimeSandboxId,
      sessionId
    });
    expect(started.execSessionId).toMatch(/^[a-f0-9]{32}$/u);
    await expect(runtime.terminateExecutions({
      executions: [
        { modelRunId: "run_http_1", runtimeExecSessionId: started.execSessionId! },
        { modelRunId: "run_http_1", runtimeExecSessionId: "unknown-exec" }
      ],
      runtimeSandboxId: session.runtimeSandboxId,
      sessionId
    })).resolves.toEqual([
      { outcome: "closed", runtimeExecSessionId: started.execSessionId },
      { outcome: "unknown", runtimeExecSessionId: "unknown-exec" }
    ]);
    const oversized = await fetch(
      new URL(`/v1/sessions/${sessionId}/executions/terminate`, runnerUrl),
      {
        body: JSON.stringify({
          executions: Array.from({ length: 257 }, (_, index) => ({
            modelRunId: "run_http_1",
            runtimeExecSessionId: `exec-${index}`
          })),
          runtimeSandboxId: session.runtimeSandboxId
        }),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        method: "POST"
      }
    );
    expect(oversized.status).toBe(400);

    await expect(runtime.listStagedAttachments({
      runtimeSandboxId: session.runtimeSandboxId,
      sessionId
    })).resolves.toEqual([{
      attachmentId: "att_http_1",
      byteSize: attachment.byteLength,
      checksum: createHash("sha256").update(attachment).digest("hex"),
      sandboxPath
    }]);
    const staged = await runtime.callBoundTool({
      arguments: { path: sandboxPath },
      modelRunId: "run_http_1",
      modelRunToolCallId: "call_http_read",
      originalName: "sandbox_fs_read",
      runtimeSandboxId: session.runtimeSandboxId,
      sessionId
    });
    expect(staged.content[0]?.text).toContain("streamed opaque bytes");

    const outputDirectory = workspaceRunOutputDirectory("run_http_1");
    await runtime.callBoundTool({
      arguments: { content: "exported through runner", path: `${outputDirectory}/nested/result.txt` },
      modelRunId: "run_http_1",
      modelRunToolCallId: "call_http_write",
      originalName: "sandbox_fs_write",
      runtimeSandboxId: session.runtimeSandboxId,
      sessionId
    });
    const outputs = await runtime.collectOutputs({
      modelRunId: "run_http_1",
      outputDirectory,
      runtimeSandboxId: session.runtimeSandboxId,
      sessionId
    });
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      mimeType: "text/plain",
      relativePath: "nested/result.txt"
    });
    const exported = await collect(outputs[0]!.body);
    expect(new TextDecoder().decode(exported)).toBe("exported through runner");
    expect(outputs[0]!.checksum).toBe(createHash("sha256").update(exported).digest("hex"));

    await runtime.stopSession({ runtimeSandboxId: session.runtimeSandboxId, sessionId });
    await runtime.removeSession({ runtimeSandboxId: session.runtimeSandboxId, sessionId });
    await expect(runtime.ensureSession({
      cpus: remoteConfig.cpus,
      diskMiB: remoteConfig.diskMiB,
      imageRef: remoteConfig.imageRef,
      internetEnabled: false,
      memoryMiB: remoteConfig.memoryMiB,
      runtimeSandboxId: session.runtimeSandboxId,
      sandboxName: workspaceSandboxName(sessionId),
      sessionId
    })).rejects.toThrow("workspace_session_lost");
  }, 30_000);
});

describe("remote Workspace output batches", () => {
  const servers: ReturnType<typeof createWorkspaceRunnerServer>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    })));
  });

  it("keeps a batch alive across a slow sequential export, releases it, and stays single-use", async () => {
    let now = 1_700_000_000_000;
    const server = createWorkspaceRunnerServer({
      now: () => now,
      runtime: new DeterministicWorkspaceRuntime(deterministicConfig),
      token
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const runtime = new RemoteWorkspaceRuntime({
      ...deterministicConfig,
      runnerToken: token,
      runnerUrl: new URL(`http://127.0.0.1:${address.port}`),
      runtimeMode: "remote"
    });
    const sessionId = "0199aabc-12ef-7abc-8abc-0123456789ae";
    const session = await runtime.ensureSession({
      cpus: deterministicConfig.cpus,
      diskMiB: deterministicConfig.diskMiB,
      imageRef: deterministicConfig.imageRef,
      internetEnabled: false,
      memoryMiB: deterministicConfig.memoryMiB,
      runtimeSandboxId: null,
      sandboxName: workspaceSandboxName(sessionId),
      sessionId
    });
    const outputDirectory = workspaceRunOutputDirectory("run_batch");
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      await runtime.callBoundTool({
        arguments: { content: `content ${name}`, path: `${outputDirectory}/${name}` },
        modelRunId: "run_batch",
        modelRunToolCallId: `call_${name}`,
        originalName: "sandbox_fs_write",
        runtimeSandboxId: session.runtimeSandboxId,
        sessionId
      });
    }
    const list = () => runtime.collectOutputs({
      modelRunId: "run_batch",
      outputDirectory,
      runtimeSandboxId: session.runtimeSandboxId,
      sessionId
    });

    const outputs = await list();
    expect(outputs).toHaveLength(3);
    expect(outputs[0]!.batchId).toMatch(/^[a-f0-9]{32}$/u);
    // Well past the old absolute five-minute TTL, still inside the inactivity window.
    now += 6 * 60_000;
    expect(new TextDecoder().decode(await collect(outputs[0]!.body))).toBe("content a.txt");
    // Opening a handle refreshed the batch, so a later slow file is still valid.
    now += 9 * 60_000;
    expect(new TextDecoder().decode(await collect(outputs[1]!.body))).toBe("content b.txt");
    // A handle never opened within the inactivity window expires.
    now += 11 * 60_000;
    await expect(collect(outputs[2]!.body)).rejects.toThrow("workspace_output_export_failed");

    const reopened = await list();
    // Every handle is single-use even inside a live batch.
    expect(new TextDecoder().decode(await collect(reopened[0]!.body))).toBe("content a.txt");
    const retry = await runtime.collectOutputs({
      modelRunId: "run_batch",
      outputDirectory,
      runtimeSandboxId: session.runtimeSandboxId,
      sessionId
    });
    await runtime.releaseOutputs({
      batchId: reopened[0]!.batchId!,
      runtimeSandboxId: session.runtimeSandboxId,
      sessionId
    });
    await expect(collect(reopened[1]!.body)).rejects.toThrow("workspace_output_export_failed");
    // Release is scoped to its own batch; a newer batch keeps working.
    expect(new TextDecoder().decode(await collect(retry[1]!.body))).toBe("content b.txt");

    // Abandoned batches always die after the absolute safety lifetime.
    const abandoned = await list();
    now += 7 * 60 * 60_000;
    await expect(collect(abandoned[0]!.body)).rejects.toThrow("workspace_output_export_failed");
  }, 30_000);
});
