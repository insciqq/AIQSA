import { createHash } from "node:crypto";
import type { ThreadWorkspaceActivityEntry } from "@/lib/contracts/workspace";
import { describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_MCP_TOOL_ALLOWLIST,
  workspaceAttachmentPath,
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
import type { WorkspaceExecutionRecord, WorkspaceExecutionRegistry } from "./executionRegistry";
import type {
  WorkspaceBoundTool,
  WorkspaceRuntime,
  WorkspaceToolResult
} from "./runtime";
import { WorkspaceRuntimeError } from "./runtime";
import { namespacedWorkspaceToolName } from "./toolCatalog";
import { sameOutputIdentities, type WorkspaceOutputCapture } from "./outputManifest";

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

function memoryRegistry() {
  const rows: Array<WorkspaceExecutionRecord & { state: WorkspaceExecutionRecord["state"] }> = [];
  const registry: WorkspaceExecutionRegistry = {
    async closeAll({ modelRunId, sessionId, to }) {
      let count = 0;
      for (const row of rows) {
        if (row.sessionId !== sessionId || (modelRunId && row.modelRunId !== modelRunId)) continue;
        if (row.state !== "ACTIVE" && row.state !== "TERMINATING") continue;
        row.state = to;
        count += 1;
      }
      return count;
    },
    async find({ runtimeExecSessionId, sessionId }) {
      return rows.find((row) =>
        row.sessionId === sessionId && row.runtimeExecSessionId === runtimeExecSessionId) ?? null;
    },
    async listOpen({ modelRunId, sessionId }) {
      return rows.filter((row) =>
        row.sessionId === sessionId &&
        (!modelRunId || row.modelRunId === modelRunId) &&
        (row.state === "ACTIVE" || row.state === "TERMINATING"));
    },
    async register(input) {
      const existing = rows.find((row) => row.modelRunToolCallId === input.modelRunToolCallId ||
        (row.sessionId === input.sessionId && row.runtimeExecSessionId === input.runtimeExecSessionId));
      if (existing) {
        return existing.modelRunId === input.modelRunId &&
          existing.modelRunToolCallId === input.modelRunToolCallId &&
          existing.runtimeExecSessionId === input.runtimeExecSessionId
          ? "registered"
          : "conflict";
      }
      rows.push({ id: `execution_${rows.length + 1}`, state: "ACTIVE", ...input });
      return "registered";
    },
    async transition({ from, id, to }) {
      const row = rows.find((entry) => entry.id === id);
      if (!row || !from.includes(row.state)) return false;
      row.state = to;
      return true;
    }
  };
  return { registry, rows };
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
  let exportPending = false;
  let outputCapture: WorkspaceOutputCapture | null = null;
  let sessionState: string = "PENDING";
  let sessionErrorCode: string | null = null;
  let operationOwner: string | null = `run:${runId}`;
  let operationGeneration = 1;
  const unregisteredCommands = { count: 0 };
  const settledSessions: string[] = [];
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
    operationOwner, operationGeneration,
    policyRevision: 1,
    projectId: null,
    runId,
    runtimeSandboxId,
    runtimeVersion: workspace.runtimeVersion,
    sandboxName: "aiqsa-ws-session_workspace_1",
    sessionId: workspace.sessionId,
    sessionErrorCode,
    sessionState,
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
    async unregisteredCommands() { return unregisteredCommands.count; },
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
      if (exportComplete) return { status: "complete" as const };
      operationOwner = `export:${runId}:lease_token_1`;
      return { operation: { generation: ++operationGeneration, owner: operationOwner }, status: "claimed" as const, token: "lease_token_1" };
    },
    async claimExportForRecovery() {
      if (exportComplete) return { status: "complete" as const };
      const token = `lease_token_recovery_${operationGeneration + 1}`;
      operationOwner = `export:${runId}:${token}`;
      return { operation: { generation: ++operationGeneration, owner: operationOwner }, status: "claimed" as const, token };
    },
    async exportRecoveryCandidates() { return []; },
    async reserveOutputCapture() {
      if (outputCapture) return { ...outputCapture, create: false };
      outputCapture = { id: "a".repeat(32), outputs: null };
      return { ...outputCapture, create: true };
    },
    async sealOutputCapture({ capture }) {
      if (!outputCapture || outputCapture.id !== capture.id) return false;
      if (outputCapture.outputs !== null) return sameOutputIdentities(outputCapture.outputs, capture.outputs);
      outputCapture = capture;
      return true;
    },
    async outputHandoffReady() { return (exportComplete || exportPending) && outputCapture?.outputs != null && operationOwner === null; },
    async markExportPending() { exportPending = outputCapture?.outputs != null; return exportPending; },
    async markExportComplete() { exportComplete = true; return true; },
    async markExportFailed() { return true; },
    async renewExportLease() { return true; },
    async prepareOutput() { return true; },
    async markSessionFailed() { sessionState = "FAILED"; },
    async markSessionLost(input) {
      if (runtimeSandboxId !== input.runtimeSandboxId) return null;
      runtimeSandboxId = null;
      sessionErrorCode = "workspace_session_lost";
      operationGeneration += 1;
      return { generation: operationGeneration, owner: input.operation.owner };
    },
    async markSessionReady() {},
    async markSessionRunning(input) {
      sessionErrorCode = null;
      runtimeSandboxId = input.runtimeSandboxId;
      sessionState = "RUNNING";
      return true;
    },
    async markSessionStarting() { sessionState = "CREATING"; return true; },
    async settleSession({ outcome }) {
      operationOwner = null;
      settledSessions.push(outcome);
      sessionState = outcome === "stopped" ? "STOPPED" : outcome === "ready" ? "READY" : "PENDING";
      return true;
    },
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
    claimSessionOperation: vi.fn(async () => undefined),
    retireSessionOperation: vi.fn(async (input) => runtime.stopSession(input)),
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
    listStagedAttachments: vi.fn(async () => []),
    loadBoundTools: vi.fn(async () => ({
      hash: workspace.toolCatalogHash,
      mcpVersion: workspace.mcpVersion,
      runtimeVersion: workspace.runtimeVersion,
      tools
    })),
    removeSession: vi.fn(async () => undefined),
    stageAttachments: vi.fn(async () => undefined),
    stopSession: vi.fn(async () => undefined),
    terminateExecutions: vi.fn(async (input: Parameters<WorkspaceRuntime["terminateExecutions"]>[0]) =>
      input.executions.map((execution) => ({
        outcome: "closed" as const,
        runtimeExecSessionId: execution.runtimeExecSessionId
      })))
  };
  const { registry, rows } = memoryRegistry();
  return {
    unregisteredCommands,
    config,
    coordinator: createWorkspaceCoordinator({ config, registry, repository, runtime, storage }),
    registry,
    registryRows: rows,
    repository,
    runId,
    runtime,
    sessionState: () => sessionState,
    settledSessions,
    shellToolName,
    setRuntimeSandboxId(value: string | null) { runtimeSandboxId = value; },
    storage,
    tools,
    workspace
  };
}

