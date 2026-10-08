import { createHash, randomUUID } from "node:crypto";
import type { ThreadWorkspaceActivityEntry } from "@/lib/contracts/workspace";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithContext } from "../observability";
import {
  WORKSPACE_MCP_TOOL_ALLOWLIST,
  workspaceAttachmentPath,
  workspaceRunOutputDirectory
} from "@/lib/domain/workspace";
import type { NormalizedRunWorkspace } from "@/lib/server/providers/types";
import { createMemoryStorageAdapter, createPooledStorageAdapter } from "@/tests/support/storage";
import { WORKSPACE_ATTACHMENT_STORAGE_WAIT_MS } from "./attachmentAcquisition";
import { getWorkspaceConfig } from "./config";
import type { PrismaClient } from "@prisma/client";
import {
  createPrismaWorkspaceCoordinatorRepository,
  createWorkspaceCoordinator,
  type WorkspaceCoordinatorRepository,
  type WorkspaceExecutionBinding
} from "./coordinator";
import { workspaceSyncCleanupId, type WorkspaceExecutionRecord, type WorkspaceExecutionRegistry } from "./executionRegistry";
import type {
  WorkspaceBoundTool,
  WorkspaceRuntime,
  WorkspaceToolResult
} from "./runtime";
import { WorkspaceRuntimeError } from "./runtime";
import { namespacedWorkspaceToolName } from "./toolCatalog";
import { sameOutputIdentities, type WorkspaceOutputCapture } from "./outputManifest";
import { snapshotToolExecutionResult } from "../runs/toolExecutionPersistence";
import { toolLoopPersistenceLimits } from "../runs/toolLoopPersistence";
import { anthropicMessagesToolBridge, openAIResponsesToolBridge } from "../tools/bridges";

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

function outputStream(content: string, relativePath: string, batchId = "f".repeat(32)) {
  return {
    batchId, body: body(content), byteSize: Buffer.byteLength(content),
    checksum: createHash("sha256").update(content).digest("hex"), mimeType: "text/plain",
    opaqueFileId: createHash("sha256").update(relativePath).digest("hex"), relativePath
  };
}

/** Content-free export lifecycle records written while `action` runs. */
async function exportRecords(action: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  writer.mockClear();
  try {
    await action();
    return writer.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((record) => record.event === "runtime_lifecycle" && record.stage === "export");
  } finally { writer.mockRestore(); }
}

