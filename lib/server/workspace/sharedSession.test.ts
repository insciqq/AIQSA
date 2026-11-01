import { describe, expect, it, vi } from "vitest";
import { WORKSPACE_MCP_TOOL_ALLOWLIST, workspaceRunOutputDirectory } from "@/lib/domain/workspace";
import { observedFailureCode } from "@/lib/server/providers/providerObservability";
import type { NormalizedRunWorkspace } from "@/lib/server/providers/types";
import type { WorkspaceSkillBundles } from "@/lib/server/skills/workspaceBundles";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import type { WorkspaceAgentProcessTermination } from "./agentProcessGuest";
import type { WorkspaceAttachedRun } from "./attachments";
import { getWorkspaceConfig } from "./config";
import {
  createWorkspaceCoordinator, WORKSPACE_BROWSER_RELEASE_WAIT_MS, type WorkspaceCoordinatorRepository, type WorkspaceExecutionBinding
} from "./coordinator";
import { workspaceSyncCleanupId, type WorkspaceExecutionRecord, type WorkspaceExecutionRegistry } from "./executionRegistry";
import { WorkspaceRuntimeError, type WorkspaceBoundTool, type WorkspaceRuntime } from "./runtime";
import { WorkspaceSkillRunState } from "./skillRunState";
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
function sharedFixture(options: Readonly<{ agentStop?: "closed" | "unknown" | "absent"; skills?: WorkspaceSkillBundles; unusedRuns?: readonly string[] }> = {}) {
  const attached = new Set([MAIN, SUBAGENT]);
  let operationOwner: string | null = `run:${MAIN}`;
  let operationGeneration = 3;
  let exportPending = false;
  let closing = false;
  const settled: string[] = [];
  const detached: Array<Readonly<{ runId: string; stopProven: boolean }>> = [];
  const binding = (runId: string): WorkspaceExecutionBinding => ({
    assistantMessageId: runId === MAIN ? "assistant_1" : "user_1", chatId: "chat_1", guestUsed: !options.unusedRuns?.includes(runId),
    imageRef: config.imageRef, internetEnabled: true, mcpVersion: "0.6.16", operationAttached: attached.has(runId), operationGeneration, operationOwner,
    outputDirectory: workspaceRunOutputDirectory(MAIN), policyRevision: 1, runId, runtimeSandboxId: "runtime_1",
    runtimeVersion: "0.6.16", sandboxName: "aiqsa-ws-shared", sessionErrorCode: null, sessionId: SESSION, sessionState: "RUNNING",
    subagentThreadId: runId === SUBAGENT ? THREAD : null, toolCatalogHash: "a".repeat(64), toolDefinitions: tools,
    userId: "user_1", userMessageId: "user_1"
  });
  const rows: WorkspaceExecutionRecord[] = [MAIN, SUBAGENT].filter((runId) => !options.unusedRuns?.includes(runId)).map((runId, index) => ({
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
    // The detach left no attachment of another run: the operation closes, and this run settles the session.
    closeRunOperationIfLast: vi.fn(async (current: WorkspaceExecutionBinding) => {
      if (closing || [...attached].some((runId) => runId !== current.runId)) return false;
      closing = true;
      return true;
    }),
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
    runProxyPlan: async () => null,
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
    ...(options.skills ? { skills: options.skills } : {}), storage: createMemoryStorageAdapter() });
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

  it("prepares both runs' Skills side by side, and neither refuses the other's commands", async () => {
    const ref = { alias: "review", revisionId: "revision", bundleDigest: "b".repeat(64), discover: false };
    const skills: WorkspaceSkillBundles = {
      plan: vi.fn(async () => ({ initial: [ref], manifestHash: "c".repeat(64) })),
      archive: vi.fn(async () => ({ bundle: ref, byteSize: 1, checksum: "d".repeat(64),
        archive: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }) }))
    };
    const f = sharedFixture({ skills });
    const state = new WorkspaceSkillRunState();
    const reset = vi.fn(async () => undefined);
    const guest = vi.fn(async () => undefined);
    vi.mocked(f.runtime.prepareSkillRun).mockImplementation((input) => state.prepare(input, reset));
    vi.mocked(f.runtime.installSkillBundle).mockImplementation((input) => state.install(input, input.bundle, async (present) => {
      if (!present) await guest();
      return { workspacePath: `/workspace/.aiqsa/skills/${input.bundle.alias}` };
    }));
    vi.mocked(f.runtime.completeSkillRunPreparation).mockImplementation((input) => state.complete(input, async () => undefined));
    const markFailed = vi.spyOn(f.repository, "markSessionFailed");
    const call = (runId: string) => f.coordinator.execute({
      call: { arguments: { command: "ls" }, id: `call-${runId}`, name: namespacedWorkspaceToolName("sandbox_shell") },
      modelRunToolCallId: `stored-${runId}`, runId, userId: "user_1", workspace: workspaceOf(MAIN)
    });
    const results = await Promise.all([call(MAIN), call(SUBAGENT)]);
    expect(results.map((result) => result.status)).toEqual(["complete", "complete"]);
    expect(vi.mocked(f.runtime.callBoundTool).mock.calls.map(([input]) => input.modelRunId).sort()).toEqual([MAIN, SUBAGENT].sort());
    expect(reset).toHaveBeenCalledOnce();
    expect(guest).toHaveBeenCalledOnce();
    expect(markFailed).not.toHaveBeenCalled();
  });

  it.each(["workspace_skill_conflict", "workspace_skill_run_stale", "workspace_skills_prepare_failed", "workspace_skill_bundle_invalid",
    "workspace_skill_bundle_limit_exceeded"] as const)("answers a run's %s as a refusal, with the shared session untouched", async (code) => {
    const f = sharedFixture();
    vi.mocked(f.runtime.prepareSkillRun).mockRejectedValueOnce(new WorkspaceRuntimeError(code));
    const markFailed = vi.spyOn(f.repository, "markSessionFailed");
    const call = (runId: string, id: string) => f.coordinator.execute({
      call: { arguments: { command: "ls" }, id, name: namespacedWorkspaceToolName("sandbox_shell") },
      modelRunToolCallId: `stored-${id}`, runId, userId: "user_1", workspace: workspaceOf(MAIN)
    });
    const refused = await call(SUBAGENT, "refused");
    expect(refused.status).toBe("error");
    expect(JSON.stringify(refused.content)).toContain(code);
    expect(observedFailureCode(new WorkspaceRuntimeError(code))).toBe(code);
    expect(f.runtime.callBoundTool).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    // Its next call prepares again, and the other run never noticed.
    await expect(call(SUBAGENT, "again")).resolves.toMatchObject({ status: "complete" });
    await expect(call(MAIN, "main")).resolves.toMatchObject({ status: "complete" });
  });

  describe("a run's saved environment", () => {
    const command = (f: ReturnType<typeof sharedFixture>, runId: string, id: string, signal?: AbortSignal) => f.coordinator.execute({
      call: { arguments: { command: "ls" }, id, name: namespacedWorkspaceToolName("sandbox_shell") },
      modelRunToolCallId: `stored-${id}`, runId, ...(signal ? { signal } : {}), userId: "user_1", workspace: workspaceOf(MAIN)
    });
    const syncedRuns = (f: ReturnType<typeof sharedFixture>) => vi.mocked(f.runtime.syncPersonalSecrets).mock.calls.map(([input]) => input.modelRunId);
    const READ_BACK_CODES = ["workspace_secret_env_invalid", "workspace_secret_env_missing", "workspace_secret_env_output_limit",
      "workspace_secret_env_read_failed", "workspace_secret_env_read_timeout", "workspace_secret_env_unreadable"] as const;

    it("is installed one run at a time, so a run starting beside another never loses its entry", async () => {
      const f = sharedFixture();
      // The guest installer's shape: read the shared file, add this run, replace the file.
      let file: readonly string[] = [];
      vi.mocked(f.runtime.syncPersonalSecrets).mockImplementation(async ({ modelRunId }) => {
        const read = file;
        await new Promise((resolve) => setTimeout(resolve, 2));
        file = [...read, modelRunId];
      });
      const results = await Promise.all([command(f, MAIN, "main"), command(f, SUBAGENT, "subagent")]);
      expect(results.map((result) => result.status)).toEqual(["complete", "complete"]);
      expect([...file].sort()).toEqual([MAIN, SUBAGENT].sort());
    });

    it("waits for the other run's install without touching the guest, so a Stop there stops only the wait", async () => {
      const f = sharedFixture();
      let finish = () => undefined as void;
      vi.mocked(f.runtime.syncPersonalSecrets).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
      const main = command(f, MAIN, "main");
      await vi.waitFor(() => expect(f.runtime.syncPersonalSecrets).toHaveBeenCalledOnce());
      const controller = new AbortController();
      const waiting = command(f, SUBAGENT, "subagent", controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 2));
      controller.abort();
      await expect(waiting).rejects.toMatchObject({ code: "workspace_tool_cancelled" });
      expect(f.runtime.syncPersonalSecrets).toHaveBeenCalledOnce();
      finish();
      await expect(main).resolves.toMatchObject({ status: "complete" });
    });

    it.each(READ_BACK_CODES)("goes back into the guest after %s, and the call that nothing dispatched is sent once", async (code) => {
      const f = sharedFixture();
      const markFailed = vi.spyOn(f.repository, "markSessionFailed");
      vi.mocked(f.runtime.callBoundTool).mockRejectedValueOnce(new WorkspaceRuntimeError(code));
      await expect(command(f, SUBAGENT, "sent")).resolves.toMatchObject({ status: "complete" });
      expect(syncedRuns(f)).toEqual([SUBAGENT, SUBAGENT]);
      expect(vi.mocked(f.runtime.callBoundTool).mock.calls.map(([input]) => input.modelRunToolCallId)).toEqual(["stored-sent", "stored-sent"]);
      expect(observedFailureCode(new WorkspaceRuntimeError(code))).toBe(code);
      expect(markFailed).not.toHaveBeenCalled();
      expect(f.interrupted).not.toHaveBeenCalled();
    });

    it("installs once for two calls of a run refused together", async () => {
      const f = sharedFixture();
      vi.mocked(f.runtime.callBoundTool)
        .mockRejectedValueOnce(new WorkspaceRuntimeError("workspace_secret_env_missing"))
        .mockRejectedValueOnce(new WorkspaceRuntimeError("workspace_secret_env_missing"));
      const results = await Promise.all([command(f, MAIN, "first"), command(f, MAIN, "second")]);
      expect(results.map((result) => result.status)).toEqual(["complete", "complete"]);
      expect(syncedRuns(f)).toEqual([MAIN, MAIN]);
      expect(f.runtime.callBoundTool).toHaveBeenCalledTimes(4);
    });

    it("answers a refusal that outlives the recovery as a known failure the model can act on, and the next call works", async () => {
      const f = sharedFixture();
      const markFailed = vi.spyOn(f.repository, "markSessionFailed");
      vi.mocked(f.runtime.callBoundTool)
        .mockRejectedValueOnce(new WorkspaceRuntimeError("workspace_secret_env_missing"))
        .mockRejectedValueOnce(new WorkspaceRuntimeError("workspace_secret_env_unreadable"));
      const refused = await command(f, SUBAGENT, "refused");
      expect(refused.status).toBe("error");
      expect(JSON.stringify(refused.content)).toContain("workspace_secret_env_unreadable");
      expect(JSON.stringify(refused.content)).toContain("nothing ran");
      expect(markFailed).not.toHaveBeenCalled();
      await expect(command(f, SUBAGENT, "again")).resolves.toMatchObject({ status: "complete" });
      await expect(command(f, MAIN, "main")).resolves.toMatchObject({ status: "complete" });
    });

    it("keeps the first refusal when putting the environment back fails too", async () => {
      const f = sharedFixture();
      vi.mocked(f.runtime.callBoundTool).mockRejectedValueOnce(new WorkspaceRuntimeError("workspace_secret_env_missing"));
      vi.mocked(f.runtime.syncPersonalSecrets).mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new WorkspaceRuntimeError("workspace_runtime_unavailable"));
      const refused = await command(f, SUBAGENT, "refused");
      expect(refused.status).toBe("error");
      expect(JSON.stringify(refused.content)).toContain("workspace_secret_env_missing");
      expect(f.runtime.callBoundTool).toHaveBeenCalledOnce();
    });

    it("answers a failed install as a refusal of this run, with the shared session untouched", async () => {
      const f = sharedFixture();
      const markFailed = vi.spyOn(f.repository, "markSessionFailed");
      vi.mocked(f.runtime.syncPersonalSecrets).mockRejectedValueOnce(new WorkspaceRuntimeError("workspace_secrets_prepare_failed"));
      const refused = await command(f, SUBAGENT, "refused");
      expect(refused.status).toBe("error");
      expect(JSON.stringify(refused.content)).toContain("workspace_secrets_prepare_failed");
      expect(f.runtime.callBoundTool).not.toHaveBeenCalled();
      expect(markFailed).not.toHaveBeenCalled();
      await expect(command(f, SUBAGENT, "again")).resolves.toMatchObject({ status: "complete" });
    });

    it("leaves a Stop that lands on a refusal a cancellation, with no recovery", async () => {
      const f = sharedFixture();
      const controller = new AbortController();
      vi.mocked(f.runtime.callBoundTool).mockImplementationOnce(async () => {
        controller.abort();
        throw new WorkspaceRuntimeError("workspace_secret_env_missing");
      });
      await expect(command(f, MAIN, "stopped", controller.signal)).rejects.toMatchObject({ code: "workspace_tool_cancelled" });
      expect(f.runtime.syncPersonalSecrets).toHaveBeenCalledOnce();
    });

    it("never reads an error after dispatch as a refusal", async () => {
      const f = sharedFixture();
      vi.mocked(f.runtime.callBoundTool).mockRejectedValueOnce(new WorkspaceRuntimeError("workspace_tool_outcome_unknown"));
      await expect(command(f, MAIN, "sent")).rejects.toMatchObject({ code: "workspace_tool_outcome_unknown" });
      expect(f.runtime.callBoundTool).toHaveBeenCalledOnce();
      expect(f.runtime.syncPersonalSecrets).toHaveBeenCalledOnce();
    });
  });

  it("releases one agent's browser slot in the run's guest, and nothing once the run no longer holds the Workspace", async () => {
    const f = sharedFixture();
    const agent = { kind: "subagent" as const, name: "shop", threadId: THREAD };
    await f.coordinator.releaseBrowserAgent!({ agent, runId: SUBAGENT, userId: "user_1" });
    expect(f.runtime.callBoundTool).toHaveBeenCalledWith(expect.objectContaining({ agent, arguments: { args: ["release"], command: "aiqsa-browser" },
      modelRunId: SUBAGENT, operation: { generation: 3, owner: `run:${MAIN}` }, originalName: "sandbox_exec", runtimeSandboxId: "runtime_1",
      sessionId: SESSION }));
    // Two agents of one run that end together never share the release's active-call key.
    await f.coordinator.releaseBrowserAgent!({ agent: { kind: "subagent", name: "notes", threadId: "thread_2" }, runId: SUBAGENT, userId: "user_1" });
    const keys = vi.mocked(f.runtime.callBoundTool).mock.calls.map(([call]) => call.modelRunToolCallId);
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toContain(THREAD);
    // A guest that never answers holds the turn's end only for the bound, after which the idle release frees the slot.
    vi.useFakeTimers();
    try {
      vi.mocked(f.runtime.callBoundTool).mockImplementationOnce(() => new Promise<never>(() => undefined));
      let done = false;
      const pending = f.coordinator.releaseBrowserAgent!({ agent, runId: SUBAGENT, userId: "user_1" }).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(WORKSPACE_BROWSER_RELEASE_WAIT_MS + 1);
      await pending;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    vi.mocked(f.runtime.callBoundTool).mockClear();
    f.attached.delete(SUBAGENT);
    await f.coordinator.releaseBrowserAgent!({ agent, runId: SUBAGENT, userId: "user_1" });
    expect(f.runtime.callBoundTool).not.toHaveBeenCalled();
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

  it("stops the VM when a run that never used it leaves last, with no browser save of its own", async () => {
    const f = sharedFixture({ unusedRuns: [SUBAGENT] });
    await f.coordinator.settle({ outcome: "completed", runId: MAIN, userId: "user_1" });
    expect(f.runtime.retireSessionOperation).not.toHaveBeenCalled();
    expect(f.runtime.collectBrowserSessions).toHaveBeenCalledOnce();
    // The repository refuses the shortcut for the last run of a running VM: this is the path every last run takes.
    await expect(f.coordinator.detach!({ chatId: "chat_1", execution: "settled", modelRunId: SUBAGENT, userId: "user_1" }))
      .resolves.toEqual({ interruptedRunIds: [], kind: "detached", remainingRuns: 0 });
    expect(f.runtime.retireSessionOperation).toHaveBeenCalledOnce();
    expect(f.settled).toEqual(["stopped"]);
    expect(f.attached.size).toBe(0);
    // The main run's sign-ins were saved as it left; this run has none, and the chat waits on this stop.
    expect(f.runtime.collectBrowserSessions).toHaveBeenCalledOnce();
    expect(f.interrupted).not.toHaveBeenCalled();
  });

  it("releases the operation when the attached runs end together, each having seen the other still attached", async () => {
    const f = sharedFixture();
    // Both runs read the other as attached before either has detached (a run's status is written after its detach).
    let waiting = 0;
    let release: () => void = () => undefined;
    const bothStopping = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(f.runtime.terminateAgentProcesses!).mockImplementation(async () => {
      waiting += 1;
      if (waiting === 2) release();
      await bothStopping;
      return { outcome: "closed" };
    });
    const [main, subagent] = await Promise.all([
      f.coordinator.settle({ outcome: "completed", runId: MAIN, userId: "user_1" }),
      f.coordinator.settle({ outcome: "completed", runId: SUBAGENT, userId: "user_1" })
    ]);
    expect(f.detached.map((entry) => entry.runId).sort()).toEqual([MAIN, SUBAGENT].sort());
    // The one that left last retired the operation and settled the session: no owner stays with no run under it.
    expect(f.repository.closeRunOperationIfLast).toHaveBeenCalledTimes(2);
    expect(f.runtime.retireSessionOperation).toHaveBeenCalledOnce();
    expect(f.settled).toHaveLength(1);
    expect([main, subagent].filter((result) => result.sessionSettled)).toHaveLength(2);
    expect(f.interrupted).not.toHaveBeenCalled();
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