describe("Workspace coordinator", () => {
  it("does not adopt a later operation generation during an old finalizer's settlement", async () => {
    const value = fixture();
    await value.coordinator.execute({
      call: { arguments: { path: "/workspace/project/fixture", content: "fixture" }, id: "first_call", name: namespacedWorkspaceToolName("sandbox_fs_write") },
      modelRunToolCallId: "stored_first_call", runId: value.runId, userId: "user_1", workspace: value.workspace
    });
    const binding = (await value.repository.binding({ runId: value.runId, userId: "user_1" }))!;
    vi.spyOn(value.repository, "binding").mockResolvedValue({ ...binding, operationGeneration: 2 });
    await expect(value.coordinator.settle({
      outcome: "completed", runId: value.runId, userId: "user_1", workspace: value.workspace
    })).resolves.toMatchObject({ quiesced: false, sessionSettled: false });
    expect(value.runtime.retireSessionOperation).not.toHaveBeenCalled();
    expect(value.runtime.stopSession).not.toHaveBeenCalled();
  });

  it("cannot settle or stop a session now owned by another run", async () => {
    const value = fixture();
    value.setRuntimeSandboxId("runtime_1");
    const binding = await value.repository.binding({ runId: value.runId, userId: "user_1" });
    vi.spyOn(value.repository, "binding").mockResolvedValue({
      ...binding!,
      ...{ operationOwner: "run:later_run", operationGeneration: 7 }
    });
    value.unregisteredCommands.count = 1;
    await expect(value.coordinator.settle({
      outcome: "cancelled", runId: value.runId, userId: "user_1", workspace: value.workspace
    })).resolves.toMatchObject({ quiesced: false, sessionSettled: false });
    expect(value.runtime.stopSession).not.toHaveBeenCalled();
    expect(value.runtime.terminateExecutions).not.toHaveBeenCalled();
    expect(value.settledSessions).toEqual([]);
  });

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
    expect(first).toEqual({
      files: [expect.objectContaining({
        fileName: "result.txt",
        relativePath: "nested/result.txt"
      })],
      status: "complete"
    });
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

  it.each(["workspace_session_lost", null])("reports recreation on the next turn after previously recorded loss %s", async (sessionErrorCode) => {
    const value = fixture();
    const read = value.repository.binding.bind(value.repository);
    vi.spyOn(value.repository, "binding").mockImplementation(async (input) => {
      const binding = await read(input);
      return binding ? { ...binding, sessionErrorCode } : null;
    });
    const onActivity = vi.fn(async () => undefined);
    for (const id of ["first", "second"]) {
      const result = await value.coordinator.execute({
        call: { arguments: { command: "pwd" }, id, name: value.shellToolName },
        modelRunToolCallId: id, onActivity, runId: value.runId, userId: "user_1", workspace: value.workspace
      });
      expect(result.status).toBe("complete");
      const content = result.content[0];
      expect(content?.type === "text" && content.text.includes("clean workspace was recreated")).toBe(sessionErrorCode !== null && id === "first");
    }
    expect(onActivity.mock.calls.flat().filter((entry: { kind?: string }) => entry.kind === "workspace_recreated"))
      .toHaveLength(sessionErrorCode ? 1 : 0);
    expect(value.runtime.stageAttachments).toHaveBeenCalledTimes(1);
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
    })).resolves.toEqual({ code: "workspace_session_lost", retryable: false, status: "failed" });
    expect(value.runtime.ensureSession).toHaveBeenCalledTimes(1);
    expect(value.runtime.collectOutputs).not.toHaveBeenCalled();
  });

  it("retries a proven pre-dispatch loss once, restaging originals before a single mutation", async () => {
    const value = fixture();
    const onActivity = vi.fn(async () => undefined);
    let mutations = 0;
    vi.mocked(value.runtime.callBoundTool)
      .mockRejectedValueOnce(new WorkspaceRuntimeError("workspace_session_lost_before_dispatch"))
      .mockImplementationOnce(async () => {
        mutations += 1;
        return { content: [{ type: "text", text: "written" }], status: "complete" };
      });
    const result = await value.coordinator.execute({
      call: { arguments: { command: "printf marker" }, id: "provider_call", name: value.shellToolName },
      modelRunToolCallId: "stored_call", onActivity,
      runId: value.runId, userId: "user_1", workspace: value.workspace
    });
    expect(mutations).toBe(1);
    expect(value.runtime.callBoundTool).toHaveBeenCalledTimes(2);
    expect(value.runtime.stageAttachments).toHaveBeenCalledTimes(2);
    expect(onActivity.mock.calls.flat().filter((entry: { kind?: string }) => entry.kind === "workspace_recreated"))
      .toHaveLength(1);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("clean workspace was recreated") });
  });

  it.each(["workspace_session_lost", "workspace_tool_timeout", "workspace_runtime_unavailable"] as const)(
    "never repeats an ambiguous mutation reported as %s", async (code) => {
      const value = fixture();
      let mutations = 0;
      vi.mocked(value.runtime.callBoundTool).mockImplementation(async () => {
        mutations += 1;
        throw new WorkspaceRuntimeError(code);
      });
      await expect(value.coordinator.execute({
        call: { arguments: { command: "printf marker" }, id: "provider_call", name: value.shellToolName },
        modelRunToolCallId: "stored_call",
        runId: value.runId, userId: "user_1", workspace: value.workspace
      })).rejects.toMatchObject({ code });
      expect(mutations).toBe(1);
      expect(value.runtime.ensureSession).toHaveBeenCalledTimes(1);
      expect(value.runtime.stageAttachments).toHaveBeenCalledTimes(1);
    }
  );

  it("does not loop when a replacement also disappears before dispatch", async () => {
    const value = fixture();
    vi.mocked(value.runtime.callBoundTool).mockRejectedValue(
      new WorkspaceRuntimeError("workspace_session_lost_before_dispatch")
    );
    await expect(value.coordinator.execute({
      call: { arguments: { command: "printf marker" }, id: "provider_call", name: value.shellToolName },
      modelRunToolCallId: "stored_call",
      runId: value.runId, userId: "user_1", workspace: value.workspace
    })).rejects.toMatchObject({ code: "workspace_session_lost_before_dispatch" });
    expect(value.runtime.callBoundTool).toHaveBeenCalledTimes(2);
    expect(value.runtime.ensureSession).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])("requires runner cleanup proof for a bootstrap without a returned id (available=%s)", async (available) => {
    const value = fixture();
    vi.mocked(value.runtime.ensureSession).mockRejectedValueOnce(new WorkspaceRuntimeError("workspace_execution_cleanup_failed"));
    if (!available) vi.mocked(value.runtime.stopSession).mockRejectedValue(new WorkspaceRuntimeError("workspace_runtime_unavailable"));
    await expect(value.coordinator.execute({
      call: { arguments: { command: "printf marker" }, id: "provider_call", name: value.shellToolName },
      modelRunToolCallId: "stored_call",
      runId: value.runId, userId: "user_1", workspace: value.workspace
    })).rejects.toMatchObject({ code: "workspace_execution_cleanup_failed" });
    await expect(value.coordinator.settle({
      outcome: "failed", runId: value.runId, userId: "user_1", workspace: value.workspace
    })).resolves.toEqual({ quiesced: available, sessionSettled: available, stoppedVm: false });
    expect(value.runtime.retireSessionOperation).toHaveBeenCalledExactlyOnceWith({
      operation: { generation: 1, owner: `run:${value.runId}` }, runtimeSandboxId: null, sessionId: value.workspace.sessionId
    });
    expect(value.settledSessions).toEqual(available ? ["pending"] : []);
    expect(value.runtime.callBoundTool).not.toHaveBeenCalled();
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
    })).resolves.toEqual({ code: "workspace_output_limit_exceeded", retryable: false, status: "failed" });
    expect(value.storage.objects.size).toBe(1);
  });
});