function memoryRegistry() {
  const rows: Array<WorkspaceExecutionRecord & { state: WorkspaceExecutionRecord["state"]; stopConfirmed?: boolean }> = [];
  const registry: WorkspaceExecutionRegistry = {
    async closeAll({ modelRunId, sessionId, to, errorCode }) {
      let count = 0;
      for (const row of rows) {
        if (row.sessionId !== sessionId || (modelRunId && row.modelRunId !== modelRunId)) continue;
        if (row.state !== "ACTIVE" && row.state !== "TERMINATING") continue;
        row.state = to;
        row.stopConfirmed = errorCode === "workspace_execution_stopped";
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
  let guestUsed = false;
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
    guestUsed: guestUsed || unregisteredCommands.count > 0,
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
    saveBrowserSessions: vi.fn(async () => ({ saved: 0, unchanged: 0, skipped: {} })),
    personalSecrets: vi.fn(async () => []),
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
    async markGuestUsed() { guestUsed = true; return true; },
    async retireUnusedRun() {
      if (binding().guestUsed) return false;
      operationOwner = null;
      return true;
    },
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
    collectBrowserSessions: vi.fn(async () => ({ files: [], skipped: [] })),
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
    prepareSkillRun: vi.fn(async () => ({ state: "preparing" as const })),
    installSkillBundle: vi.fn(async ({ bundle }) => ({ workspacePath: `/workspace/.aiqsa/skills/${bundle.alias}` })),
    completeSkillRunPreparation: vi.fn(async () => undefined),
    loadBoundTools: vi.fn(async () => ({
      hash: workspace.toolCatalogHash,
      mcpVersion: workspace.mcpVersion,
      runtimeVersion: workspace.runtimeVersion,
      tools
    })),
    removeSession: vi.fn(async () => undefined),
    // Like every runtime, consume each original in order before the next.
    stageAttachments: vi.fn(async (input: Parameters<WorkspaceRuntime["stageAttachments"]>[0]) => {
      for (const attachment of input.attachments) await new Response(attachment.body).arrayBuffer();
    }),
    syncPersonalSecrets: vi.fn(async () => undefined),
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
    setRuntimeSandboxId(value: string | null) { runtimeSandboxId = value; guestUsed = true; },
    setUntouchedSession(state: string) { runtimeSandboxId = "runtime_1"; sessionState = state; guestUsed = false; },
    storage,
    tools,
    workspace
  };
}

describe("Workspace coordinator", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it.each(["STOPPED", "READY"])("hands off an untouched run on an existing %s guest without runtime activity", async state => {
    const f = fixture();
    f.setUntouchedSession(state);
    const onActivity = vi.fn();
    const start = vi.spyOn(f.repository, "markSessionStarting");
    const ready = vi.spyOn(f.repository, "markSessionReady");
    await expect(f.coordinator.handoff({ runId: f.runId, userId: "user_1", workspace: f.workspace, onActivity }))
      .resolves.toEqual({ status: "ready" });
    expect(f.sessionState()).toBe(state);
    expect(start).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    expect(onActivity).not.toHaveBeenCalled();
    for (const method of Object.values(f.runtime)) if (vi.isMockFunction(method)) expect(method).not.toHaveBeenCalled();
    expect(await f.repository.outputHandoffReady({ runId: f.runId, sessionId: f.workspace.sessionId })).toBe(true);
    const restarted = createWorkspaceCoordinator({ ...f, repository: f.repository, runtime: f.runtime });
    await expect(restarted.handoff({ runId: f.runId, userId: "user_1", workspace: f.workspace, onActivity }))
      .resolves.toEqual({ status: "ready" });
    expect(onActivity).not.toHaveBeenCalled();
  });

  it("exports after a crash-ambiguous guest command even without an initialization receipt", async () => {
    const f = fixture();
    f.setUntouchedSession("STOPPED");
    f.unregisteredCommands.count = 1;
    vi.mocked(f.runtime.collectOutputs).mockResolvedValueOnce([outputStream("kept bytes", "answer.txt")]);
    const restarted = createWorkspaceCoordinator({ ...f, repository: f.repository, runtime: f.runtime });
    await expect(restarted.finalize({ runId: f.runId, userId: "user_1" })).resolves.toMatchObject({
      status: "complete", files: [{ fileName: "answer.txt" }]
    });
    expect(f.runtime.ensureSession).toHaveBeenCalled();
    expect(f.runtime.collectOutputs).toHaveBeenCalledOnce();
  });

  it("fails closed before guest I/O when the durable use marker cannot be written", async () => {
    const f = fixture();
    vi.spyOn(f.repository, "markGuestUsed").mockResolvedValue(false);
    await expect(f.coordinator.execute({
      call: { arguments: { command: "pwd" }, id: "call", name: f.shellToolName },
      modelRunToolCallId: "stored", runId: f.runId, userId: "user_1", workspace: f.workspace
    })).rejects.toMatchObject({ code: "workspace_operation_stale" });
    expect(f.runtime.ensureSession).not.toHaveBeenCalled();
    expect(f.runtime.callBoundTool).not.toHaveBeenCalled();
  });

  it("includes guest use persisted between the initial binding read and export ownership", async () => {
    const f = fixture();
    f.setUntouchedSession("STOPPED");
    const claim = f.repository.claimExport;
    vi.spyOn(f.repository, "claimExport").mockImplementationOnce(async request => {
      await f.repository.markGuestUsed((await f.repository.binding({ runId: f.runId, userId: "user_1" }))!);
      return claim(request);
    });
    await expect(f.coordinator.finalize({ runId: f.runId, userId: "user_1" })).resolves.toMatchObject({ status: "complete" });
    expect(f.runtime.ensureSession).toHaveBeenCalledOnce();
    expect(f.runtime.collectOutputs).toHaveBeenCalledOnce();
  });

  it("starts a fresh native thread from the full prompt when no compatible thread was armed", async () => {
    const f = fixture();
    const startAgent = vi.fn(async () => undefined);
    const bytes = Buffer.from([{ type: "thread.started", thread_id: randomUUID() }, { type: "turn.started" }, { type: "turn.completed" }]
      .map(event => JSON.stringify(event)).join("\n") + "\n");
    const pollAgent = vi.fn(async () => ({ cursor: 0, nextCursor: bytes.length, stdoutBase64: bytes.toString("base64"), done: true, exitCode: 0 }));
    Object.assign(f.runtime, { startAgent, pollAgent });
    await f.coordinator.executeAgent!({ runId: f.runId, userId: "user_1", workspace: f.workspace, modelRunToolCallId: randomUUID(),
      prompt: "Full accepted prompt", resumePrompt: "Resume-only prompt", runToken: "a".repeat(43), signal: new AbortController().signal,
      timeoutSeconds: 30, onEvent: vi.fn(), threadId: undefined,
      profile: { gatewayOrigin: "http://agent.invalid", modelId: "synthetic", contextWindowTokens: 128000,
        maxOutputTokens: 4096, developerInstructions: "Synthetic", mcpMode: "off" as const, mcpTimeoutSeconds: 90 } });
    expect(startAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: "Full accepted prompt", threadId: undefined }));
    expect(startAgent).not.toHaveBeenCalledWith(expect.objectContaining({ prompt: "Resume-only prompt" }));
  });

  it("interrupts only after a native command settles and resumes without reinitializing Skills or files", async () => {
    const f = fixture(), threadId = randomUUID(), first = randomUUID(), second = randomUUID();
    const startAgent = vi.fn(async () => undefined), interruptAgent = vi.fn(async () => true);
    let cursor = 0;
    const page = (events: unknown[], done = false, exitCode: number | null = null) => {
      const bytes = Buffer.from(events.map(event => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""));
      const result = { cursor, nextCursor: cursor + bytes.length, stdoutBase64: bytes.toString("base64"), done, exitCode };
      cursor += bytes.length;
      return result;
    };
    const pollAgent = vi.fn().mockResolvedValueOnce(page([
      { type: "thread.started", thread_id: threadId }, { type: "turn.started" },
      { type: "item.started", item: { id: "cmd", type: "command_execution", status: "in_progress" } }
    ])).mockResolvedValueOnce(page([
      { type: "item.completed", item: { id: "cmd", type: "command_execution", status: "completed", exit_code: 0 } }
    ])).mockResolvedValueOnce(page([], true, 1));
    Object.assign(f.runtime, { startAgent, pollAgent, interruptAgent });
    const shouldInterrupt = vi.fn(async () => true);
    const request = { runId: f.runId, userId: "user_1", workspace: f.workspace, modelRunToolCallId: first,
      prompt: "Original", resumePrompt: "Continuation", runToken: "a".repeat(43), signal: new AbortController().signal,
      timeoutSeconds: 30, onEvent: vi.fn(), shouldInterrupt,
      profile: { gatewayOrigin: "http://agent.invalid", modelId: "synthetic", contextWindowTokens: 128000,
        maxOutputTokens: 4096, developerInstructions: "Synthetic", mcpMode: "off" as const, mcpTimeoutSeconds: 90 } };
    expect(await f.coordinator.executeAgent!(request)).toBe("interrupted");
    expect(shouldInterrupt).toHaveBeenCalledOnce(); expect(interruptAgent).toHaveBeenCalledOnce();
    cursor = 0;
    pollAgent.mockResolvedValueOnce(page([{ type: "thread.started", thread_id: threadId }, { type: "turn.started" }, { type: "turn.completed" }], true, 0));
    await f.coordinator.executeAgent!({ ...request, previousToolCallId: first, modelRunToolCallId: second, threadId, resumePrompt: "Use CSV" });
    expect(startAgent).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: "Use CSV", threadId,
      previousExecSessionId: `agent-${first}`, runtimeSandboxId: "runtime_1" }));
    expect(f.runtime.ensureSession).toHaveBeenCalledOnce(); expect(f.runtime.prepareSkillRun).toHaveBeenCalledOnce();
    expect(f.runtime.stageAttachments).toHaveBeenCalledOnce(); expect(f.registryRows).toHaveLength(2);
    // Loss is never recovered into a new VM for an in-task continuation.
    f.setRuntimeSandboxId(null);
    await expect(f.coordinator.executeAgent!({ ...request, previousToolCallId: second, modelRunToolCallId: randomUUID(), threadId }))
      .rejects.toMatchObject({ code: "workspace_session_lost" });
    expect(startAgent).toHaveBeenCalledTimes(2); expect(f.runtime.ensureSession).toHaveBeenCalledOnce();
  });

  it("prepares frozen bundles before tools, preserves a ready guest on recovery and reinstalls only an explicit load", async () => {
    const value = fixture();
    const ref = { alias: "review", revisionId: "revision", bundleDigest: "b".repeat(64), discover: false };
    const plan = { agent: false, manifestHash: "a".repeat(64), initial: [ref] };
    const skills = { plan: vi.fn(async () => plan), archive: vi.fn(async () => ({ bundle: ref, byteSize: 1,
      checksum: "c".repeat(64), archive: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } }) })) };
    const coordinator = createWorkspaceCoordinator({ ...value, skills });
    const request = { runId: value.runId, userId: "user_1", workspace: value.workspace, alias: "review", install: false };
    expect(await coordinator.skillBundlePath!(request)).toBe("/workspace/.aiqsa/skills/review");
    expect(value.runtime.installSkillBundle).toHaveBeenCalledOnce();
    expect(vi.mocked(value.runtime.completeSkillRunPreparation).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(value.runtime.loadBoundTools).mock.invocationCallOrder[0]!);
    vi.mocked(value.runtime.prepareSkillRun).mockResolvedValue({ state: "ready" });
    const restarted = createWorkspaceCoordinator({ ...value, skills });
    expect(await restarted.skillBundlePath!(request)).toBe("/workspace/.aiqsa/skills/review");
    expect(value.runtime.installSkillBundle).toHaveBeenCalledOnce();
    expect(value.runtime.completeSkillRunPreparation).toHaveBeenCalledOnce();
    await restarted.skillBundlePath!({ ...request, install: true });
    expect(value.runtime.installSkillBundle).toHaveBeenCalledTimes(2);
    expect(skills.archive).toHaveBeenLastCalledWith(expect.objectContaining({ alias: "review", currentAccess: true }));
    expect((await value.repository.binding({ runId: value.runId, userId: "user_1" }))!.guestUsed).toBe(true);
    await expect(restarted.finalize(request)).resolves.toMatchObject({ status: "complete" });
    expect(value.runtime.collectOutputs).toHaveBeenCalledOnce();
  });

  it("does not publish preparation or execute tools after a failed bundle transfer", async () => {
    const value = fixture();
    const ref = { alias: "review", revisionId: "revision", bundleDigest: "b".repeat(64), discover: false };
    const skills = { plan: vi.fn(async () => ({ agent: false, manifestHash: "a".repeat(64), initial: [ref] })),
      archive: vi.fn(async () => { throw new WorkspaceRuntimeError("workspace_skill_bundle_invalid"); }) };
    const coordinator = createWorkspaceCoordinator({ ...value, skills });
    await expect(coordinator.execute({ call: { arguments: { command: "true" }, id: "call", name: value.shellToolName },
      modelRunToolCallId: "call", runId: value.runId, userId: "user_1", workspace: value.workspace }))
      .rejects.toMatchObject({ code: "workspace_skill_bundle_invalid" });
    expect(value.runtime.completeSkillRunPreparation).not.toHaveBeenCalled();
    expect(value.runtime.callBoundTool).not.toHaveBeenCalled();
  });

  it.each([false, true])("settles a continuation restore before exposing tools (restore failure=%s)", async (failed) => {
    const value = fixture();
    Object.assign(value.repository, { claimContinuationSeed: vi.fn(async () => ({ id: "seed", token: "token", storageKey: "user_1/input",
      byteSize: 11, checksum: createHash("sha256").update("input bytes").digest("hex") })),
      settleContinuationSeed: vi.fn(async () => true) });
    value.runtime.restoreProjectArchive = vi.fn(async () => undefined);
    if (failed) vi.mocked(value.runtime.restoreProjectArchive).mockRejectedValueOnce(new WorkspaceRuntimeError("workspace_archive_invalid"));
    const running = vi.spyOn(value.repository, "markSessionRunning");
    await value.coordinator.execute({ call: { arguments: { command: "true" }, id: "call", name: value.shellToolName },
      modelRunToolCallId: "call", runId: value.runId, userId: "user_1", workspace: value.workspace });
    // A failed restore leaves the project untouched; no second, emptying restore runs.
    expect(value.runtime.restoreProjectArchive).toHaveBeenCalledOnce();
    expect(value.repository.settleContinuationSeed).toHaveBeenCalledWith(failed
      ? expect.objectContaining({ status: "FAILED", failureCode: "workspace_archive_invalid" })
      : expect.objectContaining({ status: "RESTORED" }));
    expect(vi.mocked(value.repository.settleContinuationSeed!).mock.invocationCallOrder[0]).toBeLessThan(running.mock.invocationCallOrder[0]!);
    expect(value.runtime.callBoundTool).toHaveBeenCalledOnce();
  });

  it("holds whichever run first restores a scheduled rotation's seed to it, the owner's own run included", async () => {
    const seed = { byteSize: 11, checksum: "a".repeat(64), id: "seed", leaseExpiresAt: null as Date | null, newChatId: "chat_1",
      scheduledTaskId: "task_1" as string | null, status: "TRANSFERRED", storageKey: "workspace-continuation/seed.tar.gz" };
    const session = { chatId: "chat_1", id: "session_1", operationOwner: "run:run_owner", version: 2 };
    const tx = {
      $queryRaw: vi.fn(async () => []),
      chatContinuationWorkspaceSeed: { findUnique: vi.fn(async () => seed), updateMany: vi.fn(async () => ({ count: 1 })) },
      modelRun: { count: vi.fn(async () => 0) },
      workspaceSession: { findUnique: vi.fn(async () => session) }
    };
    const repository = createPrismaWorkspaceCoordinatorRepository({
      $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx)
    } as unknown as PrismaClient);
    const claim = () => repository.claimContinuationSeed!({ chatId: "chat_1", operation: { generation: 2, owner: "run:run_owner" },
      sessionId: "session_1" });
    // An interactive run in the new chat: required by the seed itself, never by which run claims it.
    await expect(claim()).resolves.toMatchObject({ id: "seed", required: true });
    expect(tx.modelRun.count).not.toHaveBeenCalled();
    // While another run restores it, a start fails visibly instead of opening an empty project.
    Object.assign(seed, { leaseExpiresAt: new Date(Date.now() + 60_000), status: "RESTORING" });
    await expect(claim()).rejects.toMatchObject({ code: "workspace_carryover_unavailable" });
    // Deleting the task leaves an ordinary continuation seed.
    Object.assign(seed, { leaseExpiresAt: null, scheduledTaskId: null, status: "TRANSFERRED" });
    await expect(claim()).resolves.not.toHaveProperty("required");
  });

  it.each(["restore", "unsupported"])("never lets a run go on with an empty carried project (%s fails)", async (failure) => {
    const value = fixture();
    Object.assign(value.repository, { claimContinuationSeed: vi.fn(async () => ({ id: "seed", token: "token",
      storageKey: "user_1/input", byteSize: 11, checksum: createHash("sha256").update("input bytes").digest("hex"), required: true })),
      settleContinuationSeed: vi.fn(async () => true) });
    value.runtime.restoreProjectArchive = failure === "unsupported" ? undefined
      : vi.fn(async () => { throw new WorkspaceRuntimeError("workspace_archive_invalid"); });
    const running = vi.spyOn(value.repository, "markSessionRunning");
    await expect(value.coordinator.execute({ call: { arguments: { command: "true" }, id: "call", name: value.shellToolName },
      modelRunToolCallId: "call", runId: value.runId, userId: "user_1", workspace: value.workspace }))
      .rejects.toMatchObject({ code: "workspace_carryover_unavailable" });
    // The claim is released with its archive kept for the next run; nothing settles it failed.
    expect(value.repository.settleContinuationSeed).toHaveBeenCalledOnce();
    expect(value.repository.settleContinuationSeed).toHaveBeenCalledWith({ id: "seed", status: "TRANSFERRED", token: "token" });
    expect(running).not.toHaveBeenCalled();
    expect(value.runtime.callBoundTool).not.toHaveBeenCalled();
  });

  it("restores a scheduled run's carried files before its first request and leaves other runs alone", async () => {
    const value = fixture();
    const pendingCarryover = vi.fn(async () => false);
    Object.assign(value.repository, { pendingCarryover, claimContinuationSeed: vi.fn(async () => ({ id: "seed", token: "token",
      storageKey: "user_1/input", byteSize: 11, checksum: createHash("sha256").update("input bytes").digest("hex"), required: true })),
      settleContinuationSeed: vi.fn(async () => true) });
    value.runtime.restoreProjectArchive = vi.fn(async () => undefined);
    const prepare = () => value.coordinator.prepareCarryover!({ runId: value.runId, userId: "user_1", workspace: value.workspace });
    await prepare();
    expect(value.runtime.ensureSession).not.toHaveBeenCalled();
    expect(value.runtime.restoreProjectArchive).not.toHaveBeenCalled();
    pendingCarryover.mockResolvedValue(true);
    await prepare();
    expect(pendingCarryover).toHaveBeenLastCalledWith({ chatId: "chat_1", runId: value.runId });
    expect(value.runtime.restoreProjectArchive).toHaveBeenCalledOnce();
    expect(value.repository.settleContinuationSeed).toHaveBeenCalledWith(expect.objectContaining({ status: "RESTORED" }));
    // The first command reuses the started Workspace: nothing is restored twice.
    await value.coordinator.execute({ call: { arguments: { command: "true" }, id: "call", name: value.shellToolName },
      modelRunToolCallId: "call", runId: value.runId, userId: "user_1", workspace: value.workspace });
    expect(value.runtime.restoreProjectArchive).toHaveBeenCalledOnce();
    expect(value.runtime.callBoundTool).toHaveBeenCalledOnce();
  });

  it("reports a carried project whose Workspace cannot start as unavailable, and nothing else", async () => {
    const value = fixture();
    const pendingCarryover = vi.fn(async () => true);
    Object.assign(value.repository, { pendingCarryover });
    vi.mocked(value.runtime.ensureSession).mockRejectedValueOnce(new WorkspaceRuntimeError("workspace_runtime_unavailable"));
    const prepare = () => value.coordinator.prepareCarryover!({ runId: value.runId, userId: "user_1", workspace: value.workspace });
    await expect(prepare()).rejects.toMatchObject({ code: "workspace_carryover_unavailable" });
    // Without a carried project a failing lookup keeps its own error.
    pendingCarryover.mockRejectedValueOnce(new Error("database_unavailable"));
    await expect(prepare()).rejects.toThrow("database_unavailable");
  });

  it.each(["cleanup", "settlement"])("fails closed when restore %s cannot be proven", async (failure) => {
    const value = fixture();
    Object.assign(value.repository, { claimContinuationSeed: vi.fn(async () => ({ id: "seed", token: "token", storageKey: "user_1/input", byteSize: 11, checksum: "a".repeat(64) })),
      settleContinuationSeed: vi.fn(async () => failure !== "settlement") });
    value.runtime.restoreProjectArchive = vi.fn(async () => {
      throw new WorkspaceRuntimeError(failure === "cleanup" ? "workspace_execution_cleanup_failed" : "workspace_archive_invalid");
    });
    const running = vi.spyOn(value.repository, "markSessionRunning");
    await expect(value.coordinator.execute({ call: { arguments: { command: "true" }, id: "call", name: value.shellToolName },
      modelRunToolCallId: "call", runId: value.runId, userId: "user_1", workspace: value.workspace })).rejects.toMatchObject({ code: "workspace_execution_cleanup_failed" });
    expect(value.runtime.restoreProjectArchive).toHaveBeenCalledOnce();
    // Unproven cleanup keeps the claim for lease-expiry recovery instead of settling FAILED.
    if (failure === "cleanup") expect(value.repository.settleContinuationSeed).not.toHaveBeenCalled();
    expect(running).not.toHaveBeenCalled();
    expect(value.runtime.callBoundTool).not.toHaveBeenCalled();
  });

  it.each([false, true])("records the accepted deadline and first abort source (parent=%s)", async (parent) => {
    vi.useFakeTimers();
    const value = fixture();
    const controller = new AbortController();
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    vi.mocked(value.runtime.callBoundTool).mockImplementation((input) => new Promise((_resolve, reject) => {
      input.signal!.addEventListener("abort", () => reject(input.signal!.reason), { once: true });
      ready();
    }));
    const pending = runWithContext({ trace_id: "1".repeat(32), tool_call_id: "stored", execution_index: 2 }, () => value.coordinator.execute({
      call: { arguments: { command: "PRIVATE_COMMAND_CANARY" }, id: "PRIVATE_PROVIDER_CALL_CANARY", name: value.shellToolName },
      modelRunToolCallId: "PRIVATE_STORED_CALL_CANARY", runId: value.runId, userId: "user_1", workspace: value.workspace, signal: controller.signal
    })).catch((error: unknown) => error);
    await started;
    if (parent) runWithContext({ trace_id: "2".repeat(32) }, () => controller.abort(new Error("PRIVATE_STOP_CANARY")));
    else await vi.advanceTimersByTimeAsync(value.workspace.syncToolTimeoutSeconds * 1_000);
    expect(await pending).toMatchObject({ code: parent ? "workspace_tool_cancelled" : "workspace_tool_timeout" });
    expect(value.runtime.callBoundTool).toHaveBeenCalledOnce();
    const records = writer.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(records).toContainEqual(expect.objectContaining({ event: "tool_deadline", tool_kind: "workspace", configured_timeout_ms: 1_000, effective_timeout_ms: 1_000 }));
    expect(records.filter((entry) => entry.event === "nested_abort")).toEqual([
      expect.objectContaining({ layer: "workspace", abort_source: parent ? "parent_signal" : "workspace_deadline", deadline_kind: "operation", timeout_ms: 1_000, trace_id: "1".repeat(32), tool_call_id: "stored", execution_index: 2 })
    ]);
    expect(records).toContainEqual(expect.objectContaining({ event: "tool_execution", stage: "execution", outcome: parent ? "cancelled" : "failed" }));
    expect(JSON.stringify(records)).not.toContain("PRIVATE_");
  });

  it("keeps the first parent observation while a later timer fires during cancellation cleanup", async () => {
    vi.useFakeTimers();
    const value = fixture();
    const controller = new AbortController();
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    vi.mocked(value.runtime.cancelToolCall).mockImplementation(() => cleanup);
    vi.mocked(value.runtime.callBoundTool).mockImplementation((input) => new Promise((_resolve, reject) => {
      input.signal!.addEventListener("abort", () => reject(input.signal!.reason), { once: true });
      ready();
    }));
    const pending = runWithContext({ trace_id: "1".repeat(32), tool_call_id: "stored" }, () => value.coordinator.execute({
      call: { arguments: { command: "PRIVATE_COMMAND_CANARY" }, id: "PRIVATE_PROVIDER_CALL_CANARY", name: value.shellToolName },
      modelRunToolCallId: "PRIVATE_STORED_CALL_CANARY", runId: value.runId, userId: "user_1", workspace: value.workspace, signal: controller.signal
    })).catch((error: unknown) => error);
    await started;
    runWithContext({ trace_id: "2".repeat(32) }, () => controller.abort(new Error("PRIVATE_STOP_CANARY")));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(value.runtime.cancelToolCall).toHaveBeenCalledOnce();
    finishCleanup();
    const failure = await pending;
    expect(failure).toBeInstanceOf(WorkspaceRuntimeError);
    const records = writer.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(records.filter((entry) => entry.event === "nested_abort")).toEqual([
      expect.objectContaining({ trace_id: "1".repeat(32), tool_call_id: "stored", abort_source: "parent_signal" })
    ]);
    // The execution record preserves the existing normalization independently of the first observed source.
    expect(records).toContainEqual(expect.objectContaining({ event: "tool_execution", stage: "execution", code: (failure as WorkspaceRuntimeError).code }));
    expect(JSON.stringify(records)).not.toContain("PRIVATE_");
  });

  it("reports a returned failure and a fixed rejection code without reading diagnostic fields from the payload", async () => {
    const value = fixture();
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.mocked(value.runtime.callBoundTool).mockResolvedValueOnce({ status: "error", content: [{ type: "text", text: "PRIVATE_RESULT_CANARY" }] });
    const run = (name: string, command: string) => value.coordinator.execute({
      call: { arguments: { command }, id: "PRIVATE_PROVIDER_CALL_CANARY", name }, modelRunToolCallId: "PRIVATE_STORED_CALL_CANARY",
      runId: value.runId, userId: "user_1", workspace: value.workspace
    });
    await expect(run(value.shellToolName, "PRIVATE_COMMAND_CANARY")).resolves.toMatchObject({ status: "error" });
    await expect(run(namespacedWorkspaceToolName("sandbox_exec"), "echo PRIVATE_COMMAND_CANARY && pwd")).resolves.toMatchObject({ status: "error" });
    expect(value.runtime.callBoundTool).toHaveBeenCalledOnce();
    const results = writer.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>).filter((entry) => entry.stage === "result");
    expect(results).toEqual([
      expect.objectContaining({ tool_kind: "workspace", outcome: "failed" }),
      expect.objectContaining({ tool_kind: "workspace", outcome: "failed", code: "workspace_shell_syntax_requires_shell" })
    ]);
    expect(results[0]).not.toHaveProperty("code");
    expect(JSON.stringify(results)).not.toContain("PRIVATE_");
  });

  it.each(["handoff", "cancelled"] as const)("saves browser bytes after quiescence and before retirement at %s", async (mode) => {
    const value = fixture(); value.setRuntimeSandboxId("runtime_1");
    const data = JSON.stringify({ cookies: [], origins: [] });
    await value.registry.register({ modelRunId: value.runId, modelRunToolCallId: "browser_start", runtimeExecSessionId: "browser_process", sessionId: value.workspace.sessionId });
    vi.mocked(value.runtime.collectBrowserSessions).mockResolvedValueOnce({ files: [outputStream(data, "shop.example.json")], skipped: ["browser_session_too_large"] });
    const drained: unknown[] = [];
    vi.mocked(value.repository.saveBrowserSessions).mockImplementationOnce(async (input) => {
      for await (const item of input.files) drained.push(item);
      return { saved: 1, unchanged: 0, skipped: { browser_session_too_large: 1 } };
    });
    const request = { runId: value.runId, userId: "user_1", workspace: value.workspace };
    if (mode === "handoff") await expect(value.coordinator.handoff(request)).resolves.toEqual({ status: "ready" });
    else await expect(value.coordinator.settle({ ...request, outcome: "cancelled" })).resolves.toMatchObject({ quiesced: true, sessionSettled: true });
    expect(value.repository.saveBrowserSessions).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      runId: value.runId, userId: "user_1", skipped: ["browser_session_too_large"]
    }));
    // The store pulls states itself, one at a time, after authorizing the run.
    expect(drained).toEqual([{ fileName: "shop.example.json", bytes: Buffer.from(data) }]);
    expect(vi.mocked(value.runtime.terminateExecutions).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(value.runtime.collectBrowserSessions).mock.invocationCallOrder[0]!);
    expect(vi.mocked(value.repository.saveBrowserSessions).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(value.runtime.retireSessionOperation!).mock.invocationCallOrder[0]!);
    if (mode === "handoff") expect(value.repository.saveBrowserSessions).toHaveBeenCalledWith(expect.objectContaining({ handoffToken: "lease_token_1" }));
    expect(await value.repository.generatedFiles({ runId: value.runId, userId: "user_1" })).toEqual([]);
  });

  it.each(["project", "off", "export", "recovery"] as const)("never reads or saves personal browser files during %s", async (mode) => {
    const value = fixture(); value.setRuntimeSandboxId("runtime_1");
    const binding = await value.repository.binding({ runId: value.runId, userId: "user_1" });
    if (mode === "project") vi.spyOn(value.repository, "binding").mockResolvedValue({ ...binding!, projectId: "project_1" });
    if (mode === "off") vi.spyOn(value.repository, "binding").mockResolvedValue(null);
    const request = { runId: value.runId, userId: "user_1", workspace: value.workspace };
    if (mode === "project" || mode === "off") await value.coordinator.settle({ ...request, outcome: "completed" });
    else await value.coordinator.finalize({ ...request, ...(mode === "recovery" ? { recovery: true } : {}) });
    expect(value.runtime.collectBrowserSessions).not.toHaveBeenCalled();
    expect(value.repository.saveBrowserSessions).not.toHaveBeenCalled();
  });

  it("keeps a browser cache read failure content-free and does not fail accepted handoff", async () => {
    const value = fixture(); value.setRuntimeSandboxId("runtime_1");
    vi.mocked(value.runtime.collectBrowserSessions).mockRejectedValueOnce(new Error("synthetic private cookie"));
    await expect(value.coordinator.handoff({ runId: value.runId, userId: "user_1", workspace: value.workspace })).resolves.toEqual({ status: "ready" });
    expect(value.repository.saveBrowserSessions).toHaveBeenCalledWith(expect.objectContaining({ files: [], skipped: ["browser_session_read_failed"] }));
  });

  it.each(["rejected", "reported"] as const)("records a %s whole-save failure as a content-free code without failing handoff", async (mode) => {
    const value = fixture(); value.setRuntimeSandboxId("runtime_1");
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    if (mode === "rejected") vi.mocked(value.repository.saveBrowserSessions).mockRejectedValueOnce(new Error("synthetic private cookie"));
    else vi.mocked(value.repository.saveBrowserSessions).mockResolvedValueOnce({ saved: 1, unchanged: 0, skipped: {}, failure: "browser_session_save_failed" });
    await expect(value.coordinator.handoff({ runId: value.runId, userId: "user_1", workspace: value.workspace })).resolves.toEqual({ status: "ready" });
    const lines = writer.mock.calls.map(([line]) => String(line));
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.code === "workspace_browser_session_save_failed");
    expect(entries).toEqual([expect.objectContaining({ subsystem: "workspace", outcome: "failed", action: "skip" })]);
    expect(lines.join("\n")).not.toContain("synthetic");
    expect(warn).not.toHaveBeenCalled();
  });

  it("prepares private accepted secrets once before the first command, preserving the accepted run on later calls", async () => {
    const value = fixture();
    const secrets = [{ id: "10000000-0000-4000-8000-000000000001", versionId: "10000000-0000-4000-8000-000000000002",
      name: "Fixture", description: "", value: { kind: "text" as const, text: "synthetic private input" } }];
    vi.mocked(value.repository.personalSecrets).mockResolvedValue(secrets);
    for (const id of ["first", "second"]) await value.coordinator.execute({
      call: { arguments: { path: "/workspace/SECRETS.md" }, id, name: namespacedWorkspaceToolName("sandbox_fs_read") },
      modelRunToolCallId: id, runId: value.runId, userId: "user_1", workspace: value.workspace
    });
    expect(value.repository.personalSecrets).toHaveBeenCalledOnce();
    expect(value.runtime.syncPersonalSecrets).toHaveBeenCalledOnce();
    expect(value.runtime.syncPersonalSecrets).toHaveBeenCalledWith(expect.objectContaining({
      modelRunId: value.runId, secrets, runtimeSandboxId: "runtime_1", operation: { generation: 1, owner: `run:${value.runId}` }
    }));
    expect(vi.mocked(value.runtime.syncPersonalSecrets).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(value.runtime.callBoundTool).mock.invocationCallOrder[0]!);
    expect(value.runtime.callBoundTool).not.toHaveBeenCalledWith(expect.objectContaining({ secrets }));
  });

  it.each([[true, true], [false, false], [undefined, false]] as const)(
    "bounds the uv cache once per execution initialization only for a scheduled run (scheduled %s)", async (scheduled, bounded) => {
      const value = fixture();
      const read = value.repository.binding.bind(value.repository);
      vi.spyOn(value.repository, "binding").mockImplementation(async (input) => {
        const binding = await read(input);
        return binding ? { ...binding, ...(scheduled === undefined ? {} : { scheduled }) } : null;
      });
      for (const id of ["first", "second"]) await value.coordinator.execute({
        call: { arguments: { command: "pwd" }, id, name: value.shellToolName },
        modelRunToolCallId: id, runId: value.runId, userId: "user_1", workspace: value.workspace
      });
      expect(value.runtime.syncPersonalSecrets).toHaveBeenCalledOnce();
      const [delivered] = vi.mocked(value.runtime.syncPersonalSecrets).mock.calls[0]!;
      expect(delivered.boundUvCache === true).toBe(bounded);
      // Never a model tool call: the only dispatched tool calls are the two commands.
      expect(value.runtime.callBoundTool).toHaveBeenCalledTimes(2);
    });

  it("masks delivered secret values before the result is persisted, sent to a provider or shown", async () => {
    const value = fixture();
    const token = "synthetic-token-0123456789";
    vi.mocked(value.repository.personalSecrets).mockResolvedValue([{ id: "10000000-0000-4000-8000-000000000001",
      versionId: "10000000-0000-4000-8000-000000000002", name: "Fixture", description: "",
      value: { kind: "env", entries: [{ name: "MY_TOKEN", value: token }] } }]);
    vi.mocked(value.runtime.callBoundTool).mockResolvedValueOnce({ content: [{ type: "text",
      text: JSON.stringify({ ok: true, data: { stdout: `${token}\n`, stderr: "", exitCode: 0, success: true } }, null, 2) }],
    exitCode: 0, status: "complete" });
    const activity: ThreadWorkspaceActivityEntry[] = [];
    const result = await value.coordinator.execute({
      call: { arguments: { command: "echo $MY_TOKEN" }, id: "call_secret", name: value.shellToolName },
      modelRunToolCallId: "call_secret", onActivity: async (entry) => { activity.push(entry); },
      runId: value.runId, userId: "user_1", workspace: value.workspace
    });
    const persisted = JSON.stringify(snapshotToolExecutionResult(result, toolLoopPersistenceLimits.resultBytes));
    const provider = JSON.stringify([openAIResponsesToolBridge.appendToolResult({}, result),
      anthropicMessagesToolBridge.appendToolResult({}, result)]);
    for (const surface of [persisted, provider, JSON.stringify(result)]) {
      expect(surface).toContain("[secret:MY_TOKEN]");
      expect(surface).not.toContain(token);
    }
    expect(result.rawPreview).toMatchObject({ secretMasked: true });
    const settled = (result.artifacts ?? []).map((event) => (event.data as { payload: ThreadWorkspaceActivityEntry }).payload);
    expect(settled.at(-1)?.command).toMatchObject({ secretMasked: true, stdoutPreview: "[secret:MY_TOKEN]\n" });
    expect(JSON.stringify([activity, settled])).not.toContain(token);
  });

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
    vi.mocked(value.runtime.ensureSession).mockRejectedValue(
      new WorkspaceRuntimeError("workspace_session_lost")
    );
    const lost = vi.spyOn(value.repository, "markSessionLost");

    await expect(value.coordinator.finalize({
      runId: value.runId,
      userId: "user_1",
      workspace: value.workspace
    })).resolves.toEqual({ code: "workspace_session_lost", retryable: false, status: "failed" });
    // The second lookup by name in the same lease proves the loss; nothing is recreated.
    expect(value.runtime.ensureSession).toHaveBeenCalledTimes(2);
    expect(vi.mocked(value.runtime.ensureSession).mock.calls.map(([input]) => input.runtimeSandboxId)).toEqual(["runtime_lost", "runtime_lost"]);
    expect(lost).toHaveBeenCalledOnce();
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
    expect(value.settledSessions).toEqual([]);
    expect(value.sessionState()).toBe("PENDING");
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
  it("stages a generated image in the current operation without restarting the guest or redelivering secrets", async () => {
    const value = fixture();
    await value.coordinator.execute({ call: { arguments: { command: "pwd" }, id: "init", name: value.shellToolName },
      modelRunToolCallId: "init", runId: value.runId, userId: "user_1", workspace: value.workspace });
    const first = (await value.repository.attachments(value.workspace as never))[0]!;
    const bytes = Buffer.from("verified immutable pixels");
    const image = { ...first, attachmentId: "generated_image", messageId: "assistant_1", kind: "image" as const,
      origin: "IMAGE_OUTPUT" as const, fileName: "generated.png", mimeType: "image/png", storageKey: "user_1/generated",
      byteSize: bytes.byteLength, checksum: createHash("sha256").update(bytes).digest("hex") };
    await value.storage.putObject({ storageKey: image.storageKey, contentType: image.mimeType, body: bytes });
    vi.spyOn(value.repository, "attachments").mockResolvedValue([first, image]);
    vi.mocked(value.runtime.stageAttachments).mockClear();
    let stagedBytes: ArrayBuffer | undefined;
    vi.mocked(value.runtime.stageAttachments).mockImplementationOnce(async input => {
      stagedBytes = await new Response(input.attachments.find(entry => entry.attachmentId === image.attachmentId)!.body).arrayBuffer();
    });
    const path = await value.coordinator.imagePath!({ attachmentId: image.attachmentId, runId: value.runId,
      userId: "user_1", workspace: value.workspace });
    expect(path).toBe(workspaceAttachmentPath({ attachmentId: image.attachmentId, messageId: image.messageId, originalName: image.fileName }));
    const staged = vi.mocked(value.runtime.stageAttachments).mock.calls[0]![0];
    expect(Buffer.from(stagedBytes!)).toEqual(bytes);
    expect(staged).toMatchObject({ operation: { owner: `run:${value.runId}`, generation: 1 },
      inboxIndex: { attachments: [expect.anything(), expect.objectContaining({ source: "export", sandboxPath: path })] } });
    expect(value.runtime.ensureSession).toHaveBeenCalledOnce();
    expect(value.runtime.syncPersonalSecrets).toHaveBeenCalledOnce();
    await expect(value.coordinator.imagePath!({ attachmentId: "foreign", runId: value.runId, userId: "user_1", workspace: value.workspace }))
      .rejects.toThrow("workspace_attachment_unavailable");
    expect(value.runtime.stageAttachments).toHaveBeenCalledOnce();
    const controller = new AbortController(); controller.abort();
    await expect(value.coordinator.imagePath!({ attachmentId: image.attachmentId, runId: value.runId,
      userId: "user_1", workspace: value.workspace, signal: controller.signal })).rejects.toThrow();
    expect(value.runtime.stageAttachments).toHaveBeenCalledOnce();
  });

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
  it("recovers owed outputs without requiring current Skill access or changing managed bundles", async () => {
    const value = fixture();
    value.setRuntimeSandboxId("runtime_1");
    const skills = { plan: vi.fn().mockRejectedValue(new Error("skill_not_available")), archive: vi.fn() };
    const fresh = createWorkspaceCoordinator({ ...value, skills });
    vi.mocked(value.runtime.collectOutputs).mockResolvedValueOnce([outputStream("report", "report.txt")]);
    await expect(fresh.finalize({ recovery: true, runId: value.runId, userId: "user_1" }))
      .resolves.toMatchObject({ status: "complete", files: [{ relativePath: "report.txt" }] });
    expect(skills.plan).not.toHaveBeenCalled();
    expect(skills.archive).not.toHaveBeenCalled();
    expect(value.runtime.prepareSkillRun).not.toHaveBeenCalled();
    expect(value.runtime.installSkillBundle).not.toHaveBeenCalled();
    expect(value.runtime.completeSkillRunPreparation).not.toHaveBeenCalled();
    expect(value.runtime.callBoundTool).not.toHaveBeenCalled();
  });

  it("retires the generation advanced by confirmed disk loss during handoff", async () => {
    const value = fixture();
    value.setRuntimeSandboxId("runtime_lost");
    vi.mocked(value.runtime.ensureSession).mockRejectedValue(new WorkspaceRuntimeError("workspace_session_lost"));
    const records = await exportRecords(() => expect(value.coordinator.handoff({ runId: value.runId, userId: "user_1", workspace: value.workspace }))
      .rejects.toMatchObject({ code: "workspace_session_lost" }));
    expect(records).toEqual([
      expect.objectContaining({ work_stage: "initialize", outcome: "degraded", code: "workspace_session_lost", action: "retry", run_id: value.runId }),
      expect.objectContaining({ work_stage: "initialize", outcome: "failed", code: "workspace_session_lost", action: "fail", run_id: value.runId })
    ]);
    expect(value.runtime.ensureSession).toHaveBeenCalledTimes(2);
    const binding = await value.repository.binding({ runId: value.runId, userId: "user_1" });
    expect(binding).toMatchObject({ operationGeneration: 3, operationOwner: null, runtimeSandboxId: null, sessionState: "PENDING" });
    expect(value.runtime.retireSessionOperation).toHaveBeenCalledExactlyOnceWith({
      operation: { generation: 3, owner: `export:${value.runId}:lease_token_1` }, runtimeSandboxId: null, sessionId: value.workspace.sessionId
    });
    expect(value.runtime.collectOutputs).not.toHaveBeenCalled();
    expect(await value.repository.generatedFiles({ runId: value.runId, userId: "user_1" })).toHaveLength(0);
  });

  it.each(["initialize", "resume", "collect"] as const)("hands off once more in the same lease when the guest is missing at %s", async (step) => {
    const value = fixture();
    value.setRuntimeSandboxId("runtime_1");
    // A returned shell command keeps its cleanup obligation, so quiescence stops the VM.
    await value.registry.register({ modelRunId: value.runId, modelRunToolCallId: "stored_shell",
      runtimeExecSessionId: workspaceSyncCleanupId("stored_shell"), sessionId: value.workspace.sessionId });
    const lost = new WorkspaceRuntimeError("workspace_session_lost");
    const ensure = vi.mocked(value.runtime.ensureSession);
    if (step === "initialize") ensure.mockRejectedValueOnce(lost);
    if (step === "resume") ensure.mockResolvedValueOnce({ runtimeSandboxId: "runtime_1", sandboxName: "aiqsa-ws-session_workspace_1", state: "ready" })
      .mockRejectedValueOnce(lost);
    if (step === "collect") vi.mocked(value.runtime.collectOutputs).mockRejectedValueOnce(lost);
    vi.mocked(value.runtime.collectOutputs).mockResolvedValueOnce([outputStream("report", "report.txt")]);
    const markLost = vi.spyOn(value.repository, "markSessionLost");
    const records = await exportRecords(() => expect(value.coordinator.handoff({ runId: value.runId, userId: "user_1", workspace: value.workspace }))
      .resolves.toEqual({ status: "ready" }));
    expect(markLost).not.toHaveBeenCalled();
    expect(ensure).toHaveBeenCalledTimes(3);
    // The export continues the run's own idle operation: its claim needs no receiver stop.
    expect(ensure).toHaveBeenNthCalledWith(1, expect.objectContaining({ predecessor: { generation: 1, owner: `run:${value.runId}` } }));
    expect(ensure.mock.calls.every(([input]) => input.runtimeSandboxId === "runtime_1")).toBe(true);
    // Quiescence stops the VM exactly once before the capture; the retry keeps that proof.
    const captured = vi.mocked(value.runtime.collectOutputs).mock.invocationCallOrder.at(-1)!;
    expect(vi.mocked(value.runtime.stopSession).mock.invocationCallOrder.filter((order) => order < captured)).toHaveLength(1);
    expect(value.registryRows).toEqual([expect.objectContaining({ modelRunToolCallId: "stored_shell", state: "LOST", stopConfirmed: true })]);
    expect(await value.repository.outputHandoffReady({ runId: value.runId, sessionId: value.workspace.sessionId })).toBe(true);
    expect(records).toEqual([expect.objectContaining({ work_stage: step, outcome: "degraded", code: "workspace_session_lost", action: "retry" })]);
  });

  it("keeps a second loss outside the confirming lookup unproven and retryable", async () => {
    const value = fixture();
    value.setRuntimeSandboxId("runtime_1");
    vi.mocked(value.runtime.collectOutputs).mockRejectedValue(new WorkspaceRuntimeError("workspace_session_lost"));
    const markLost = vi.spyOn(value.repository, "markSessionLost");
    const failed = vi.spyOn(value.repository, "markExportFailed");
    const records = await exportRecords(() => expect(value.coordinator.finalize({ handoff: true, runId: value.runId, userId: "user_1", workspace: value.workspace }))
      .resolves.toEqual({ code: "workspace_output_export_failed", retryable: true, status: "failed" }));
    expect(value.runtime.collectOutputs).toHaveBeenCalledTimes(2);
    expect(markLost).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "workspace_output_export_failed" }));
    expect(records.map((record) => [record.work_stage, record.outcome, record.code])).toEqual([
      ["collect", "degraded", "workspace_session_lost"], ["collect", "failed", "workspace_output_export_failed"]
    ]);
  });

  it.each(["retry", "collect", "confirmation"] as const)("ends cleanly without a loss verdict when the lease is gone at the %s", async (moment) => {
    const value = fixture();
    value.setRuntimeSandboxId("runtime_1");
    const lost = new WorkspaceRuntimeError("workspace_session_lost");
    if (moment === "confirmation") vi.mocked(value.runtime.ensureSession).mockRejectedValue(lost);
    else vi.mocked(value.runtime.ensureSession).mockRejectedValueOnce(lost);
    const renew = vi.spyOn(value.repository, "renewExportLease");
    if (moment === "retry") renew.mockResolvedValueOnce(false);
    else renew.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const markLost = vi.spyOn(value.repository, "markSessionLost");
    const failed = vi.spyOn(value.repository, "markExportFailed");
    const sealed = vi.spyOn(value.repository, "sealOutputCapture");
    const records = await exportRecords(() => expect(value.coordinator.finalize({ handoff: true, runId: value.runId, userId: "user_1", workspace: value.workspace }))
      .resolves.toEqual({ code: "workspace_output_export_failed", retryable: true, status: "failed" }));
    expect(value.runtime.ensureSession).toHaveBeenCalledTimes(moment === "retry" ? 1 : 2);
    expect(markLost).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(sealed).not.toHaveBeenCalled();
    expect(value.runtime.collectOutputs).not.toHaveBeenCalled();
    expect(records.at(-1)).toMatchObject({ work_stage: moment === "collect" ? "collect" : "initialize", outcome: "lost_lease",
      code: "workspace_output_export_failed", action: "fail" });
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
    const receipts: ThreadWorkspaceActivityEntry[] = [];
    const request = { runId: value.runId, userId: "user_1", workspace: value.workspace,
      onActivity: async (entry: ThreadWorkspaceActivityEntry) => { receipts.push(entry); } };
    await expect(value.coordinator.handoff(request)).resolves.toEqual({ status: "ready" });
    expect(receipts.filter(entry => entry.kind === "execution_status")).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "execution_status", phase: "closed" })
    ]));
    expect(pull).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce();
    expect(transfer).not.toHaveBeenCalled();
    expect(value.runtime.retireSessionOperation).toHaveBeenCalledOnce();
    expect(value.sessionState()).toBe("STOPPED");
    const fresh = createWorkspaceCoordinator(value);
    await expect(fresh.tools(request)).resolves.toHaveLength(value.tools.length);
    const previousReceipt = receipts.filter(entry => entry.kind === "execution_status").at(-1);
    await expect(fresh.handoff(request)).resolves.toEqual({ status: "ready" });
    expect(receipts.at(-1)).toEqual(previousReceipt);
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
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining(`Use ${namespacedWorkspaceToolName("sandbox_shell")}`)
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining(`but ${namespacedWorkspaceToolName("sandbox_exec")} does not`)
    });
    expect(value.runtime.ensureSession).not.toHaveBeenCalled();
    expect(value.runtime.callBoundTool).not.toHaveBeenCalled();
    expect(result.artifacts).toEqual([expect.objectContaining({
      data: expect.objectContaining({
        artifactType: "workspace_activity",
        payload: expect.objectContaining({
          command: expect.objectContaining({ preview: "pwd && ls -la && cat > script.py <<'PY'\nprint(1)\nPY" }),
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
    expect(exported).toEqual(["outputs_export:running:1", "outputs_export:succeeded:1", "execution_status:closed:"]);

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
    expect(stopped).toEqual(["workspace_stopped:cancelled", "execution_status:closed"]);
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
  expect(activity).toContainEqual(expect.objectContaining({ kind: "execution_status", phase: "unknown", errorCode: "workspace_execution_stop_failed" }));
});

it.each([false, true])("reads LOST stop proof=%s without redispatching a command", async stopConfirmed => {
  const value = fixture();
  value.registryRows.push({ id: "lost", state: "LOST", stopConfirmed, modelRunId: value.runId,
    modelRunToolCallId: "started", runtimeExecSessionId: "old", sessionId: value.workspace.sessionId });
  const result = await value.coordinator.execute({ call: { arguments: { execSessionId: "old" }, id: "poll",
    name: namespacedWorkspaceToolName("sandbox_exec_poll") }, modelRunToolCallId: "poll", runId: value.runId,
    userId: "user_1", workspace: value.workspace });
  expect(result).toMatchObject({ status: "error", content: [{ type: "text", text: expect.stringContaining(
    stopConfirmed ? "workspace_execution_stopped" : "workspace_execution_outcome_unknown") }] });
  expect(value.runtime.callBoundTool).not.toHaveBeenCalled();
});

it("retains known nonzero activity after successful cleanup and labels a later settlement failure separately", async () => {
  const value = fixture();
  vi.mocked(value.runtime.callBoundTool).mockResolvedValueOnce({ status: "error", errorCode: "workspace_command_failed", exitCode: 7,
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: "workspace_command_failed" }, data: { exitCode: 7, stdout: "", stderr: "bounded diagnostic" } }) }] });
  const result = await value.coordinator.execute({ call: { arguments: { command: "exit 7" }, id: "nonzero", name: value.shellToolName },
    modelRunToolCallId: "nonzero", runId: value.runId, userId: "user_1", workspace: value.workspace });
  const before = JSON.stringify(result);
  expect(result).toMatchObject({ status: "error", artifacts: [expect.objectContaining({ data: { artifactType: "workspace_activity", payload: expect.objectContaining({ errorCode: "workspace_command_failed", command: expect.objectContaining({ exitCode: 7 }) }) } })] });
  vi.spyOn(value.repository, "settleSession").mockRejectedValueOnce(new Error("PRIVATE_DB"));
  await expect(value.coordinator.settle({ outcome: "failed", runId: value.runId, userId: "user_1", workspace: value.workspace }))
    .rejects.toMatchObject({ code: "workspace_execution_settlement_failed" });
  expect(JSON.stringify(result)).toBe(before);
  expect(value.registryRows[0]).toMatchObject({ state: "LOST", stopConfirmed: true });
  expect(value.runtime.callBoundTool).toHaveBeenCalledOnce();
});

it("retains confirmed VM stop when retiring its operation cannot be confirmed", async () => {
  const value = fixture();
  await value.coordinator.execute({ call: { id: "prepare", name: value.shellToolName, arguments: { command: "true" } },
    modelRunToolCallId: "prepare", runId: value.runId, userId: "user_1", workspace: value.workspace });
  value.unregisteredCommands.count = 1;
  vi.mocked(value.runtime.retireSessionOperation!).mockRejectedValueOnce(new Error("PRIVATE_RETIREMENT"));
  await expect(value.coordinator.settle({ outcome: "failed", runId: value.runId, userId: "user_1", workspace: value.workspace }))
    .resolves.toEqual({ quiesced: false, sessionSettled: false, stoppedVm: true });
  expect(value.runtime.stopSession).toHaveBeenCalledOnce();
  expect(value.settledSessions).toEqual([]);
});

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function storedAttachments(memory: ReturnType<typeof createMemoryStorageAdapter>, count: number, prefix: string) {
  return Promise.all(Array.from({ length: count }, async (_, index) => {
    const bytes = Buffer.from(`${prefix} synthetic original ${index} `.repeat(1 + (index % 4)), "utf8");
    const storageKey = `user_1/${prefix}_${index}`;
    await memory.putObject({ body: bytes, contentType: "text/plain", storageKey });
    return {
      attachmentId: `${prefix}_attachment_${index}`,
      byteSize: bytes.byteLength,
      bytes,
      checksum: sha256(bytes),
      fileName: `${prefix}-${index}.txt`,
      kind: "document" as const,
      messageId: `${prefix}_message_${index % 3}`,
      mimeType: "text/plain",
      storageKey
    };
  }));
}

/** Guest stand-in: consumes each original in order and verifies it before its single write. */
function consumingStage(value: ReturnType<typeof fixture>, hooks: Readonly<{ afterFirstChunk?: (attachmentId: string) => Promise<void> }> = {}) {
  const written = new Map<string, Buffer>();
  const state = { indexWrites: 0, writesAfterAbort: 0 };
  vi.mocked(value.runtime.stageAttachments).mockImplementation(async (input) => {
    for (const attachment of input.attachments) {
      const reader = attachment.body.getReader();
      const chunks: Buffer[] = [];
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(Buffer.from(next.value));
        if (chunks.length === 1) await hooks.afterFirstChunk?.(attachment.attachmentId);
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.byteLength !== attachment.byteSize || sha256(bytes) !== attachment.checksum) {
        throw new WorkspaceRuntimeError("workspace_attachment_unavailable");
      }
      if (input.signal?.aborted) state.writesAfterAbort += 1;
      written.set(attachment.sandboxPath, bytes);
    }
    if (input.signal?.aborted) state.writesAfterAbort += 1;
    state.indexWrites += 1;
  });
  return { state, written };
}

