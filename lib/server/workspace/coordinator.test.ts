import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_MCP_TOOL_ALLOWLIST,
  workspaceRunOutputDirectory
} from "@/lib/domain/workspace";
import type { NormalizedRunWorkspace } from "@/lib/server/providers/types";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import { getWorkspaceConfig } from "./config";
import {
  createWorkspaceCoordinator,
  type WorkspaceCoordinatorRepository,
  type WorkspaceExecutionBinding
} from "./coordinator";
import type {
  WorkspaceBoundTool,
  WorkspaceRuntime,
  WorkspaceToolResult
} from "./runtime";
import { WorkspaceRuntimeError } from "./runtime";
import { namespacedWorkspaceToolName } from "./toolCatalog";

const config = getWorkspaceConfig({
  AIQSA_TEST_MODE: "1",
  AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1",
  NODE_ENV: "test"
});

function body(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    }
  });
}

function fixture() {
  const tools: WorkspaceBoundTool[] = WORKSPACE_MCP_TOOL_ALLOWLIST.map((name) => ({
    description: name,
    inputSchema: { properties: {}, type: "object" },
    namespacedName: namespacedWorkspaceToolName(name),
    originalName: name
  }));
  const runId = "run_workspace_1";
  const shellToolName = namespacedWorkspaceToolName("sandbox_shell");
  const workspace: NormalizedRunWorkspace = {
    enabled: true,
    imageRef: config.imageRef,
    inboxIndexPath: "/workspace/inbox/index.json",
    internetEnabled: true,
    maxToolCalls: config.maxToolCalls,
    maxToolRounds: config.maxToolRounds,
    mcpVersion: "0.6.16",
    messageManifestPath: "/workspace/inbox/messages/message_1/manifest.json",
    outputDirectory: workspaceRunOutputDirectory(runId),
    projectDirectory: "/workspace/project",
    runtimeVersion: "0.6.16",
    sessionId: "session_workspace_1",
    syncToolTimeoutSeconds: 1,
    toolCatalogHash: "a".repeat(64),
    turnTimeoutSeconds: config.turnTimeoutSeconds
  };
  let runtimeSandboxId: string | null = null;
  let exportComplete = false;
  const files: Array<{
    attachmentId: string;
    byteSize: number;
    fileName: string;
    mimeType: string;
    relativePath: string;
  }> = [];
  const binding = (): WorkspaceExecutionBinding => ({
    assistantMessageId: "assistant_1",
    chatId: "chat_1",
    imageRef: workspace.imageRef,
    internetEnabled: workspace.internetEnabled,
    mcpVersion: workspace.mcpVersion,
    outputDirectory: workspace.outputDirectory,
    policyRevision: 1,
    projectId: null,
    runId,
    runtimeSandboxId,
    runtimeVersion: workspace.runtimeVersion,
    sandboxName: "aiqsa-ws-session_workspace_1",
    sessionId: workspace.sessionId,
    sessionState: runtimeSandboxId ? "RUNNING" : "PENDING",
    toolCatalogHash: workspace.toolCatalogHash,
    toolDefinitions: tools,
    userId: "user_1"
  });
  const attachmentBytes = Buffer.from("input bytes", "utf8");
  const storage = createMemoryStorageAdapter();
  void storage.putObject({
    body: attachmentBytes,
    contentType: "application/octet-stream",
    storageKey: "user_1/input"
  });
  const repository: WorkspaceCoordinatorRepository = {
    async attachments() {
      return [{
        attachmentId: "attachment_1",
        byteSize: attachmentBytes.byteLength,
        checksum: createHash("sha256").update(attachmentBytes).digest("hex"),
        fileName: "input.bin",
        kind: "file",
        messageId: "message_1",
        mimeType: "application/octet-stream",
        storageKey: "user_1/input"
      }];
    },
    async binding() { return binding(); },
    async generatedFiles() { return files; },
    async claimExport() {
      return exportComplete
        ? { status: "complete" as const }
        : { status: "claimed" as const, token: "lease_token_1" };
    },
    async markExportComplete() { exportComplete = true; return true; },
    async markExportFailed() { return true; },
    async renewExportLease() { return true; },
    async markSessionFailed() {},
    async markSessionLost(input) {
      if (runtimeSandboxId !== input.runtimeSandboxId) return false;
      runtimeSandboxId = null;
      return true;
    },
    async markSessionReady() {},
    async markSessionRunning(input) {
      runtimeSandboxId = input.runtimeSandboxId;
      return true;
    },
    async markSessionStarting() { return true; },
    async settleOutput({ output }) {
      const existing = files.find((file) => file.relativePath === output.relativePath);
      if (existing) return existing;
      const file = {
        attachmentId: `output_${files.length + 1}`,
        byteSize: output.byteSize,
        fileName: output.relativePath.split("/").at(-1)!,
        mimeType: output.mimeType,
        relativePath: output.relativePath
      };
      files.push(file);
      return file;
    }
  };
  const complete: WorkspaceToolResult = {
    content: [{ text: "ok", type: "text" }],
    status: "complete"
  };
  const runtime: WorkspaceRuntime = {
    callBoundTool: vi.fn(async () => complete),
    cancelToolCall: vi.fn(async () => undefined),
    collectOutputs: vi.fn(async () => []),
    createProjectArchive: vi.fn(async () => {
      throw new Error("unused");
    }),
    ensureSession: vi.fn(async () => ({
      runtimeSandboxId: "runtime_1",
      sandboxName: binding().sandboxName,
      state: "ready" as const
    })),
    health: vi.fn(async () => ({ state: "ready" as const })),
    loadBoundTools: vi.fn(async () => ({
      hash: workspace.toolCatalogHash,
      mcpVersion: workspace.mcpVersion,
      runtimeVersion: workspace.runtimeVersion,
      tools
    })),
    removeSession: vi.fn(async () => undefined),
    stageAttachments: vi.fn(async () => undefined),
    stopSession: vi.fn(async () => undefined)
  };
  return {
    coordinator: createWorkspaceCoordinator({ config, repository, runtime, storage }),
    repository,
    runId,
    runtime,
    shellToolName,
    setRuntimeSandboxId(value: string | null) { runtimeSandboxId = value; },
    storage,
    tools,
    workspace
  };
}