describe("Workspace coordinator settlement", () => {
  function execStartResult(execSessionId: string): WorkspaceToolResult {
    return {
      content: [{ text: JSON.stringify({ data: { execSessionId }, ok: true }), type: "text" }],
      execSessionId,
      status: "complete"
    };
  }

  it("registers long-running executions, enforces ownership through the registry, and closes them", async () => {
    const value = fixture();
    const startName = namespacedWorkspaceToolName("sandbox_exec_start");
    const pollName = namespacedWorkspaceToolName("sandbox_exec_poll");
    const closeName = namespacedWorkspaceToolName("sandbox_exec_close");
    vi.mocked(value.runtime.callBoundTool).mockResolvedValueOnce(execStartResult("exec_1"));
    await expect(value.coordinator.execute({
      call: { arguments: { command: "sleep 30" }, id: "call_start", name: startName },
      modelRunToolCallId: "stored_start",
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    })).resolves.toMatchObject({ status: "complete" });
    expect(value.registryRows).toEqual([expect.objectContaining({
      modelRunId: value.runId,
      modelRunToolCallId: "stored_start",
      runtimeExecSessionId: "exec_1",
      state: "ACTIVE"
    })]);

    await expect(value.coordinator.execute({
      call: { arguments: { execSessionId: "exec_foreign" }, id: "call_poll_foreign", name: pollName },
      modelRunToolCallId: "stored_poll_foreign",
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    })).resolves.toMatchObject({ status: "error" });
    expect(value.runtime.callBoundTool).toHaveBeenCalledTimes(1);

    await expect(value.coordinator.execute({
      call: { arguments: { execSessionId: "exec_1" }, id: "call_poll", name: pollName },
      modelRunToolCallId: "stored_poll",
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    })).resolves.toMatchObject({ status: "complete" });
    await expect(value.coordinator.execute({
      call: { arguments: { execSessionId: "exec_1" }, id: "call_close", name: closeName },
      modelRunToolCallId: "stored_close",
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    })).resolves.toMatchObject({ status: "complete" });
    expect(value.registryRows[0]).toMatchObject({ state: "ACTIVE" });

    const settled = await value.coordinator.settle({
      outcome: "completed",
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    });
    expect(settled).toEqual({ quiesced: true, sessionSettled: true, stoppedVm: true });
    expect(value.runtime.terminateExecutions).toHaveBeenCalledTimes(1);
    expect(value.settledSessions).toEqual(["stopped"]);
  });

  it("stops a registration that cannot be made durable before the model sees success", async () => {
    const value = fixture();
    const startName = namespacedWorkspaceToolName("sandbox_exec_start");
    vi.mocked(value.runtime.callBoundTool).mockResolvedValueOnce({
      content: [{ text: "started", type: "text" }],
      status: "complete"
    });
    vi.mocked(value.runtime.terminateExecutions).mockResolvedValueOnce([
      { outcome: "unknown", runtimeExecSessionId: "exec_2" }
    ]);
    await expect(value.coordinator.execute({
      call: { arguments: { command: "sleep 30" }, id: "call_start", name: startName },
      modelRunToolCallId: "stored_start",
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    })).resolves.toMatchObject({ status: "error" });
    expect(value.registryRows).toEqual([]);
    expect(value.runtime.stopSession).toHaveBeenCalledTimes(1);
    expect(value.settledSessions).toEqual([]);
    expect(value.sessionState()).toBe("RUNNING");
  });

  it("settles a cancelled run by terminating registered executions once", async () => {
    const value = fixture();
    vi.mocked(value.runtime.callBoundTool).mockResolvedValueOnce(execStartResult("exec_3"));
    await value.coordinator.execute({
      call: { arguments: { command: "sleep 30" }, id: "call_start", name: namespacedWorkspaceToolName("sandbox_exec_start") },
      modelRunToolCallId: "stored_start",
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    });
    const first = await value.coordinator.settle({
      outcome: "cancelled",
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    });
    expect(first).toEqual({ quiesced: true, sessionSettled: true, stoppedVm: true });
    expect(value.runtime.terminateExecutions).toHaveBeenCalledWith(expect.objectContaining({
      executions: [{ modelRunId: value.runId, runtimeExecSessionId: "exec_3" }],
      runtimeSandboxId: "runtime_1"
    }));
    expect(value.registryRows[0]).toMatchObject({ state: "CLOSED" });
    expect(value.runtime.retireSessionOperation).toHaveBeenCalledTimes(1);

    const second = await value.coordinator.settle({
      outcome: "cancelled",
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    });
    expect(second.sessionSettled).toBe(false);
    expect(value.runtime.terminateExecutions).toHaveBeenCalledTimes(1);
    expect(value.runtime.retireSessionOperation).toHaveBeenCalledTimes(1);
    expect(value.sessionState()).toBe("STOPPED");
  });

  it("falls back to a disk-preserving VM stop when quiescence cannot be proven", async () => {
    const value = fixture();
    vi.mocked(value.runtime.callBoundTool).mockResolvedValueOnce(execStartResult("exec_4"));
    await value.coordinator.execute({
      call: { arguments: { command: "sleep 30" }, id: "call_start", name: namespacedWorkspaceToolName("sandbox_exec_start") },
      modelRunToolCallId: "stored_start",
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    });
    vi.mocked(value.runtime.terminateExecutions).mockResolvedValueOnce([
      { outcome: "unknown", runtimeExecSessionId: "exec_4" }
    ]);
    const settled = await value.coordinator.settle({
      outcome: "timed_out",
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    });
    expect(settled).toEqual({ quiesced: true, sessionSettled: true, stoppedVm: true });
    expect(value.runtime.retireSessionOperation).toHaveBeenCalledTimes(1);
    expect(value.registryRows[0]).toMatchObject({ state: "LOST" });
    expect(value.sessionState()).toBe("STOPPED");

    // A crash-ambiguous exec_start without a registry row also forces the stop.
    const ambiguous = fixture();
    ambiguous.setRuntimeSandboxId("runtime_1");
    ambiguous.unregisteredCommands.count = 1;
    await expect(ambiguous.coordinator.settle({
      outcome: "failed",
      runId: ambiguous.runId,
      userId: "user_1"
    })).resolves.toEqual({ quiesced: true, sessionSettled: true, stoppedVm: true });
    expect(ambiguous.runtime.retireSessionOperation).toHaveBeenCalledTimes(1);
  });

  it("keeps the session RUNNING when even the fallback stop fails", async () => {
    const value = fixture();
    value.setRuntimeSandboxId("runtime_1");
    value.unregisteredCommands.count = 1;
    vi.mocked(value.runtime.stopSession).mockRejectedValue(new WorkspaceRuntimeError("workspace_runtime_unavailable"));
    await expect(value.coordinator.settle({
      outcome: "failed",
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    })).resolves.toEqual({ quiesced: false, sessionSettled: false, stoppedVm: false });
    expect(value.settledSessions).toEqual([]);
  });

  it("settles a run whose sandbox never existed as pending", async () => {
    const value = fixture();
    await expect(value.coordinator.settle({
      outcome: "cancelled",
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    })).resolves.toEqual({ quiesced: true, sessionSettled: true, stoppedVm: false });
    expect(value.settledSessions).toEqual(["pending"]);
    expect(value.runtime.terminateExecutions).not.toHaveBeenCalled();
  });

  it("treats an abort during sandbox creation as cancellation, not a runtime failure", async () => {
    const value = fixture();
    const markSessionFailed = vi.spyOn(value.repository, "markSessionFailed");
    const controller = new AbortController();
    vi.mocked(value.runtime.ensureSession).mockImplementationOnce(async (input) => {
      controller.abort();
      if (input.signal?.aborted) throw new WorkspaceRuntimeError("workspace_runtime_unavailable");
      throw new Error("unexpected");
    });
    await expect(value.coordinator.execute({
      call: { arguments: { command: "pwd" }, id: "call_abort", name: value.shellToolName },
      modelRunToolCallId: "stored_abort",
      runId: value.runId,
      signal: controller.signal,
      userId: "user_1",
      workspace: value.workspace
    })).rejects.toThrow("workspace_tool_cancelled");
    expect(markSessionFailed).not.toHaveBeenCalled();
    expect(value.sessionState()).toBe("CREATING");
    await expect(value.coordinator.settle({
      outcome: "cancelled",
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    })).resolves.toMatchObject({ quiesced: true, sessionSettled: true });
    expect(value.settledSessions).toEqual(["pending"]);
  });

  it("freezes output through an exact disk-preserving stop before resuming for export", async () => {
    const value = fixture();
    value.setRuntimeSandboxId("runtime_1");
    await value.registry.register({
      modelRunId: value.runId,
      modelRunToolCallId: "stored_start_prior",
      runtimeExecSessionId: "exec_prior",
      sessionId: value.workspace.sessionId
    });
    vi.mocked(value.runtime.terminateExecutions).mockResolvedValueOnce([
      { outcome: "unknown", runtimeExecSessionId: "exec_prior" }
    ]);
    await expect(value.coordinator.finalize({
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    })).resolves.toEqual({ files: [], status: "complete" });
    expect(value.runtime.collectOutputs).toHaveBeenCalledTimes(1);
    expect(value.runtime.stopSession).toHaveBeenCalled();
    expect(value.runtime.retireSessionOperation).toHaveBeenCalledTimes(1);
    expect(value.sessionState()).toBe("STOPPED");
    expect(value.runtime.ensureSession).toHaveBeenCalledTimes(2);
    expect(value.runtime.ensureSession).toHaveBeenLastCalledWith(expect.objectContaining({ runtimeSandboxId: "runtime_1" }));
  });
});