function runWithin<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("workspace_staging_stalled")), ms);
  })]).finally(() => clearTimeout(timer));
}

function shellCall(value: ReturnType<typeof fixture>, coordinator: ReturnType<typeof createWorkspaceCoordinator>, signal?: AbortSignal) {
  return coordinator.execute({
    call: { arguments: { command: "pwd" }, id: "call_pool", name: value.shellToolName },
    modelRunToolCallId: "stored_pool", runId: value.runId, userId: "user_1", workspace: value.workspace,
    ...(signal ? { signal } : {})
  });
}

describe("Workspace coordinator bounded attachment acquisition", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("stages more originals than the storage pool holds, one open body at a time, with exact bytes and metadata", async () => {
    const pool = createPooledStorageAdapter(4);
    const value = fixture();
    const files = await storedAttachments(pool.memory, 55, "large");
    vi.spyOn(value.repository, "attachments").mockResolvedValue(files);
    const guest = consumingStage(value);
    const coordinator = createWorkspaceCoordinator({ ...value, storage: pool.storage });

    await expect(runWithin(shellCall(value, coordinator))).resolves.toMatchObject({ status: "complete" });

    expect(pool.stats).toMatchObject({ maxOpen: 1, open: 0, opened: 55, waiting: 0 });
    expect(guest.written.size).toBe(55);
    for (const file of files) {
      const path = workspaceAttachmentPath({ attachmentId: file.attachmentId, messageId: file.messageId, originalName: file.fileName });
      expect(guest.written.get(path)).toEqual(file.bytes);
    }
    const staged = vi.mocked(value.runtime.stageAttachments).mock.calls[0]![0];
    expect(staged.attachments.map((entry) => [entry.attachmentId, entry.byteSize, entry.checksum, entry.mimeType, entry.originalName]))
      .toEqual(files.map((file) => [file.attachmentId, file.byteSize, file.checksum, file.mimeType, file.fileName]));
    expect(staged.inboxIndex).toMatchObject({ attachments: files.map((file) => expect.objectContaining({ attachmentId: file.attachmentId })) });
    expect(staged.manifests.map((manifest) => manifest.messageId).sort()).toEqual(["large_message_0", "large_message_1", "large_message_2"]);
    expect(guest.state.indexWrites).toBe(1);
  });

  it("lets a small run sharing the storage client finish while a large run is mid-transfer", async () => {
    const pool = createPooledStorageAdapter(2);
    const large = fixture();
    const small = fixture();
    const largeFiles = await storedAttachments(pool.memory, 55, "large");
    const smallFiles = await storedAttachments(pool.memory, 1, "small");
    vi.spyOn(large.repository, "attachments").mockResolvedValue(largeFiles);
    vi.spyOn(small.repository, "attachments").mockResolvedValue(smallFiles);
    let paused!: () => void;
    const reached = new Promise<void>((resolve) => { paused = resolve; });
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const largeGuest = consumingStage(large, {
      async afterFirstChunk(attachmentId) {
        if (attachmentId !== "large_attachment_30") return;
        paused();
        await gate;
      }
    });
    const smallGuest = consumingStage(small);
    const largeRun = shellCall(large, createWorkspaceCoordinator({ ...large, storage: pool.storage }));
    await runWithin(reached);
    expect(largeGuest.written.size).toBe(30);

    await expect(runWithin(shellCall(small, createWorkspaceCoordinator({ ...small, storage: pool.storage }))))
      .resolves.toMatchObject({ status: "complete" });
    expect(smallGuest.written.size).toBe(1);
    expect(largeGuest.written.size).toBe(30);

    resume();
    await expect(runWithin(largeRun)).resolves.toMatchObject({ status: "complete" });
    expect(largeGuest.written.size).toBe(55);
    expect(pool.stats).toMatchObject({ maxOpen: 2, open: 0, waiting: 0 });
  });

  it.each(["missing", "size_mismatch"] as const)("releases the pool after a %s original and lets the next run stage", async (fault) => {
    const pool = createPooledStorageAdapter(1);
    const failed = fixture();
    const files = await storedAttachments(pool.memory, 6, "fault");
    if (fault === "missing") pool.memory.objects.delete(files[3]!.storageKey);
    else pool.memory.objects.set(files[3]!.storageKey, { body: Buffer.from("different length"), contentType: "text/plain", storageKey: files[3]!.storageKey });
    vi.spyOn(failed.repository, "attachments").mockResolvedValue(files);
    const markSessionFailed = vi.spyOn(failed.repository, "markSessionFailed");
    const onActivity = vi.fn(async () => undefined);
    const failedGuest = consumingStage(failed);
    await expect(runWithin(createWorkspaceCoordinator({ ...failed, storage: pool.storage }).execute({
      call: { arguments: { command: "pwd" }, id: "call_fault", name: failed.shellToolName },
      modelRunToolCallId: "stored_fault", onActivity, runId: failed.runId, userId: "user_1", workspace: failed.workspace
    }))).rejects.toMatchObject({ code: "workspace_attachment_unavailable" });
    expect(markSessionFailed).toHaveBeenCalledWith(expect.objectContaining({ code: "workspace_attachment_unavailable" }));
    expect(onActivity).toHaveBeenCalledWith(expect.objectContaining({
      kind: "attachments_prepare", phase: "failed", errorCode: "workspace_attachment_unavailable"
    }));
    expect(failedGuest.written.size).toBe(3);
    expect(failedGuest.state.indexWrites).toBe(0);
    expect(failed.runtime.callBoundTool).not.toHaveBeenCalled();
    expect(pool.stats).toMatchObject({ open: 0, waiting: 0 });

    const next = fixture();
    const nextFiles = await storedAttachments(pool.memory, 6, "next");
    vi.spyOn(next.repository, "attachments").mockResolvedValue(nextFiles);
    const nextGuest = consumingStage(next);
    await expect(runWithin(shellCall(next, createWorkspaceCoordinator({ ...next, storage: pool.storage }))))
      .resolves.toMatchObject({ status: "complete" });
    expect(nextGuest.written.size).toBe(6);
    expect(pool.stats).toMatchObject({ open: 0, waiting: 0 });
  });

  it("stops mid-transfer without later guest writes or tool dispatch and releases the held body", async () => {
    const pool = createPooledStorageAdapter(1);
    const value = fixture();
    const files = await storedAttachments(pool.memory, 5, "stop");
    pool.stalls.set(files[2]!.storageKey, new Promise<void>(() => undefined));
    vi.spyOn(value.repository, "attachments").mockResolvedValue(files);
    const markSessionFailed = vi.spyOn(value.repository, "markSessionFailed");
    let transferring!: () => void;
    const reached = new Promise<void>((resolve) => { transferring = resolve; });
    const guest = consumingStage(value, {
      async afterFirstChunk(attachmentId) { if (attachmentId === files[2]!.attachmentId) transferring(); }
    });
    const controller = new AbortController();
    const run = shellCall(value, createWorkspaceCoordinator({ ...value, storage: pool.storage }), controller.signal);
    await runWithin(reached);
    controller.abort(new Error("synthetic_stop"));
    await expect(runWithin(run)).rejects.toMatchObject({ code: "workspace_tool_cancelled" });
    expect(guest.written.size).toBe(2);
    expect(guest.state).toEqual({ indexWrites: 0, writesAfterAbort: 0 });
    expect(markSessionFailed).not.toHaveBeenCalled();
    expect(value.runtime.loadBoundTools).not.toHaveBeenCalled();
    expect(value.runtime.callBoundTool).not.toHaveBeenCalled();
    expect(pool.stats).toMatchObject({ open: 0, waiting: 0 });

    pool.stalls.clear();
    const next = fixture();
    vi.spyOn(next.repository, "attachments").mockResolvedValue(files);
    const nextGuest = consumingStage(next);
    await expect(runWithin(shellCall(next, createWorkspaceCoordinator({ ...next, storage: pool.storage }))))
      .resolves.toMatchObject({ status: "complete" });
    expect(nextGuest.written.size).toBe(5);
  });

  it("fails a storage wait that makes no progress with a bounded, observable code", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pool = createPooledStorageAdapter(0);
    const value = fixture();
    const files = await storedAttachments(pool.memory, 2, "stalled");
    vi.spyOn(value.repository, "attachments").mockResolvedValue(files);
    const markSessionFailed = vi.spyOn(value.repository, "markSessionFailed");
    const onActivity = vi.fn(async () => undefined);
    const guest = consumingStage(value);
    const run = createWorkspaceCoordinator({ ...value, storage: pool.storage }).execute({
      call: { arguments: { command: "pwd" }, id: "call_stalled", name: value.shellToolName },
      modelRunToolCallId: "stored_stalled", onActivity, runId: value.runId, userId: "user_1", workspace: value.workspace
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(WORKSPACE_ATTACHMENT_STORAGE_WAIT_MS - 1);
    expect(pool.stats.waiting).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await run).toMatchObject({ code: "workspace_attachment_timeout" });
    expect(markSessionFailed).toHaveBeenCalledWith(expect.objectContaining({ code: "workspace_attachment_timeout" }));
    expect(onActivity).toHaveBeenCalledWith(expect.objectContaining({
      kind: "workspace_start", phase: "failed", errorCode: "workspace_attachment_timeout"
    }));
    expect(guest.written.size).toBe(0);
    expect(value.runtime.callBoundTool).not.toHaveBeenCalled();
    expect(pool.stats).toMatchObject({ open: 0, opened: 0, waiting: 0 });
  });
});

