// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryNativeEngine, nativePrepared, nativeRunRepository, scriptedNativeAdapter } from "@/tests/support/nativeRunExecution";
import type { NativeEngineHandlerDeps } from "../engine/handlerSupport";
import type { ProviderAdapter, ProviderRunRequest } from "../providers/types";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import type { RunSecretSource } from "../workspace/secrets/runSecrets";
import { activeRunControllerRegistry as registry } from "./activeRunControllerRegistry";
import type { RunRepository } from "./runRepositoryContract";
import { createWorkspaceFollowupContinuation } from "./workspaceFollowupContinuation";
import { createWorkspaceFollowupCoordinator, type WorkspaceFollowupLoaded } from "./workspaceFollowupCoordinator";
import { WorkspaceFollowupError } from "./workspaceFollowupPersistence";

/**
 * A successor admitted behind the previous answer's Workspace hand-off (a
 * quick follow-up): the Workspace follow-up starts it on the agent engine,
 * only once the predecessor finished.
 */
const claim = { claimToken: "claim-token", runId: "follow-run", userId: "owner" };
const admitted = { assistantMessageId: "answer-2", runId: "follow-run", userMessageId: "question-2" };
const workspaceRequest = { workspace: { enabled: true, syncToolTimeoutSeconds: 30, turnTimeoutSeconds: 600 } as ProviderRunRequest["workspace"] };

function loadedFollowup(input: Readonly<{ engine?: "native" | "v1"; native?: Readonly<{ approvalId?: string; telegram?: true }>;
  status?: "preparing" | "streaming" }> = {}): WorkspaceFollowupLoaded {
  return {
    admissionResult: { ...admitted },
    deadlineAt: new Date(Date.now() + 60_000),
    modelRun: { chatId: "chat", createdAt: new Date(), engine: input.engine ?? "native", normalizedRequest: null, status: input.status ?? "preparing",
      workspaceWaitPending: true },
    predecessor: { status: "complete" },
    snapshot: { ...(input.native ? { native: input.native } : {}), prepared: nativePrepared(workspaceRequest), version: 1 }
  } as unknown as WorkspaceFollowupLoaded;
}

/** The successor's Workspace: what it was asked to do, in order. */
function recordingWorkspace(order: string[]) {
  return {
    accepts: () => true,
    execute: vi.fn(),
    handoff: vi.fn(async () => { order.push("workspace:handoff"); return { status: "ready" }; }),
    prepareCarryover: vi.fn(async () => { order.push("workspace:carryover"); }),
    settle: vi.fn(async () => undefined),
    tools: vi.fn(async () => { order.push("workspace:tools"); return []; })
  };
}

function continuation(input: Readonly<{ adapter: ProviderAdapter; memory: ReturnType<typeof memoryNativeEngine>; order: string[] }>) {
  const secrets: RunSecretSource = { list: vi.fn(async () => []), read: vi.fn() };
  const nativeEngine: NativeEngineHandlerDeps = { engine: input.memory.engine,
    findOrphans: async () => [], tools: { secrets, selfService: { assistants: {} as never, db: {} as never, storage: {} as never } } };
  const repository = { ...nativeRunRepository(), continueWorkspacePreparedRun: vi.fn(async (activation: { created: typeof admitted }) => {
    input.order.push("activated");
    return { ...activation.created };
  }), loadAttachments: vi.fn(async () => []) };
  const followups = { markAnswerDispatched: vi.fn(async () => { input.order.push("dispatched"); return true; }) };
  const workspace = recordingWorkspace(input.order);
  const continueRun = createWorkspaceFollowupContinuation({ followups: followups as never, kickPdf: vi.fn(), nativeEngine,
    providerRuntime: { resolve: vi.fn(async () => ({ adapter: input.adapter })) } as never,
    repository: repository as unknown as RunRepository, storage: {} as never, workspace: workspace as unknown as WorkspaceCoordinator });
  return { continueRun, followups, repository, workspace };
}

afterEach(() => {
  for (const id of registry.ids()) if (id === claim.runId) registry.abort(id);
});