describe("Workspace coordinator incremental staging", () => {
  it("reads and writes only originals the guest index does not already hold", async () => {
    const value = fixture();
    const secondBytes = Buffer.from("second input", "utf8");
    await value.storage.putObject({
      body: secondBytes,
      contentType: "application/octet-stream",
      storageKey: "user_1/second"
    });
    const first = (await value.repository.attachments(value.workspace as never))[0]!;
    const second = {
      attachmentId: "attachment_2",
      byteSize: secondBytes.byteLength,
      checksum: createHash("sha256").update(secondBytes).digest("hex"),
      fileName: "second.bin",
      kind: "file" as const,
      messageId: "message_2",
      mimeType: "application/octet-stream",
      storageKey: "user_1/second"
    };
    vi.spyOn(value.repository, "attachments").mockResolvedValue([first, second]);
    const reads = vi.spyOn(value.storage, "getObjectStream");
    vi.mocked(value.runtime.listStagedAttachments).mockResolvedValueOnce([{
      attachmentId: first.attachmentId,
      byteSize: first.byteSize,
      checksum: first.checksum,
      sandboxPath: workspaceAttachmentPath({
        attachmentId: first.attachmentId,
        messageId: first.messageId,
        originalName: first.fileName
      })
    }]);

    await expect(value.coordinator.execute({
      call: { arguments: { command: "pwd" }, id: "call_incremental", name: value.shellToolName },
      modelRunToolCallId: "stored_incremental",
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    })).resolves.toMatchObject({ status: "complete" });

    expect(reads).toHaveBeenCalledTimes(1);
    expect(reads).toHaveBeenCalledWith("user_1/second", expect.anything());
    expect(value.runtime.stageAttachments).toHaveBeenCalledTimes(1);
    const staged = vi.mocked(value.runtime.stageAttachments).mock.calls[0]![0];
    expect(staged.attachments.map((attachment) => attachment.attachmentId)).toEqual(["attachment_2"]);
    expect(staged.inboxIndex).toMatchObject({
      attachments: [
        expect.objectContaining({ attachmentId: "attachment_1" }),
        expect.objectContaining({ attachmentId: "attachment_2" })
      ],
      version: 1
    });
    expect(staged.manifests.map((manifest) => manifest.messageId).sort()).toEqual(["message_1", "message_2"]);
    expect(staged.outputDirectory).toBe(value.workspace.outputDirectory);
  });

  it("restages everything when the staged listing fails or a checksum changed", async () => {
    const value = fixture();
    const reads = vi.spyOn(value.storage, "getObjectStream");
    vi.mocked(value.runtime.listStagedAttachments).mockResolvedValueOnce([{
      attachmentId: "attachment_1",
      byteSize: 11,
      checksum: "e".repeat(64),
      sandboxPath: "/workspace/inbox/messages/message_1/attachment_1--input.bin"
    }]);
    await value.coordinator.execute({
      call: { arguments: { command: "pwd" }, id: "call_changed", name: value.shellToolName },
      modelRunToolCallId: "stored_changed",
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    });
    expect(reads).toHaveBeenCalledTimes(1);

    const failing = fixture();
    const failingReads = vi.spyOn(failing.storage, "getObjectStream");
    vi.mocked(failing.runtime.listStagedAttachments).mockRejectedValueOnce(
      new WorkspaceRuntimeError("workspace_runtime_unavailable")
    );
    await expect(failing.coordinator.execute({
      call: { arguments: { command: "pwd" }, id: "call_failed_list", name: failing.shellToolName },
      modelRunToolCallId: "stored_failed_list",
      runId: failing.runId,
      userId: "user_1",
      workspace: failing.workspace
    })).resolves.toMatchObject({ status: "complete" });
    expect(failingReads).toHaveBeenCalledTimes(1);
  });
});

