import { describe, expect, it, vi } from "vitest";
import { WORKSPACE_MCP_TOOL_ALLOWLIST, workspaceRunOutputDirectory } from "@/lib/domain/workspace";
import type { NormalizedRunWorkspace } from "@/lib/server/providers/types";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import type { WorkspaceAgentProcessTermination } from "./agentProcessGuest";
import type { WorkspaceAttachedRun } from "./attachments";
import { getWorkspaceConfig } from "./config";
import { createWorkspaceCoordinator, type WorkspaceCoordinatorRepository, type WorkspaceExecutionBinding } from "./coordinator";
import { workspaceSyncCleanupId, type WorkspaceExecutionRecord, type WorkspaceExecutionRegistry } from "./executionRegistry";
import { WorkspaceRuntimeError, type WorkspaceBoundTool, type WorkspaceRuntime } from "./runtime";
import { namespacedWorkspaceToolName } from "./toolCatalog";

const config = getWorkspaceConfig({ AIQSA_TEST_MODE: "1", AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1", NODE_ENV: "test" });
const MAIN = "run_main";
const SUBAGENT = "run_subagent";
const THREAD = "thread_1";
const SESSION = "session_shared_1";
const tools: WorkspaceBoundTool[] = WORKSPACE_MCP_TOOL_ALLOWLIST.map((name) => ({
  description: name, inputSchema: { properties: {}, type: "object" }, namespacedName: namespacedWorkspaceToolName(name), originalName: name
}));

function workspaceOf(runId: string): NormalizedRunWorkspace {
  return {
    enabled: true, imageRef: config.imageRef, inboxIndexPath: "/workspace/inbox/index.json", internetEnabled: true,
    maxToolCalls: config.maxToolCalls, maxToolRounds: config.maxToolRounds, mcpVersion: "0.6.16",
    messageManifestPath: "/workspace/inbox/messages/message_1/manifest.json", outputDirectory: workspaceRunOutputDirectory(runId),
    projectDirectory: "/workspace/project", runtimeVersion: "0.6.16", sessionId: SESSION, syncToolTimeoutSeconds: 1,
    toolCatalogHash: "a".repeat(64), turnTimeoutSeconds: config.turnTimeoutSeconds
  };
}

/**
 * Two runs of one chat attached to one session under the main run's operation: the main agent's and a background
 * sub-agent's. Each has a sync command's cleanup obligation, as every run that ran a shell command does.
 */
function sharedFixture(options: Readonly<{ agentStop?: "closed" | "unknown" | "absent" }> = {}) {
  const attached = new Set([MAIN, SUBAGENT]);
  let operationOwner: string | null = `run:${MAIN}`;
  let operationGeneration = 3;
  let exportPending = false;
  const settled: string[] = [];
  const detached: Array<Readonly<{ runId: string; stopProven: boolean }>> = [];
  const binding = (runId: string): WorkspaceExecutionBinding => ({
    assistantMessageId: runId === MAIN ? "assistant_1" : "user_1", chatId: "chat_1", guestUsed: true, imageRef: config.imageRef,
    internetEnabled: true, mcpVersion: "0.6.16", operationAttached: attached.has(runId), operationGeneration, operationOwner,
    outputDirectory: workspaceRunOutputDirectory(MAIN), policyRevision: 1, runId, runtimeSandboxId: "runtime_1",
    runtimeVersion: "0.6.16", sandboxName: "aiqsa-ws-shared", sessionErrorCode: null, sessionId: SESSION, sessionState: "RUNNING",
    subagentThreadId: runId === SUBAGENT ? THREAD : null, toolCatalogHash: "a".repeat(64), toolDefinitions: tools,
    userId: "user_1", userMessageId: "user_1"
  });
  const rows: WorkspaceExecutionRecord[] = [MAIN, SUBAGENT].map((runId, index) => ({
    id: `execution_${index}`, modelRunId: runId, modelRunToolCallId: `call_${index}`,
    runtimeExecSessionId: workspaceSyncCleanupId(`call_${index}`), sessionId: SESSION, state: "ACTIVE"
  }));
  const registry: WorkspaceExecutionRegistry = {
    async closeAll({ modelRunId }) {
      let count = 0;
      for (const row of rows) if (!modelRunId || row.modelRunId === modelRunId) { Object.assign(row, { state: "LOST" }); count += 1; }
      return count;
    },
    async find() { return null; },
    async listOpen({ modelRunId }) {
      return rows.filter((row) => (!modelRunId || row.modelRunId === modelRunId) && row.state === "ACTIVE");
    },
    async register() { return "registered"; },
    async transition() { return true; }
  };
  const repository: WorkspaceCoordinatorRepository = {
    attachments: async () => [],
    async attachedRuns(current) {
      return current.operationOwner === operationOwner
        ? [...attached].map((runId): WorkspaceAttachedRun => ({ active: true, modelRunId: runId, subagentThreadId: runId === SUBAGENT ? THREAD : null }))
        : [];
    },
    binding: async ({ runId }) => binding(runId),
    // The main run's capture while the sub-agent stays attached: leased on its binding under the shared operation.
    claimExport: async (request) => ({ operation: request.operation, status: "claimed", token: "lease_token_1" }),
    claimExportForRecovery: async () => ({ status: "busy" }),
    detachRun: vi.fn(async ({ binding: current, stopProven }) => {
      if (!attached.delete(current.runId)) return false;
      detached.push({ runId: current.runId, stopProven });
      return true;
    }),
    evictAttachedRuns: vi.fn(async ({ binding: current }) => {
      const others = [...attached].filter((runId) => runId !== current.runId);
      for (const runId of others) attached.delete(runId);
      return others;
    }),
    exportRecoveryCandidates: async () => [],
    generatedFiles: async () => [],
    markExportComplete: async () => { exportPending = true; return true; },
    markExportFailed: async () => false,
    markExportPending: async () => { exportPending = true; return true; },
    markGuestUsed: async () => true,
    markSessionFailed: async () => undefined,
    // Only the run that found the loss keeps its attachment, under the next generation.
    markSessionLost: vi.fn(async ({ operation, runId }) => {
      operationGeneration = operation.generation + 1;
      for (const attachedRun of [...attached]) if (attachedRun !== runId) attached.delete(attachedRun);
      return { generation: operationGeneration, owner: operation.owner };
    }),
    markSessionReady: async () => undefined,
    markSessionRunning: async () => true,
    markSessionStarting: async () => true,
    outputHandoffReady: async () => exportPending && (operationOwner === null || !attached.has(MAIN)),
    personalSecrets: async () => [],
    prepareOutput: async () => false,
    renewExportLease: async () => true,
    reserveOutputCapture: async () => ({ create: true, id: "c".repeat(32), outputs: null }),
    retireUnusedRun: async () => false,
    runAgentIds: async ({ runId }) => runId === SUBAGENT ? [THREAD] : ["main"],
    saveBrowserSessions: vi.fn(async () => null),
    sealOutputCapture: async () => true,
    settleOutput: async () => { throw new Error("unused"); },
    settleSession: vi.fn(async ({ outcome }) => {
      settled.push(outcome);
      operationOwner = null;
      attached.clear();
      return true;
    }),
    unregisteredCommands: async () => 0
  };
  const runtime: WorkspaceRuntime = {
    callBoundTool: vi.fn(async () => ({ content: [{ text: "ok", type: "text" as const }], status: "complete" as const })),
    cancelToolCall: vi.fn(async () => undefined),
    claimSessionOperation: vi.fn(async () => undefined),
    collectBrowserSessions: vi.fn(async () => ({ files: [], skipped: [] })),
    collectOutputs: vi.fn(async () => []),
    completeSkillRunPreparation: vi.fn(async () => undefined),
    createProjectArchive: vi.fn(async () => { throw new Error("unused"); }),
    ensureSession: vi.fn(async () => ({ runtimeSandboxId: "runtime_1", sandboxName: "aiqsa-ws-shared", state: "running" as const })),
    health: vi.fn(async () => ({ state: "ready" as const })),
    installSkillBundle: vi.fn(async () => ({ workspacePath: "/unused" })),
    listStagedAttachments: vi.fn(async () => []),
    loadBoundTools: vi.fn(async () => ({ hash: "a".repeat(64), mcpVersion: "0.6.16", runtimeVersion: "0.6.16", tools })),
    prepareSkillRun: vi.fn(async () => ({ state: "ready" as const })),
    removeSession: vi.fn(async () => undefined),
    retireSessionOperation: vi.fn(async () => undefined),
    stageAttachments: vi.fn(async () => undefined),
    stopSession: vi.fn(async () => undefined),
    syncPersonalSecrets: vi.fn(async () => undefined),
    terminateExecutions: vi.fn(async (input: Parameters<WorkspaceRuntime["terminateExecutions"]>[0]) =>
      input.executions.map((execution) => ({ outcome: "closed" as const, runtimeExecSessionId: execution.runtimeExecSessionId }))),
    ...(options.agentStop === "absent" ? {} : {
      terminateAgentProcesses: vi.fn(async (): Promise<WorkspaceAgentProcessTermination> => ({ outcome: options.agentStop === "unknown" ? "unknown" : "closed" }))
    })
  };
  const interrupted = vi.fn(async (_input: Readonly<{ chatId: string; runIds: readonly string[]; userId: string }>) => undefined);
  const coordinator = createWorkspaceCoordinator({ config, onAttachedRunsInterrupted: interrupted, registry, repository, runtime,
    storage: createMemoryStorageAdapter() });
  return { attached, coordinator, detached, interrupted, registry, repository, rows, runtime, settled };
}

describe("a Workspace session shared by attached runs", () => {
  it("runs exec calls of both runs side by side under the one shared operation", async () => {
    const f = sharedFixture();
    const call = (runId: string) => f.coordinator.execute({
      call: { arguments: { command: "ls" }, id: `call-${runId}`, name: namespacedWorkspaceToolName("sandbox_shell") },
      modelRunToolCallId: `stored-${runId}`, runId, userId: "user_1", workspace: workspaceOf(MAIN)
    });
    const results = await Promise.all([call(MAIN), call(SUBAGENT)]);
    expect(results.map((result) => result.status)).toEqual(["complete", "complete"]);
    const operations = vi.mocked(f.runtime.callBoundTool).mock.calls.map(([input]) => input.operation);
    expect(operations).toEqual([{ generation: 3, owner: `run:${MAIN}` }, { generation: 3, owner: `run:${MAIN}` }]);
    expect(vi.mocked(f.runtime.callBoundTool).mock.calls.map(([input]) => input.modelRunId).sort()).toEqual([MAIN, SUBAGENT].sort());
  });

  it("ends one run by stopping only its own processes, and the VM and the other run go on", async () => {
    const f = sharedFixture();
    const result = await f.coordinator.settle({ outcome: "completed", runId: MAIN, userId: "user_1" });
    expect(result).toMatchObject({ quiesced: true, remainingRuns: 1, sessionSettled: true, stoppedVm: false });
    expect(f.runtime.terminateAgentProcesses).toHaveBeenCalledWith(expect.objectContaining({ agentId: "main" }));
    expect(f.runtime.terminateAgentProcesses).not.toHaveBeenCalledWith(expect.objectContaining({ agentId: THREAD }));
    expect(f.runtime.stopSession).not.toHaveBeenCalled();
    expect(f.runtime.retireSessionOperation).not.toHaveBeenCalled();
    expect(f.repository.settleSession).not.toHaveBeenCalled();
    expect(f.detached).toEqual([{ runId: MAIN, stopProven: true }]);
    expect(f.interrupted).not.toHaveBeenCalled();
    // The sub-agent still holds the operation and runs commands.
    await expect(f.coordinator.execute({
      call: { arguments: { command: "ls" }, id: "later", name: namespacedWorkspaceToolName("sandbox_shell") },
      modelRunToolCallId: "stored-later", runId: SUBAGENT, userId: "user_1", workspace: workspaceOf(MAIN)
    })).resolves.toMatchObject({ status: "complete" });
    // The last run's end is today's single-run path: the operation retires and the VM stops.
    const last = await f.coordinator.detach!({ chatId: "chat_1", execution: "settled", modelRunId: SUBAGENT, userId: "user_1" });
    expect(last).toEqual({ interruptedRunIds: [], kind: "detached", remainingRuns: 0 });
    expect(f.runtime.retireSessionOperation).toHaveBeenCalledOnce();
    expect(f.settled).toEqual(["stopped"]);
  });

  it.each(["unknown", "absent"] as const)("stops the VM and ends every attached run as interrupted when a stop is %s", async (agentStop) => {
    const f = sharedFixture({ agentStop });
    const result = await f.coordinator.settle({ outcome: "failed", runId: SUBAGENT, userId: "user_1" });
    expect(result).toMatchObject({ interruptedRunIds: [MAIN], quiesced: true, stoppedVm: true });
    expect(f.runtime.stopSession).toHaveBeenCalled();
    expect(f.runtime.retireSessionOperation).toHaveBeenCalledOnce();
    expect(f.settled).toEqual(["stopped"]);
    expect(f.interrupted).toHaveBeenCalledWith({ chatId: "chat_1", runIds: [MAIN], userId: "user_1" });
    expect(f.detached).toEqual([]);
  });

  it("fences the other runs before a shared export's unproven stop, and ends them before the VM resumes", async () => {
    const f = sharedFixture({ agentStop: "unknown" });
    await expect(f.coordinator.handoff({ runId: MAIN, userId: "user_1", workspace: workspaceOf(MAIN) })).resolves.toEqual({ status: "ready" });
    const order = (mock: { mock: { invocationCallOrder: number[] } }) => mock.mock.invocationCallOrder;
    const evicted = order(vi.mocked(f.repository.evictAttachedRuns!))[0]!;
    const interrupted = order(f.interrupted)[0]!;
    const stopped = order(vi.mocked(f.runtime.stopSession))[0]!;
    const resumed = order(vi.mocked(f.runtime.ensureSession)).at(-1)!;
    expect(f.interrupted).toHaveBeenCalledWith({ chatId: "chat_1", runIds: [SUBAGENT], userId: "user_1" });
    // No join or dispatch under the stop: the sub-agent lost its authority first, and ended before execution resumed.
    expect(evicted).toBeLessThan(interrupted);
    expect(interrupted).toBeLessThan(stopped);
    expect(stopped).toBeLessThan(resumed);
    expect(f.attached.has(SUBAGENT)).toBe(false);
    expect(vi.mocked(f.runtime.collectOutputs).mock.invocationCallOrder[0]).toBeGreaterThan(resumed);
  });

  it("lets only the run that found a lost disk go on, and ends the others instead of starting them over empty", async () => {
    const f = sharedFixture();
    vi.mocked(f.runtime.callBoundTool).mockRejectedValueOnce(new WorkspaceRuntimeError("workspace_session_lost_before_dispatch"));
    await expect(f.coordinator.execute({
      call: { arguments: { command: "ls" }, id: "lost", name: namespacedWorkspaceToolName("sandbox_shell") },
      modelRunToolCallId: "stored-lost", runId: SUBAGENT, userId: "user_1", workspace: workspaceOf(MAIN)
    })).resolves.toMatchObject({ status: "complete" });
    expect(f.repository.markSessionLost).toHaveBeenCalledWith(expect.objectContaining({ runId: SUBAGENT }));
    expect(f.interrupted).toHaveBeenCalledWith({ chatId: "chat_1", runIds: [MAIN], userId: "user_1" });
    await expect(f.coordinator.execute({
      call: { arguments: { command: "ls" }, id: "after", name: namespacedWorkspaceToolName("sandbox_shell") },
      modelRunToolCallId: "stored-after", runId: MAIN, userId: "user_1", workspace: workspaceOf(MAIN)
    })).rejects.toMatchObject({ code: "workspace_operation_stale" });
  });

  it("never settles the shared operation for a run that is no longer attached", async () => {
    const f = sharedFixture();
    f.attached.delete(SUBAGENT);
    await expect(f.coordinator.settle({ outcome: "completed", runId: SUBAGENT, userId: "user_1" }))
      .resolves.toEqual({ quiesced: false, sessionSettled: false, stoppedVm: false });
    expect(f.runtime.terminateAgentProcesses).not.toHaveBeenCalled();
    expect(f.runtime.retireSessionOperation).not.toHaveBeenCalled();
    await expect(f.coordinator.execute({
      call: { arguments: { command: "ls" }, id: "stale", name: namespacedWorkspaceToolName("sandbox_shell") },
      modelRunToolCallId: "stored-stale", runId: SUBAGENT, userId: "user_1", workspace: workspaceOf(MAIN)
    })).rejects.toMatchObject({ code: "workspace_operation_stale" });
  });

  it("detaches only within the run's own chat", async () => {
    const f = sharedFixture();
    await expect(f.coordinator.detach!({ chatId: "chat_other", execution: "unknown", modelRunId: SUBAGENT, userId: "user_1" }))
      .resolves.toEqual({ interruptedRunIds: [], kind: "detached", remainingRuns: 0 });
    expect(f.runtime.terminateAgentProcesses).not.toHaveBeenCalled();
    expect(f.attached.has(SUBAGENT)).toBe(true);
  });

  it("owes a sub-agent run no downloads", async () => {
    const f = sharedFixture();
    await expect(f.coordinator.finalize({ runId: SUBAGENT, userId: "user_1" })).resolves.toEqual({ files: [], status: "complete" });
    expect(f.runtime.collectOutputs).not.toHaveBeenCalled();
  });
});