describe("Workspace coordinator", () => {
  it("stays lazy until a call and stages the deterministic inbox only once per run", async () => {
    const value = fixture();
    await expect(value.coordinator.tools({
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    })).resolves.toHaveLength(16);
    expect(value.runtime.ensureSession).not.toHaveBeenCalled();

    for (const id of ["provider_call_1", "provider_call_2"]) {
      await expect(value.coordinator.execute({
        call: { arguments: { command: "pwd" }, id, name: value.shellToolName },
        modelRunToolCallId: `stored_${id}`,
        runId: value.runId,
        userId: "user_1",
        workspace: value.workspace
      })).resolves.toMatchObject({ status: "complete" });
    }
    expect(value.runtime.ensureSession).toHaveBeenCalledTimes(1);
    expect(value.runtime.stageAttachments).toHaveBeenCalledTimes(1);
    expect(value.runtime.loadBoundTools).toHaveBeenCalledTimes(1);
    expect(value.runtime.callBoundTool).toHaveBeenCalledTimes(2);
    expect(value.runtime.stageAttachments).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [expect.objectContaining({
        sandboxPath: expect.stringContaining("attachment_1--input.bin")
      })],
      outputDirectory: value.workspace.outputDirectory
    }));
    expect(value.coordinator.accepts({
      name: value.shellToolName,
      workspace: value.workspace
    })).toBe(true);
    expect(value.coordinator.accepts({
      name: "mcp_workspace_sandbox_delete_unknown",
      workspace: value.workspace
    })).toBe(false);
  });

  it("compares persisted JSONB tool definitions canonically", async () => {
    const value = fixture();
    vi.mocked(value.runtime.loadBoundTools).mockResolvedValueOnce({
      hash: value.workspace.toolCatalogHash,
      mcpVersion: value.workspace.mcpVersion,
      runtimeVersion: value.workspace.runtimeVersion,
      tools: value.tools.map((tool) => ({
        description: tool.description,
        inputSchema: { type: "object", properties: {} },
        namespacedName: tool.namespacedName,
        originalName: tool.originalName
      }))
    });
    await expect(value.coordinator.execute({
      call: {
        arguments: { command: "pwd" },
        id: "provider_call_jsonb",
        name: value.shellToolName
      },
      modelRunToolCallId: "stored_call_jsonb",
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    })).resolves.toMatchObject({ status: "complete" });
  });

  it("exports bounded outputs to durable storage and reuses the settled projection", async () => {
    const value = fixture();
    value.setRuntimeSandboxId("runtime_1");
    const output = "generated output";
    vi.mocked(value.runtime.collectOutputs).mockResolvedValueOnce([{
      body: body(output),
      byteSize: Buffer.byteLength(output),
      checksum: createHash("sha256").update(output).digest("hex"),
      mimeType: "text/plain",
      opaqueFileId: "b".repeat(64),
      relativePath: "nested/result.txt"
    }]);
    const first = await value.coordinator.finalize({
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    });
    const second = await value.coordinator.finalize({
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    });
    expect(first).toEqual(second);
    expect(first).toEqual([expect.objectContaining({
      fileName: "result.txt",
      relativePath: "nested/result.txt"
    })]);
    expect(value.runtime.ensureSession).toHaveBeenCalledTimes(1);
    expect(value.runtime.stageAttachments).toHaveBeenCalledTimes(1);
    expect(value.runtime.collectOutputs).toHaveBeenCalledTimes(1);
    expect([...value.storage.objects.keys()]).toEqual([
      "user_1/input",
      expect.stringMatching(/^user_1\/workspace-outputs\/run_workspace_1\//u)
    ]);
  });

  it("recreates a lost sandbox once and surfaces the loss in the tool result", async () => {
    const value = fixture();
    value.setRuntimeSandboxId("runtime_lost");
    vi.mocked(value.runtime.ensureSession)
      .mockRejectedValueOnce(new WorkspaceRuntimeError("workspace_session_lost"))
      .mockResolvedValueOnce({
        runtimeSandboxId: "runtime_recreated",
        sandboxName: "aiqsa-ws-session_workspace_1",
        state: "ready"
      });
    const result = await value.coordinator.execute({
      call: {
        arguments: { command: "pwd" },
        id: "provider_call_lost",
        name: value.shellToolName
      },
      modelRunToolCallId: "stored_call_lost",
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    });
    expect(value.runtime.ensureSession).toHaveBeenCalledTimes(2);
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("clean workspace was recreated")
    });
  });

  it("reconnects for output recovery but never replaces a lost completed-run sandbox", async () => {
    const value = fixture();
    value.setRuntimeSandboxId("runtime_lost");
    vi.mocked(value.runtime.ensureSession).mockRejectedValueOnce(
      new WorkspaceRuntimeError("workspace_session_lost")
    );

    await expect(value.coordinator.finalize({
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    })).rejects.toThrow("workspace_session_lost");
    expect(value.runtime.ensureSession).toHaveBeenCalledTimes(1);
    expect(value.runtime.collectOutputs).not.toHaveBeenCalled();
  });

  it("rejects unsafe or oversized output projections before upload", async () => {
    const value = fixture();
    value.setRuntimeSandboxId("runtime_1");
    vi.mocked(value.runtime.collectOutputs).mockResolvedValueOnce([{
      body: body("x"),
      byteSize: config.outputFileMaxBytes + 1,
      checksum: "c".repeat(64),
      mimeType: "application/octet-stream",
      opaqueFileId: "d".repeat(64),
      relativePath: "../escape.bin"
    }]);
    await expect(value.coordinator.finalize({
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    })).rejects.toThrow("workspace_output_limit_exceeded");
    expect(value.storage.objects.size).toBe(1);
  });
});