describe("Workspace coordinator export settlement", () => {
  it("retires the generation advanced by confirmed disk loss during handoff", async () => {
    const value = fixture();
    value.setRuntimeSandboxId("runtime_lost");
    vi.mocked(value.runtime.ensureSession).mockRejectedValueOnce(new WorkspaceRuntimeError("workspace_session_lost"));
    await expect(value.coordinator.handoff({ runId: value.runId, userId: "user_1", workspace: value.workspace }))
      .rejects.toMatchObject({ code: "workspace_session_lost" });
    const binding = await value.repository.binding({ runId: value.runId, userId: "user_1" });
    expect(binding).toMatchObject({ operationGeneration: 3, operationOwner: null, runtimeSandboxId: null, sessionState: "PENDING" });
    expect(value.runtime.retireSessionOperation).toHaveBeenCalledExactlyOnceWith({
      operation: { generation: 3, owner: `export:${value.runId}:lease_token_1` }, runtimeSandboxId: null, sessionId: value.workspace.sessionId
    });
    expect(value.runtime.collectOutputs).not.toHaveBeenCalled();
    expect(await value.repository.generatedFiles({ runId: value.runId, userId: "user_1" })).toHaveLength(0);
  });

  it("releases a genuinely empty capture at handoff without queuing a transfer", async () => {
    const value = fixture(); value.setRuntimeSandboxId("runtime_1");
    const release = vi.fn(async () => undefined);
    const transfer = vi.spyOn(value.storage, "putObjectStream");
    const coordinator = createWorkspaceCoordinator({ ...value, runtime: { ...value.runtime, releaseOutputCapture: release } });
    await expect(coordinator.handoff({ runId: value.runId, userId: "user_1", workspace: value.workspace })).resolves.toEqual({ status: "ready" });
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ captureId: "a".repeat(32), modelRunId: value.runId }));
    expect(transfer).not.toHaveBeenCalled();
    expect(await value.repository.claimExportForRecovery({ generation: 1, leaseMs: 60_000, runId: value.runId, runtimeSandboxId: "runtime_1", sessionId: value.workspace.sessionId })).toEqual({ status: "complete" });
  });

  it("hands off captured outputs without reading transport bodies and acknowledges them after an app restart", async () => {
    const value = fixture(); value.setRuntimeSandboxId("runtime_1");
    const pull = vi.fn(); const cancel = vi.fn();
    vi.mocked(value.runtime.collectOutputs).mockResolvedValueOnce([{ ...outputStream("report", "report.txt"),
      body: new ReadableStream({ pull, cancel }, { highWaterMark: 0 }) }]);
    const transfer = vi.spyOn(value.storage, "putObjectStream");
    const request = { runId: value.runId, userId: "user_1", workspace: value.workspace };
    await expect(value.coordinator.handoff(request)).resolves.toEqual({ status: "ready" });
    expect(pull).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce();
    expect(transfer).not.toHaveBeenCalled();
    expect(value.runtime.retireSessionOperation).toHaveBeenCalledOnce();
    expect(value.sessionState()).toBe("STOPPED");
    const fresh = createWorkspaceCoordinator(value);
    await expect(fresh.tools(request)).resolves.toHaveLength(value.tools.length);
    await expect(fresh.handoff(request)).resolves.toEqual({ status: "ready" });
    expect(value.runtime.collectOutputs).toHaveBeenCalledOnce();
    expect(value.runtime.callBoundTool).not.toHaveBeenCalled();
    vi.mocked(value.runtime.collectOutputs).mockResolvedValueOnce([outputStream("report", "report.txt")]);
    const exported = await fresh.finalize({ ...request, recovery: true });
    expect(exported).toMatchObject({ status: "complete", files: [{ relativePath: "report.txt" }] });
    expect(value.runtime.collectOutputs).toHaveBeenLastCalledWith(expect.objectContaining({ capture: { id: "a".repeat(32), create: false } }));
    expect(transfer).toHaveBeenCalledOnce();
  });

  it.each(["quiescence", "capture", "handoff", "retirement", "settlement"] as const)("cannot acknowledge a Workspace handoff with failed %s", async (failure) => {
    const value = fixture(); value.setRuntimeSandboxId("runtime_1");
    vi.mocked(value.runtime.collectOutputs).mockResolvedValueOnce([outputStream("report", "report.txt")]);
    if (failure === "quiescence") {
      value.unregisteredCommands.count = 1;
      vi.mocked(value.runtime.stopSession).mockRejectedValue(new Error("synthetic_stop_failure"));
    }
    if (failure === "capture") vi.spyOn(value.repository, "sealOutputCapture").mockResolvedValue(false);
    if (failure === "handoff") vi.spyOn(value.repository, "markExportPending").mockResolvedValue(false);
    if (failure === "retirement") vi.mocked(value.runtime.retireSessionOperation!).mockRejectedValue(new Error("synthetic_retire_failure"));
    if (failure === "settlement") vi.spyOn(value.repository, "settleSession").mockResolvedValue(false);
    const transfer = vi.spyOn(value.storage, "putObjectStream");
    await expect(value.coordinator.handoff({ runId: value.runId, userId: "user_1", workspace: value.workspace })).rejects.toBeInstanceOf(WorkspaceRuntimeError);
    expect(transfer).not.toHaveBeenCalled();
    expect(await value.repository.generatedFiles({ runId: value.runId, userId: "user_1" })).toEqual([]);
  });

  it.each(["missing", "replaced", "renamed", "extra"] as const)("retains the original output obligation when a later attempt is %s", async (change) => {
    const value = fixture();
    value.setRuntimeSandboxId("runtime_1");
    vi.mocked(value.runtime.collectOutputs).mockResolvedValueOnce([outputStream("report", "report.txt")]);
    vi.spyOn(value.storage, "putObjectStream").mockRejectedValueOnce(new Error("synthetic_storage_outage"));
    await expect(value.coordinator.finalize({ runId: value.runId, userId: "user_1", workspace: value.workspace })).resolves.toMatchObject({ status: "failed", retryable: true });
    vi.mocked(value.runtime.collectOutputs).mockResolvedValueOnce(change === "missing" ? [] : change === "replaced"
      ? [outputStream("newone", "report.txt")] : change === "renamed" ? [outputStream("report", "renamed.txt")]
        : [outputStream("report", "report.txt"), outputStream("extra", "extra.txt")]);
    const recovered = await createWorkspaceCoordinator(value).finalize({ recovery: true, runId: value.runId, userId: "user_1" });
    if (recovered.status === "complete") {
      expect(recovered.files.map((file) => file.relativePath)).toEqual(["report.txt"]);
      const published = [...value.storage.objects.values()].filter((object) => object.storageKey.includes("workspace-outputs"));
      expect(published).toHaveLength(1);
      expect(createHash("sha256").update(published[0]!.body).digest("hex")).toBe(createHash("sha256").update("report").digest("hex"));
    } else expect(recovered).toMatchObject({ status: "failed", retryable: true });
    expect(value.runtime.callBoundTool).not.toHaveBeenCalled();
  });

  it("cannot complete an empty retry after only part of the owed set was published", async () => {
    const value = fixture();
    value.setRuntimeSandboxId("runtime_1");
    vi.mocked(value.runtime.collectOutputs).mockResolvedValueOnce([outputStream("one", "one.txt"), outputStream("two", "two.txt")]);
    const put = value.storage.putObjectStream!.bind(value.storage);
    vi.spyOn(value.storage, "putObjectStream").mockImplementationOnce(put).mockRejectedValueOnce(new Error("synthetic_storage_outage"));
    await expect(value.coordinator.finalize({ runId: value.runId, userId: "user_1", workspace: value.workspace })).resolves.toMatchObject({ status: "failed" });
    expect(await value.repository.generatedFiles({ runId: value.runId, userId: "user_1" })).toHaveLength(1);
    vi.mocked(value.runtime.collectOutputs).mockResolvedValueOnce([]);
    await expect(createWorkspaceCoordinator(value).finalize({ recovery: true, runId: value.runId, userId: "user_1" })).resolves.toMatchObject({ status: "failed", retryable: true });
    expect(await value.repository.generatedFiles({ runId: value.runId, userId: "user_1" })).toHaveLength(1);
    expect([...value.storage.objects.values()].some((object) => object.body.equals(Buffer.from("one")))).toBe(true);
  });

  it("verifies the committed object after a successful transport and recovers without duplicate publication", async () => {
    const value = fixture();
    value.setRuntimeSandboxId("runtime_1");
    vi.mocked(value.runtime.collectOutputs).mockImplementation(async () => [outputStream("report", "report.txt")]);
    const put = value.storage.putObjectStream!.bind(value.storage);
    let corrupt = true;
    vi.spyOn(value.storage, "putObjectStream").mockImplementation(async (input) => {
      await put(input);
      if (corrupt) value.storage.objects.set(input.storageKey, { body: Buffer.from("wrong!"), contentType: input.contentType, storageKey: input.storageKey });
    });
    const publish = vi.spyOn(value.repository, "settleOutput");
    await expect(value.coordinator.finalize({ runId: value.runId, userId: "user_1", workspace: value.workspace })).resolves.toMatchObject({ status: "failed", retryable: true });
    expect(publish).not.toHaveBeenCalled();
    expect(await value.repository.generatedFiles({ runId: value.runId, userId: "user_1" })).toEqual([]);
    corrupt = false;
    await expect(value.coordinator.finalize({ recovery: true, runId: value.runId, userId: "user_1" })).resolves.toMatchObject({ status: "complete" });
    expect(publish).toHaveBeenCalledOnce();
    expect(value.storage.objects.get(publish.mock.calls[0]![0].storageKey)?.body).toEqual(Buffer.from("report"));
    await value.coordinator.finalize({ recovery: true, runId: value.runId, userId: "user_1" });
    expect(publish).toHaveBeenCalledOnce();
  });

  it.each(["before open", "during transfer"] as const)("refuses same-size output corruption %s before relational publication", async (when) => {
    const value = fixture();
    value.setRuntimeSandboxId("runtime_1");
    const output = outputStream("report", "report.txt");
    output.body = when === "before open" ? body("wrong!") : new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("rep"));
        controller.enqueue(Buffer.from("bad"));
        controller.close();
      }
    });
    vi.mocked(value.runtime.collectOutputs).mockResolvedValueOnce([output]);
    const publish = vi.spyOn(value.repository, "settleOutput");
    const complete = vi.spyOn(value.repository, "markExportComplete");
    await expect(value.coordinator.finalize({ runId: value.runId, userId: "user_1", workspace: value.workspace }))
      .resolves.toMatchObject({ status: "failed", retryable: true });
    expect(publish).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(await value.repository.generatedFiles({ runId: value.runId, userId: "user_1" })).toEqual([]);
  });

  it("keeps a late former upload from overwriting a newer published object", async () => {
    const value = fixture();
    value.setRuntimeSandboxId("runtime_1");
    vi.mocked(value.runtime.collectOutputs).mockImplementation(async () => [outputStream("report", "report.txt")]);
    vi.spyOn(value.repository, "renewExportLease").mockImplementation(async ({ operation }) => {
      const current = (await value.repository.binding({ runId: value.runId, userId: "user_1" }))!;
      return current.operationOwner === operation.owner && current.operationGeneration === operation.generation;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const put = value.storage.putObjectStream!.bind(value.storage);
    let first = true;
    vi.spyOn(value.storage, "putObjectStream").mockImplementation(async (input) => {
      if (!first) return put(input);
      first = false;
      entered();
      await held; // An already accepted object write outlives its worker lease.
      value.storage.objects.set(input.storageKey, { body: Buffer.from("stale!"), contentType: input.contentType, storageKey: input.storageKey });
    });
    const publication = vi.spyOn(value.repository, "settleOutput");
    const previous = value.coordinator.finalize({ recovery: true, runId: value.runId, userId: "user_1" });
    try {
      await started;
      const successor = createWorkspaceCoordinator(value);
      await expect(successor.finalize({ recovery: true, runId: value.runId, userId: "user_1" })).resolves.toMatchObject({ status: "complete" });
      expect(publication).toHaveBeenCalledOnce();
      const key = publication.mock.calls[0]![0].storageKey;
      expect(value.storage.objects.get(key)?.body.toString()).toBe("report");
      release();
      await expect(previous).resolves.toMatchObject({ status: "failed" });
      expect(publication).toHaveBeenCalledOnce();
      expect(value.storage.objects.get(key)?.body.toString()).toBe("report");
    } finally { release(); await previous; }
  });

  it("coalesces direct concurrent recovery calls into one bounded scan", async () => {
    const value = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const select = vi.spyOn(value.repository, "exportRecoveryCandidates").mockImplementation(async () => { await held; return []; });
    const first = value.coordinator.recoverExports({ limit: 10 });
    const second = value.coordinator.recoverExports({ limit: 10 });
    expect(select).toHaveBeenCalledOnce();
    release();
    expect(await Promise.all([first, second])).toEqual([{ attempted: 0, completed: 0 }, { attempted: 0, completed: 0 }]);
  });

  it("continues past inaccessible, busy, and throwing candidates across bounded pages", async () => {
    const value = fixture();
    value.setRuntimeSandboxId("runtime_1");
    const initial = (await value.repository.binding({ runId: value.runId, userId: "user_1" }))!;
    const updatedAt = new Date("2026-09-04T10:00:00.000Z");
    const candidates = [...Array.from({ length: 10 }, (_, index) => `a_${String(index).padStart(2, "0")}`), "b_busy", "c_error", value.runId]
      .map((runId) => ({ runId, updatedAt, userId: "user_1" }));
    const select = vi.spyOn(value.repository, "exportRecoveryCandidates").mockImplementation(async ({ cursor, limit }) =>
      candidates.filter((candidate) => !cursor || candidate.runId > cursor.runId).slice(0, limit));
    vi.spyOn(value.repository, "binding").mockImplementation(async ({ runId }) => {
      if (runId.startsWith("a_")) return null;
      if (runId === "c_error") throw new Error("binding temporarily unavailable");
      return { ...initial, runId };
    });
    const claim = vi.spyOn(value.repository, "claimExportForRecovery").mockImplementation(async ({ runId }) =>
      runId === "b_busy" ? { status: "busy" } : { operation: { generation: initial.operationGeneration, owner: initial.operationOwner! }, status: "claimed", token: "healthy-lease" });
    await expect(value.coordinator.recoverExports({ limit: 10 })).resolves.toMatchObject({ attempted: 10, completed: 0 });
    expect(claim).not.toHaveBeenCalled();
    expect(value.runtime.collectOutputs).not.toHaveBeenCalled();
    await expect(value.coordinator.recoverExports({ limit: 10 })).resolves.toMatchObject({ attempted: 3, completed: 1 });
    expect(claim).toHaveBeenCalledTimes(2);
    expect(value.runtime.collectOutputs).toHaveBeenCalledOnce();
    expect(select.mock.calls[1]?.[0]).toMatchObject({ cursor: { runId: "a_09", updatedAt }, staleBefore: select.mock.calls[0]?.[0].staleBefore });
    await value.coordinator.recoverExports({ limit: 10 });
    expect(select.mock.calls[2]?.[0].cursor).toBeUndefined();
  });

  it("defers inaccessible recovery without acquiring a lease or consuming an attempt", async () => {
    const value = fixture();
    vi.spyOn(value.repository, "binding").mockResolvedValue(null);
    const claim = vi.spyOn(value.repository, "claimExportForRecovery");
    await expect(value.coordinator.finalize({ recovery: true, runId: value.runId, userId: "user_1" }))
      .resolves.toEqual({ reason: "access_unavailable", status: "deferred" });
    expect(claim).not.toHaveBeenCalled();
    expect(value.runtime.ensureSession).not.toHaveBeenCalled();
  });

  it("cannot settle a held transfer after its owner is cancelled", async () => {
    const value = fixture();
    value.setRuntimeSandboxId("runtime_1");
    vi.mocked(value.runtime.collectOutputs).mockResolvedValueOnce([outputStream("one", "one.txt")]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(value.storage, "putObjectStream").mockImplementation(async () => { entered(); await held; });
    const complete = vi.spyOn(value.repository, "markExportComplete");
    const settle = vi.spyOn(value.repository, "settleOutput");
    const signal = new AbortController();
    const pending = value.coordinator.finalize({ recovery: true, runId: value.runId, signal: signal.signal, userId: "user_1" });
    await started;
    signal.abort();
    release();
    await expect(pending).resolves.toMatchObject({ status: "failed" });
    expect(complete).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  function outputStream(content: string, relativePath: string, batchId = "f".repeat(32)) {
    return {
      batchId,
      body: body(content),
      byteSize: Buffer.byteLength(content),
      checksum: createHash("sha256").update(content).digest("hex"),
      mimeType: "text/plain",
      opaqueFileId: createHash("sha256").update(relativePath).digest("hex"),
      relativePath
    };
  }

  it("reports a busy lease without throwing and releases the runner batch after export", async () => {
    const value = fixture();
    value.setRuntimeSandboxId("runtime_1");
    vi.spyOn(value.repository, "claimExport").mockResolvedValueOnce({ status: "busy" });
    await expect(value.coordinator.finalize({
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    })).resolves.toEqual({ status: "busy" });
    expect(value.runtime.collectOutputs).not.toHaveBeenCalled();

    const release = vi.fn(async () => undefined);
    (value.runtime as { releaseOutputs?: typeof release }).releaseOutputs = release;
    vi.mocked(value.runtime.collectOutputs).mockResolvedValueOnce([outputStream("one", "one.txt")]);
    await expect(value.coordinator.finalize({
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    })).resolves.toMatchObject({ status: "complete" });
    expect(release).toHaveBeenCalledWith(expect.objectContaining({
      batchId: "f".repeat(32),
      runtimeSandboxId: "runtime_1"
    }));
  });

  it("keeps settled files, records a retryable failure, and finishes the rest on retry", async () => {
    const value = fixture();
    value.setRuntimeSandboxId("runtime_1");
    const failed = vi.spyOn(value.repository, "markExportFailed");
    const faulty = {
      ...outputStream("two", "two.txt"),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("tw"));
          controller.error(new WorkspaceRuntimeError("workspace_output_export_failed"));
        }
      })
    };
    vi.mocked(value.runtime.collectOutputs)
      .mockResolvedValueOnce([outputStream("one", "one.txt"), faulty])
      .mockResolvedValueOnce([outputStream("one", "one.txt"), outputStream("two", "two.txt")]);

    const first = await value.coordinator.finalize({
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    });
    expect(first).toEqual({ code: "workspace_output_export_failed", retryable: true, status: "failed" });
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({
      code: "workspace_output_export_failed",
      token: "lease_token_1"
    }));
    expect(await value.repository.generatedFiles({ runId: value.runId, userId: "user_1" }))
      .toEqual([expect.objectContaining({ relativePath: "one.txt" })]);

    const second = await value.coordinator.finalize({
      recovery: true,
      runId: value.runId,
      userId: "user_1"
    });
    expect(second).toMatchObject({ status: "complete" });
    expect(second.status === "complete" ? second.files : []).toHaveLength(2);
    expect(await value.repository.generatedFiles({ runId: value.runId, userId: "user_1" })).toHaveLength(2);
    // This fixture does not run retention: retry uploads have private keys,
    // and the redundant copy remains pending cleanup after two files publish.
    expect([...value.storage.objects.keys()].filter((key) => key.includes("workspace-outputs"))).toHaveLength(3);
  });

  it("stops every database transition once its lease is lost", async () => {
    const value = fixture();
    value.setRuntimeSandboxId("runtime_1");
    vi.spyOn(value.repository, "renewExportLease").mockResolvedValue(false);
    const failed = vi.spyOn(value.repository, "markExportFailed");
    const completed = vi.spyOn(value.repository, "markExportComplete");
    vi.mocked(value.runtime.collectOutputs).mockResolvedValueOnce([outputStream("one", "one.txt")]);
    await expect(value.coordinator.finalize({
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    })).resolves.toEqual({ code: "workspace_output_export_failed", retryable: true, status: "failed" });
    expect(failed).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
    expect(value.storage.objects.size).toBe(1);
  });

  it("retries owed exports of idle chats through the recovery claim", async () => {
    const value = fixture();
    value.setRuntimeSandboxId("runtime_1");
    vi.spyOn(value.repository, "exportRecoveryCandidates").mockResolvedValueOnce([
      { runId: value.runId, updatedAt: new Date("2026-09-04T10:00:00.000Z"), userId: "user_1" }
    ]);
    const recoveryClaim = vi.spyOn(value.repository, "claimExportForRecovery");
    const liveClaim = vi.spyOn(value.repository, "claimExport");
    vi.mocked(value.runtime.collectOutputs).mockResolvedValueOnce([outputStream("one", "one.txt")]);
    await expect(value.coordinator.recoverExports({ limit: 5 })).resolves.toEqual({
      attempted: 1,
      completed: 1
    });
    expect(recoveryClaim).toHaveBeenCalledTimes(1);
    expect(liveClaim).not.toHaveBeenCalled();
  });
});