describe("a successor behind the previous answer's Workspace hand-off", () => {
  it("starts on the agent engine with its entry facts", async () => {
    const order: string[] = [];
    const memory = memoryNativeEngine();
    const { adapter, requests } = scriptedNativeAdapter([{ text: "Updated." }]);
    const { continueRun, followups } = continuation({ adapter, memory, order });
    const released = vi.fn();
    await continueRun({ claim, loaded: loadedFollowup({ native: { approvalId: "approval-1", telegram: true } }),
      releaseRegistry: released, signal: new AbortController().signal });
    await vi.waitFor(() => expect(memory.published()).toBe("Updated."));
    expect(followups.markAnswerDispatched).toHaveBeenCalledWith(claim);
    expect(released).toHaveBeenCalled();
    // The Allow it named and the Telegram turn it came from hold as if it had started at once.
    expect(memory.engine.approvedCall).toHaveBeenCalledWith(expect.objectContaining({ approvalId: "approval-1" }));
    const tools = (requests[0]?.tools ?? []).map((tool) => tool.name);
    expect(tools).toContain("read_secret");
    expect(tools).not.toContain("manage_secret");
    expect(order.slice(0, 2)).toEqual(["activated", "dispatched"]);
  });

  it("does its Workspace work only after the predecessor handed off, through the follow-up that waits for it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const order: string[] = [];
      const memory = memoryNativeEngine();
      const { adapter } = scriptedNativeAdapter([{ text: "Updated." }]);
      const { continueRun } = continuation({ adapter, memory, order });
      // The follow-up is claimable only once the predecessor is no longer active: its hand-off is done.
      let predecessorSettled = false;
      const coordinator = createWorkspaceFollowupCoordinator({ continueRun, fail: vi.fn(async () => undefined), registry,
        repository: {
          claim: vi.fn(async () => predecessorSettled && !order.includes("activated") ? claim : null),
          hasPending: vi.fn(async () => !order.includes("activated")),
          heartbeat: vi.fn(async () => true),
          load: vi.fn(async () => loadedFollowup()),
          markAnswerDispatched: vi.fn(async () => true),
          release: vi.fn(async () => undefined)
        } as never });
      coordinator.kick();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(order).toEqual([]);
      order.push("predecessor:handoff");
      predecessorSettled = true;
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(memory.published()).toBe("Updated."));
      expect(order.indexOf("predecessor:handoff")).toBeLessThan(order.indexOf("workspace:tools"));
      expect(order.indexOf("activated")).toBeLessThan(order.indexOf("workspace:tools"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends without starting the answer when Stop comes while it waits", async () => {
    const order: string[] = [];
    const memory = memoryNativeEngine();
    const { adapter, requests } = scriptedNativeAdapter([{ text: "Updated." }]);
    const { continueRun, followups } = continuation({ adapter, memory, order });
    const stop = new AbortController();
    stop.abort();
    await expect(continueRun({ claim, loaded: loadedFollowup(), releaseRegistry: vi.fn(), signal: stop.signal })).rejects.toBeDefined();
    expect(followups.markAnswerDispatched).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it("is never resumed once it was activated: it fails visibly for the user to send again", async () => {
    const order: string[] = [];
    const memory = memoryNativeEngine();
    const { adapter, requests } = scriptedNativeAdapter([{ text: "Updated." }]);
    const { continueRun } = continuation({ adapter, memory, order });
    await expect(continueRun({ claim, loaded: loadedFollowup({ status: "streaming" }), releaseRegistry: vi.fn(),
      signal: new AbortController().signal })).rejects.toEqual(new WorkspaceFollowupError("workspace_followup_invalid"));
    expect(requests).toEqual([]);
  });

  it("fails visibly, starting nothing, when the old core admitted it before the upgrade", async () => {
    const order: string[] = [];
    const memory = memoryNativeEngine();
    const { adapter, requests } = scriptedNativeAdapter([{ text: "Updated." }]);
    const { continueRun, repository } = continuation({ adapter, memory, order });
    await expect(continueRun({ claim, loaded: loadedFollowup({ engine: "v1" }), releaseRegistry: vi.fn(),
      signal: new AbortController().signal })).rejects.toEqual(new WorkspaceFollowupError("workspace_followup_unavailable"));
    expect(repository.continueWorkspacePreparedRun).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });
});