describe("Workspace coordinator guest-code MCP", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  const token = "Synthetic_code_token_0123456789abcdefghijkl";
  const invocation = "b".repeat(32);
  const gateway = "http://host.microsandbox.internal:4311";
  type CodeRepository = Required<Pick<WorkspaceCoordinatorRepository,
    "closeCodeInvocation" | "codeCallSummary" | "issueCodeGrant" | "openCodeInvocation" | "revokeCodeGrant">>;

  function withCode(value: ReturnType<typeof fixture>,
    issue: Awaited<ReturnType<CodeRepository["issueCodeGrant"]>> = { environment: { AIQSA_GATEWAY_URL: gateway, AIQSA_RUN_TOKEN: token }, token }) {
    const code = {
      closeCodeInvocation: vi.fn<CodeRepository["closeCodeInvocation"]>(async () => undefined),
      codeCallSummary: vi.fn<CodeRepository["codeCallSummary"]>(async () => null),
      issueCodeGrant: vi.fn<CodeRepository["issueCodeGrant"]>(async () => issue),
      openCodeInvocation: vi.fn<CodeRepository["openCodeInvocation"]>(async () => invocation),
      revokeCodeGrant: vi.fn<CodeRepository["revokeCodeGrant"]>(async () => undefined)
    };
    Object.assign(value.repository, code);
    return code;
  }

  const shell = (value: ReturnType<typeof fixture>, id: string, onActivity?: (entry: ThreadWorkspaceActivityEntry) => Promise<void>) =>
    value.coordinator.execute({ call: { arguments: { command: "python3 report.py" }, id, name: value.shellToolName },
      modelRunToolCallId: id, ...(onActivity ? { onActivity } : {}), runId: value.runId, userId: "user_1", workspace: value.workspace });

  it("delivers a fresh run bearer through the run-bound environment and masks it in output", async () => {
    const value = fixture();
    const code = withCode(value);
    vi.mocked(value.runtime.callBoundTool).mockResolvedValueOnce({ content: [{ type: "text",
      text: JSON.stringify({ ok: true, data: { stdout: `AIQSA_RUN_TOKEN=${token}\n`, stderr: "", exitCode: 0, success: true } }, null, 2) }],
    exitCode: 0, status: "complete" });
    const activity: ThreadWorkspaceActivityEntry[] = [];
    const result = await shell(value, "call_env", async (entry) => { activity.push(entry); });
    expect(code.issueCodeGrant).toHaveBeenCalledOnce();
    expect(value.runtime.syncPersonalSecrets).toHaveBeenCalledWith(expect.objectContaining({
      runEnvironment: { AIQSA_GATEWAY_URL: gateway, AIQSA_RUN_TOKEN: token } }));
    for (const surface of [JSON.stringify(snapshotToolExecutionResult(result, toolLoopPersistenceLimits.resultBytes)),
      JSON.stringify(result), JSON.stringify(activity)]) {
      expect(surface).not.toContain(token);
    }
    expect(JSON.stringify(result)).toContain("[secret:AIQSA_RUN_TOKEN]");
  });

  it("gives every dispatched command its own invocation and closes it when the command returns", async () => {
    const value = fixture();
    const code = withCode(value);
    await shell(value, "call_one");
    expect(code.openCodeInvocation).toHaveBeenCalledWith({ kind: "command", modelRunToolCallId: "call_one",
      runId: value.runId, sessionId: value.workspace.sessionId });
    expect(value.runtime.callBoundTool).toHaveBeenCalledWith(expect.objectContaining({ invocationId: invocation }));
    expect(code.closeCodeInvocation).toHaveBeenCalledWith({ invocationId: invocation, runId: value.runId });
    // A failing command closes its invocation too.
    vi.mocked(value.runtime.callBoundTool).mockRejectedValueOnce(new WorkspaceRuntimeError("workspace_tool_outcome_unknown"));
    await expect(shell(value, "call_two")).rejects.toMatchObject({ code: "workspace_tool_outcome_unknown" });
    expect(code.closeCodeInvocation).toHaveBeenCalledTimes(2);
    // File tools run no code: no invocation.
    await value.coordinator.execute({ call: { arguments: { path: "/workspace/project/a.txt" }, id: "call_read",
      name: namespacedWorkspaceToolName("sandbox_fs_read") }, modelRunToolCallId: "call_read", runId: value.runId,
    userId: "user_1", workspace: value.workspace });
    expect(code.openCodeInvocation).toHaveBeenCalledTimes(2);
    expect(code.issueCodeGrant).toHaveBeenCalledOnce();
  });

  it("opens a fresh invocation when a lost guest is recreated before dispatch", async () => {
    const value = fixture();
    const code = withCode(value);
    code.openCodeInvocation.mockResolvedValueOnce("c".repeat(32)).mockResolvedValueOnce("d".repeat(32));
    vi.mocked(value.runtime.callBoundTool)
      .mockRejectedValueOnce(new WorkspaceRuntimeError("workspace_session_lost_before_dispatch"))
      .mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }], status: "complete" });
    await shell(value, "call_recreated");
    // Recreation rotates the bearer (fencing the undispatched invocation); the command runs with a new one.
    expect(code.issueCodeGrant).toHaveBeenCalledTimes(2);
    expect(vi.mocked(value.runtime.callBoundTool).mock.calls.map(([input]) => input.invocationId))
      .toEqual(["c".repeat(32), "d".repeat(32)]);
    expect(code.closeCodeInvocation).toHaveBeenCalledWith({ invocationId: "d".repeat(32), runId: value.runId });
  });

  it("appends one compact, content-free line about the command's code calls and shows it in activity", async () => {
    const value = fixture();
    const code = withCode(value);
    code.codeCallSummary.mockResolvedValueOnce({ calls: 37, failed: 1, refused: 0, unknown: 0, tools: [
      { calls: 35, errorCodes: [], failed: 0, label: { serverName: "GitLab", toolName: "list_commits" }, unknown: 0 },
      { calls: 2, errorCodes: ["upstream_unavailable"], failed: 1, label: { serverName: "GitLab", toolName: "get_job_log" }, unknown: 0 }
    ] });
    const activity: ThreadWorkspaceActivityEntry[] = [];
    const result = await shell(value, "call_summary", async (entry) => { activity.push(entry); });
    expect(code.codeCallSummary).toHaveBeenCalledWith({ runId: value.runId, toolCallId: "call_summary" });
    expect(result.content.at(-1)).toEqual({ type: "text",
      text: "code made 37 MCP calls: GitLab.list_commits ×35, GitLab.get_job_log ×2 (1 failed: upstream_unavailable)" });
    const settled = (result.artifacts ?? []).map((event) => (event.data as { payload: ThreadWorkspaceActivityEntry }).payload).at(-1);
    expect(settled?.command?.codeMcp).toEqual({ calls: 37, failed: 1, tools: [
      { calls: 35, failed: 0, serverName: "GitLab", toolName: "list_commits" },
      { calls: 2, failed: 1, serverName: "GitLab", toolName: "get_job_log" }
    ] });
    // Without code calls the result is unchanged.
    const plain = await shell(value, "call_plain");
    expect(plain.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("keeps an exec session's invocation open and reports its calls on polls that change them", async () => {
    const value = fixture();
    const code = withCode(value);
    vi.mocked(value.runtime.callBoundTool).mockResolvedValueOnce({ content: [{ text: JSON.stringify({ data: { execSessionId: "exec_code" }, ok: true }),
      type: "text" }], execSessionId: "exec_code", status: "complete" });
    await value.coordinator.execute({ call: { arguments: { command: "python3 monitor.py" }, id: "start",
      name: namespacedWorkspaceToolName("sandbox_exec_start") }, modelRunToolCallId: "start", runId: value.runId,
    userId: "user_1", workspace: value.workspace });
    expect(code.openCodeInvocation).toHaveBeenCalledWith(expect.objectContaining({ kind: "session", modelRunToolCallId: "start" }));
    expect(code.closeCodeInvocation).not.toHaveBeenCalled();
    code.codeCallSummary.mockResolvedValue({ calls: 2, failed: 0, refused: 0, unknown: 0, tools: [
      { calls: 2, errorCodes: [], failed: 0, label: { serverName: "GitLab", toolName: "list_commits" }, unknown: 0 }] });
    const poll = (id: string) => value.coordinator.execute({ call: { arguments: { execSessionId: "exec_code" }, id,
      name: namespacedWorkspaceToolName("sandbox_exec_poll") }, modelRunToolCallId: id, runId: value.runId, userId: "user_1",
    workspace: value.workspace });
    expect((await poll("poll_1")).content.at(-1)).toEqual({ type: "text", text: "code made 2 MCP calls: GitLab.list_commits ×2" });
    expect(code.codeCallSummary).toHaveBeenLastCalledWith({ runId: value.runId, toolCallId: "start" });
    expect((await poll("poll_2")).content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("revokes guest-code authority first on every terminal path", async () => {
    for (const outcome of ["completed", "cancelled", "failed", "timed_out"] as const) {
      const value = fixture();
      const code = withCode(value);
      await shell(value, "call");
      await value.coordinator.settle({ outcome, runId: value.runId, userId: "user_1", workspace: value.workspace });
      expect(code.revokeCodeGrant).toHaveBeenCalledWith({ runId: value.runId });
    }
    // Answer completion hands off after the last guest command.
    const value = fixture();
    const code = withCode(value);
    await shell(value, "call");
    await value.coordinator.handoff({ runId: value.runId, userId: "user_1", workspace: value.workspace });
    expect(code.revokeCodeGrant).toHaveBeenCalledWith({ runId: value.runId });
    expect(code.revokeCodeGrant.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(value.runtime.collectOutputs).mock.invocationCallOrder[0]!);
    // A revocation failure never blocks settlement.
    const failing = fixture();
    withCode(failing).revokeCodeGrant.mockRejectedValue(new Error("database unavailable"));
    await expect(failing.coordinator.settle({ outcome: "failed", runId: failing.runId, userId: "user_1" }))
      .resolves.toMatchObject({ quiesced: true });
  });

  it("tells code why it has no MCP authority, also when the grant cannot be issued", async () => {
    const value = fixture();
    withCode(value, { environment: { AIQSA_MCP_UNAVAILABLE: "internet_off" } });
    await shell(value, "call");
    expect(value.runtime.syncPersonalSecrets).toHaveBeenCalledWith(expect.objectContaining({
      runEnvironment: { AIQSA_MCP_UNAVAILABLE: "internet_off" } }));
    const failing = fixture();
    withCode(failing).issueCodeGrant.mockRejectedValue(new Error("database unavailable"));
    await expect(shell(failing, "call")).resolves.toMatchObject({ status: "complete" });
    expect(failing.runtime.syncPersonalSecrets).toHaveBeenCalledWith(expect.objectContaining({
      runEnvironment: { AIQSA_MCP_UNAVAILABLE: "gateway_unavailable" } }));
    // A stale operation still fails initialization.
    const stale = fixture();
    withCode(stale).issueCodeGrant.mockRejectedValue(new WorkspaceRuntimeError("workspace_operation_stale"));
    await expect(shell(stale, "call")).rejects.toMatchObject({ code: "workspace_operation_stale" });
  });

  it("never mints guest-code authority while exporting outputs", async () => {
    const value = fixture();
    value.setUntouchedSession("STOPPED");
    value.unregisteredCommands.count = 1;
    const code = withCode(value);
    const restarted = createWorkspaceCoordinator({ ...value, repository: value.repository, runtime: value.runtime });
    await expect(restarted.finalize({ runId: value.runId, userId: "user_1" })).resolves.toMatchObject({ status: "complete" });
    expect(value.runtime.syncPersonalSecrets).toHaveBeenCalled();
    expect(value.runtime.syncPersonalSecrets).not.toHaveBeenCalledWith(expect.objectContaining({ runEnvironment: expect.anything() }));
    expect(code.issueCodeGrant).not.toHaveBeenCalled();
  });
});