describe("Workspace coordinator activity projection", () => {
  it("correlates live start and poll through the durable start-call owner", async () => {
    const value = fixture();
    const entries: ThreadWorkspaceActivityEntry[] = [];
    vi.mocked(value.runtime.callBoundTool)
      .mockResolvedValueOnce({ content: [{ text: JSON.stringify({ data: { execSessionId: "exec_activity" }, ok: true }), type: "text" }], execSessionId: "exec_activity", status: "complete" })
      .mockResolvedValueOnce({ content: [{ text: JSON.stringify({ data: { done: true, events: [], exitStatus: { code: 0 } }, ok: true }), type: "text" }], status: "complete" });
    const start = await value.coordinator.execute({
      call: { arguments: { command: "pytest", cwd: "/workspace/project" }, id: "provider-start", name: namespacedWorkspaceToolName("sandbox_exec_start") },
      modelRunToolCallId: "durable-start",
      onActivity: async (entry) => { if (entry.kind === "command") entries.push(entry); },
      runId: value.runId, userId: "user_1", workspace: value.workspace
    });
    const cold = createWorkspaceCoordinator(value);
    const poll = await cold.execute({
      call: { arguments: { execSessionId: "exec_activity" }, id: "provider-poll", name: namespacedWorkspaceToolName("sandbox_exec_poll") },
      modelRunToolCallId: "durable-poll",
      runId: value.runId, userId: "user_1", workspace: value.workspace
    });
    for (const result of [start, poll]) for (const event of result.artifacts ?? []) {
      if (event.type === "artifact" && event.data.artifactType === "workspace_activity") {
        entries.push(event.data.payload as ThreadWorkspaceActivityEntry);
      }
    }
    expect(entries).toHaveLength(3);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(1);
    expect(entries[2]).toMatchObject({ command: { exitCode: 0 }, phase: "succeeded" });
    expect(JSON.stringify(entries)).not.toMatch(/provider-start|durable-start|exec_activity/);
  });

  it("rejects shell syntax in direct exec with an actionable error before touching the runtime", async () => {
    const value = fixture();
    const execName = namespacedWorkspaceToolName("sandbox_exec");
    const result = await value.coordinator.execute({
      call: {
        arguments: { command: "pwd && ls -la && cat > script.py <<'PY'\nprint(1)\nPY" },
        id: "call_exec_shell",
        name: execName
      },
      modelRunToolCallId: "stored_exec_shell",
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    });
    expect(result.status).toBe("error");
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("workspace_shell_syntax_requires_shell")
    });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Use sandbox_shell") });
    expect(value.runtime.ensureSession).not.toHaveBeenCalled();
    expect(value.runtime.callBoundTool).not.toHaveBeenCalled();
    expect(result.artifacts).toEqual([expect.objectContaining({
      data: expect.objectContaining({
        artifactType: "workspace_activity",
        payload: expect.objectContaining({
          command: expect.objectContaining({ preview: "pwd && ls -la && cat > script.py <<'PY'" }),
          errorCode: "workspace_shell_syntax_requires_shell",
          kind: "command",
          phase: "failed"
        })
      })
    })]);

    vi.mocked(value.runtime.callBoundTool).mockResolvedValueOnce({
      content: [{ text: JSON.stringify({ data: { exitCode: 0, stderr: "", stdout: "/workspace/project\n", success: true }, ok: true }), type: "text" }],
      exitCode: 0,
      status: "complete"
    });
    await expect(value.coordinator.execute({
      call: { arguments: { args: ["-la"], command: "ls" }, id: "call_exec_ok", name: execName },
      modelRunToolCallId: "stored_exec_ok",
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    })).resolves.toMatchObject({ status: "complete" });
    expect(value.runtime.callBoundTool).toHaveBeenCalledTimes(1);
  });

  it("emits lifecycle entries in timeline order and attaches the settled step to the result", async () => {
    const value = fixture();
    const entries: string[] = [];
    vi.mocked(value.runtime.callBoundTool).mockResolvedValueOnce({
      content: [{ text: JSON.stringify({ data: { exitCode: 0, stderr: "", stdout: "ok\n", success: true }, ok: true }), type: "text" }],
      exitCode: 0,
      status: "complete"
    });
    const result = await value.coordinator.execute({
      call: { arguments: { command: "npm test" }, id: "call_timeline", name: value.shellToolName },
      modelRunToolCallId: "stored_timeline",
      onActivity: async (entry) => { entries.push(`${entry.kind}:${entry.phase}`); },
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    });
    expect(entries).toEqual([
      "workspace_start:running",
      "workspace_start:succeeded",
      "attachments_prepare:running",
      "attachments_prepare:succeeded",
      "command:running"
    ]);
    expect(result.artifacts).toEqual([expect.objectContaining({
      data: expect.objectContaining({
        artifactType: "workspace_activity",
        payload: expect.objectContaining({
          command: expect.objectContaining({ exitCode: 0, preview: "npm test", stdoutPreview: "ok\n" }),
          kind: "command",
          phase: "succeeded"
        })
      })
    })]);
    const raw = JSON.stringify(result.artifacts);
    expect(raw).not.toContain("sandbox_");
    expect(raw).not.toContain("runtime_1");

    const exported: string[] = [];
    vi.mocked(value.runtime.collectOutputs).mockResolvedValueOnce([{
      body: body("report"),
      byteSize: 6,
      checksum: createHash("sha256").update("report").digest("hex"),
      mimeType: "text/markdown",
      opaqueFileId: "a".repeat(64),
      relativePath: "report.md"
    }]);
    await value.coordinator.finalize({
      onActivity: async (entry) => { exported.push(`${entry.kind}:${entry.phase}:${entry.count ?? ""}`); },
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    });
    expect(exported).toEqual(["outputs_export:running:1", "outputs_export:succeeded:1"]);

    const stopped: string[] = [];
    const fresh = fixture();
    vi.mocked(fresh.runtime.callBoundTool).mockResolvedValueOnce({
      content: [{ text: "ok", type: "text" }],
      status: "complete"
    });
    await fresh.coordinator.execute({
      call: { arguments: { command: "pwd" }, id: "call_before_stop", name: fresh.shellToolName },
      modelRunToolCallId: "stored_before_stop",
      runId: fresh.runId,
      userId: "user_1",
      workspace: fresh.workspace
    });
    await fresh.coordinator.settle({
      onActivity: async (entry) => { stopped.push(`${entry.kind}:${entry.phase}`); },
      outcome: "cancelled",
      runId: fresh.runId,
      userId: "user_1",
      workspace: fresh.workspace
    });
    expect(stopped).toEqual(["workspace_stopped:cancelled"]);
  });
});


describe("Workspace synchronous cleanup ownership", () => {
  it.each(["sandbox_shell", "sandbox_exec"] as const)("persists %s cleanup before dispatch and retains it after cancellation", async (name) => {
    const value = fixture();
    let ownedBeforeDispatch = false;
    vi.mocked(value.runtime.callBoundTool).mockImplementationOnce(async () => {
      ownedBeforeDispatch = value.registryRows.some((row) => row.modelRunToolCallId === "stored_sync" && row.state === "ACTIVE");
      throw new WorkspaceRuntimeError("workspace_tool_cancelled");
    });
    await expect(value.coordinator.execute({
      call: { arguments: { command: "sleep", args: ["30"] }, id: "sync_call", name: namespacedWorkspaceToolName(name) },
      modelRunToolCallId: "stored_sync", runId: value.runId, userId: "user_1", workspace: value.workspace
    })).rejects.toMatchObject({ code: "workspace_tool_cancelled" });
    expect(ownedBeforeDispatch).toBe(true);
    expect(value.registryRows).toHaveLength(1);
    await expect(value.coordinator.settle({
      outcome: "cancelled", runId: value.runId, userId: "user_1", workspace: value.workspace
    })).resolves.toMatchObject({ quiesced: true, stoppedVm: true });
    expect(value.registryRows[0]).toMatchObject({ state: "LOST" });
    expect(value.runtime.retireSessionOperation).toHaveBeenCalledTimes(1);
    expect(value.runtime.callBoundTool).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch a synchronous mutation if its cleanup obligation cannot be persisted", async () => {
    const value = fixture();
    vi.spyOn(value.registry, "register").mockRejectedValueOnce(new Error("synthetic unavailable registry"));
    await expect(value.coordinator.execute({
      call: { arguments: { command: "touch /workspace/project/marker" }, id: "sync_call", name: value.shellToolName },
      modelRunToolCallId: "stored_sync", runId: value.runId, userId: "user_1", workspace: value.workspace
    })).rejects.toMatchObject({ code: "workspace_execution_cleanup_failed" });
    expect(value.runtime.callBoundTool).not.toHaveBeenCalled();
  });
});


it("keeps an unregistered execution fenced when its fallback stop is unavailable", async () => {
  const value = fixture();
  vi.mocked(value.runtime.callBoundTool).mockResolvedValueOnce({ status: "complete", content: [] });
  vi.mocked(value.runtime.stopSession).mockRejectedValue(new WorkspaceRuntimeError("workspace_runtime_unavailable"));
  await expect(value.coordinator.execute({
    call: { arguments: { command: "sleep 30" }, id: "start", name: namespacedWorkspaceToolName("sandbox_exec_start") },
    modelRunToolCallId: "stored_start", runId: value.runId, userId: "user_1", workspace: value.workspace
  })).rejects.toMatchObject({ code: "workspace_execution_cleanup_failed" });
  expect(value.settledSessions).toEqual([]);
});


it("does not announce Workspace stopped while process cleanup is unproven", async () => {
  const value = fixture();
  await value.coordinator.execute({
    call: { arguments: { command: "pwd" }, id: "before_stop", name: value.shellToolName },
    modelRunToolCallId: "stored_before_stop", runId: value.runId, userId: "user_1", workspace: value.workspace
  });
  vi.mocked(value.runtime.stopSession).mockRejectedValue(new WorkspaceRuntimeError("workspace_runtime_unavailable"));
  const activity: ThreadWorkspaceActivityEntry[] = [];
  await expect(value.coordinator.settle({
    onActivity: async (entry) => { activity.push(entry); },
    outcome: "cancelled", runId: value.runId, userId: "user_1", workspace: value.workspace
  })).resolves.toMatchObject({ quiesced: false, sessionSettled: false });
  expect(activity.some((entry) => entry.kind === "workspace_stopped")).toBe(false);
});
