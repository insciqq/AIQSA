import { describe, expect, it, vi } from "vitest";
import {
  admitPreparingRunWithClient,
  finalizeDispatchablePreparingRunAdmission,
  insertAcceptedWorkspaceRunBinding,
  settlePreparingRunInTransaction
} from "./prismaRepositoryPreparation";
import { RunAdmissionConflictError } from "./runRepositoryContract";
import { recordingTransaction, type RecordedCall } from "../chatSearch/index/markRecorder.testFixtures";
import { TEMPORARY_CHAT_RETENTION_MS } from "../chats/temporaryRetention";
import { workspaceRunOutputDirectory } from "@/lib/domain/workspace";

function input(chatMemoryMode: "NORMAL" | "EXCLUDED" | "TEMPORARY") {
  return {
    assistantMessageId: "assistant-message-1",
    chatMemoryMode,
    folderId: null,
    normalizedRequest: { privateMarker: "temporary-user-content" } as never,
    runId: "run-1",
    userMessageId: "user-message-1"
  };
}

describe("admission without Memory preparation", () => {
  it.each(["NORMAL", "EXCLUDED", "TEMPORARY"] as const)(
    "moves a %s chat's admission directly to streaming without a Memory attempt",
    async (chatMemoryMode) => {
      const update = vi.fn(async () => ({}));
      await expect(finalizeDispatchablePreparingRunAdmission({
        modelRun: { update }
      } as never, input(chatMemoryMode))).resolves.toEqual({
        assistantMessageId: "assistant-message-1",
        chatMemoryMode,
        folderId: null,
        runId: "run-1",
        userMessageId: "user-message-1"
      });
      expect(update).toHaveBeenCalledWith({
        data: {
          normalizedRequest: { privateMarker: "temporary-user-content" },
          status: "streaming"
        },
        where: { id: "run-1" }
      });
    }
  );

  it("keeps an answer to a scheduled task's prompt marked as one", async () => {
    const update = vi.fn(async () => ({}));
    await expect(finalizeDispatchablePreparingRunAdmission({ modelRun: { update } } as never,
      { ...input("EXCLUDED"), scheduledPrompt: true as const })).resolves.toMatchObject({ scheduledPrompt: true });
    expect(update).toHaveBeenCalledWith({
      data: { normalizedRequest: { privateMarker: "temporary-user-content" }, status: "streaming" },
      where: { id: "run-1" }
    });
  });
});

/** Model tables of the old Memory an admission or settlement must never touch any more (the chat mode enum stays). */
const OLD_MEMORY_MODELS = /^(memory\w*|userMemorySettings|modelRunMemoryBinding)\./u;
const OLD_MEMORY_SQL = /"(Memory(?!ChatMode")\w*|UserMemorySettings|ModelRunMemoryBinding)"|"memorySourceRevision"|"memoryBranchGeneration"/u;

function touchesOldMemory(call: RecordedCall): boolean {
  return OLD_MEMORY_MODELS.test(call.name) || Boolean(call.text && OLD_MEMORY_SQL.test(call.text));
}

type LockedChat = Readonly<{
  activeLeafMessageId: string | null;
  archived: boolean;
  folderId: string | null;
  memoryMode: "EXCLUDED" | "NORMAL" | "TEMPORARY";
  temporaryRetentionDeadline: Date | null;
}>;

/** A transaction for one admission of `chat-1`: the owner and the chat lock, the chat's messages and the new rows. */
function admissionTransaction(chat: LockedChat, messageCount: number, options: Readonly<{ scheduledTaskPrompt?: boolean }> = {}) {
  return recordingTransaction({
    $queryRaw: (call) => {
      const text = (call as RecordedCall).text ?? "";
      if (text.includes("FROM \"User\"")) return [{ id: "user-1" }];
      if (text.includes("FROM \"Chat\"") && text.includes("FOR UPDATE")) return [chat];
      if (text.includes("AS \"userContent\"")) {
        return [{ assistantParentId: "user-message-0", assistantRole: "assistant", scheduledTaskPrompt: options.scheduledTaskPrompt === true,
          userContent: { blocks: [{ text: "Again, please", type: "text" }] }, userRole: "user" }];
      }
      return [];
    },
    "chat.findFirst": () => ({ _count: { messages: messageCount }, id: "chat-1", title: "New Chat" }),
    "message.create": (args) => ({ id: (args as { data: { role: string } }).data.role === "user"
      ? "user-message-1" : "assistant-message-1" }),
    "modelRun.create": () => ({ createdAt: new Date("2026-11-22T10:00:00.000Z"), id: "run-1" })
  });
}

const content = { blocks: [{ text: "Hello", type: "text" }] };

function sendInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    admissionKind: "NORMAL_SEND", chatId: "chat-1", content, expectedActiveLeafId: null, modelId: "model-1",
    normalizedRequest: { attachmentIds: [], chatId: "chat-1", content, modelId: "model-1", params: {}, provider: "test" },
    provider: "test", providerRequestPreview: {}, userId: "user-1", ...overrides
  } as never;
}

function regenerateInput() {
  const question = { blocks: [{ text: "Again, please", type: "text" }] };
  return {
    admissionKind: "REGENERATE", chatId: "chat-1", modelId: "model-1",
    normalizedRequest: { attachmentIds: [], chatId: "chat-1", content: question, modelId: "model-1", params: {}, provider: "test" },
    preSendAssistantMessageId: "assistant-message-0", provider: "test", providerRequestPreview: {}, userId: "user-1",
    userMessageId: "user-message-0"
  } as never;
}

const normalChat: LockedChat = { activeLeafMessageId: null, archived: false, folderId: null, memoryMode: "NORMAL",
  temporaryRetentionDeadline: null };

describe("a send's admission writes its chat without the old Memory", () => {
  it("makes the new answer the chat's leaf with a plain write and touches no old Memory row", async () => {
    const recorder = admissionTransaction(normalChat, 0);

    await expect(admitPreparingRunWithClient(recorder.client as never, sendInput())).resolves.toMatchObject({
      assistantMessageId: "assistant-message-1", chatMemoryMode: "NORMAL", runId: "run-1", userMessageId: "user-message-1"
    });

    expect(recorder.calls.filter((call) => call.name === "chat.update").map((call) => call.args)).toContainEqual({
      data: { activeLeafMessageId: "assistant-message-1" }, select: { id: true }, where: { id: "chat-1" }
    });
    expect(recorder.calls.some(touchesOldMemory)).toBe(false);
    // The settlement marks the chat for past-chat search, not the admission.
    expect(recorder.marks()).toEqual([]);
  });

  it("switches an empty chat to Temporary with a day's deadline and clears it from past-chat search", async () => {
    const recorder = admissionTransaction(normalChat, 0);
    const before = Date.now();

    await expect(admitPreparingRunWithClient(recorder.client as never, sendInput({
      initialChatMode: { chatMode: "TEMPORARY", temporaryRetentionPolicyVersion: "temporary-24h-v1" }
    }))).resolves.toMatchObject({ chatMemoryMode: "TEMPORARY" });

    const conversion = recorder.calls.find((call) => call.name === "chat.update" &&
      (call.args as { data: { memoryMode?: string } }).data.memoryMode === "TEMPORARY");
    const data = (conversion?.args as { data: { temporaryRetentionDeadline: Date; temporaryRetentionPolicyVersion: string } }).data;
    expect(data.temporaryRetentionPolicyVersion).toBe("temporary-24h-v1");
    expect(data.temporaryRetentionDeadline.getTime()).toBeGreaterThanOrEqual(before + TEMPORARY_CHAT_RETENTION_MS);
    expect(recorder.marks()).toEqual([{ kind: "clear", values: ["chat-1"] }]);
    // The clear runs after the chat row is locked and switched, in the admission's own transaction.
    expect(recorder.indexOf((call) => call.text?.startsWith("DELETE FROM \"ChatSearchState\"") === true))
      .toBeGreaterThan(recorder.indexOf((call) => call === conversion));
    expect(recorder.calls.some(touchesOldMemory)).toBe(false);
  });

  it("moves a Temporary chat's deadline on and refuses one whose deadline passed", async () => {
    const live = admissionTransaction({ ...normalChat, memoryMode: "TEMPORARY",
      temporaryRetentionDeadline: new Date(Date.now() + 60_000) }, 2);
    await admitPreparingRunWithClient(live.client as never, sendInput());
    const moved = live.calls.find((call) => call.name === "chat.update" &&
      "temporaryRetentionDeadline" in (call.args as { data: object }).data);
    expect((moved?.args as { data: { temporaryRetentionDeadline: Date } }).data.temporaryRetentionDeadline.getTime())
      .toBeGreaterThan(Date.now() + TEMPORARY_CHAT_RETENTION_MS - 60_000);
    expect(live.marks()).toEqual([]);

    const expired = admissionTransaction({ ...normalChat, memoryMode: "TEMPORARY",
      temporaryRetentionDeadline: new Date(Date.now() - 1) }, 2);
    await expect(admitPreparingRunWithClient(expired.client as never, sendInput()))
      .rejects.toMatchObject({ code: "memory_temporary_chat_expired", name: "RunAdmissionConflictError" });
    expect(expired.calls.some((call) => call.name === "message.create")).toBe(false);
  });

  it("refuses a Temporary switch after the chat's first message", async () => {
    const recorder = admissionTransaction(normalChat, 2);
    await expect(admitPreparingRunWithClient(recorder.client as never, sendInput({
      initialChatMode: { chatMode: "TEMPORARY", temporaryRetentionPolicyVersion: "temporary-24h-v1" }
    }))).rejects.toBeInstanceOf(RunAdmissionConflictError);
  });

  it("makes a regenerated answer the leaf of its question's branch with a plain write", async () => {
    const recorder = admissionTransaction({ ...normalChat, activeLeafMessageId: "assistant-message-0" }, 2);

    await expect(admitPreparingRunWithClient(recorder.client as never, regenerateInput())).resolves.toMatchObject({
      assistantMessageId: "assistant-message-1", userMessageId: "user-message-0"
    });

    expect(recorder.calls.filter((call) => call.name === "chat.update").map((call) => call.args)).toContainEqual({
      data: { activeLeafMessageId: "assistant-message-1" }, select: { id: true }, where: { id: "chat-1" }
    });
    expect(recorder.calls.some(touchesOldMemory)).toBe(false);
    expect(recorder.marks()).toEqual([]);
  });

  it("refuses as stale a message prepared for another Memory mode than the locked chat's, sent or regenerated", async () => {
    // Prepared in a Normal chat (the note frozen into the request), excluded from another tab before the lock.
    const excluded = { ...normalChat, activeLeafMessageId: "assistant-message-0", memoryMode: "EXCLUDED" as const };
    const send = admissionTransaction({ ...excluded, activeLeafMessageId: null }, 2);
    await expect(admitPreparingRunWithClient(send.client as never, sendInput({ preparedChatMode: "NORMAL" })))
      .rejects.toMatchObject({ message: "active_leaf_changed", name: "ActiveLeafConflictError" });
    const regenerate = admissionTransaction(excluded, 2);
    await expect(admitPreparingRunWithClient(regenerate.client as never,
      { ...(regenerateInput() as object), preparedChatMode: "NORMAL" } as never))
      .rejects.toMatchObject({ name: "ActiveLeafConflictError" });
    // The mode it was prepared for, a first send's switch to Temporary included, is admitted.
    await expect(admitPreparingRunWithClient(admissionTransaction(excluded, 2).client as never,
      { ...(regenerateInput() as object), preparedChatMode: "EXCLUDED" } as never)).resolves.toMatchObject({ chatMemoryMode: "EXCLUDED" });
    await expect(admitPreparingRunWithClient(admissionTransaction(normalChat, 0).client as never, sendInput({ preparedChatMode: "TEMPORARY",
      initialChatMode: { chatMode: "TEMPORARY", temporaryRetentionPolicyVersion: "temporary-24h-v1" } })))
      .resolves.toMatchObject({ chatMemoryMode: "TEMPORARY" });
  });

  it("lets an answer to a scheduled task's prompt go on whatever its chat's mode became", async () => {
    const excluded = { ...normalChat, activeLeafMessageId: "assistant-message-0", memoryMode: "EXCLUDED" as const };
    const recorder = admissionTransaction(excluded, 2, { scheduledTaskPrompt: true });
    await expect(admitPreparingRunWithClient(recorder.client as never,
      { ...(regenerateInput() as object), preparedChatMode: "NORMAL" } as never))
      .resolves.toMatchObject({ chatMemoryMode: "EXCLUDED", scheduledPrompt: true });
  });
});

describe("settling a run still at its gate", () => {
  function gatedRun(gate: Readonly<{ pdf: boolean; workspace: boolean }>) {
    return recordingTransaction({
      $queryRaw: (call) => {
        const text = (call as RecordedCall).text ?? "";
        if (text.includes("FROM \"ModelRun\"") && text.includes("FOR UPDATE")) {
          return [{ assistantMessageId: "assistant-message-1", chatId: "chat-1", id: "run-1",
            pdfPreparationRequired: gate.pdf, status: "preparing", userId: "user-1",
            workspacePreparationRequired: gate.workspace }];
        }
        if (text.includes("AS \"memoryMode\"")) return [{ memoryMode: "NORMAL" }];
        return [];
      }
    });
  }
  const failure = { errorCode: "pdf_preparation_failed", message: "Failed", runId: "run-1", state: "FAILED", userId: "user-1" } as const;

  it("fails a PDF-gated run, its answer and marks its chat, with no old Memory attempt", async () => {
    const recorder = gatedRun({ pdf: true, workspace: false });

    await expect(settlePreparingRunInTransaction(recorder.tx, failure)).resolves.toBe(true);

    expect(recorder.calls.find((call) => call.name === "modelRun.update")?.args).toMatchObject({
      data: { errorPayload: { code: "pdf_preparation_failed" }, normalizedRequest: {}, status: "error" }, where: { id: "run-1" }
    });
    expect(recorder.marks()).toEqual([{ kind: "dirty", values: expect.arrayContaining(["chat-1", "user-1"]) }]);
    expect(recorder.calls.some(touchesOldMemory)).toBe(false);
  });

  it("leaves a run without a gate alone", async () => {
    const recorder = gatedRun({ pdf: false, workspace: false });

    await expect(settlePreparingRunInTransaction(recorder.tx, failure)).resolves.toBe(false);

    expect(recorder.calls.some((call) => call.name === "modelRun.update")).toBe(false);
  });
});
describe("Workspace switch write-back at admission", () => {
  const ids = { assistantMessageId: "assistant-message-1", runId: "run-1", userMessageId: "user-message-1" };
  const normalized = {
    enabled: true as const, imageRef: "fixture", inboxIndexPath: "/workspace/inbox/index.json", internetEnabled: true,
    maxToolCalls: 64, maxToolRounds: 16, mcpVersion: "fixture", messageManifestPath: "/workspace/inbox/messages/user-message-1/manifest.json",
    outputDirectory: workspaceRunOutputDirectory("run-1"), projectDirectory: "/workspace/project", runtimeVersion: "fixture",
    sessionId: "ws-1", syncToolTimeoutSeconds: 30, toolCatalogHash: "a".repeat(64), turnTimeoutSeconds: 300
  };
  const plan = {
    ...ids, chatId: "chat-1", expiresAt: new Date(Date.now() + 60_000).toISOString(), normalized, policyRevision: 3,
    sandboxName: "sandbox-1", sessionId: "ws-1",
    toolDefinitions: [{ description: "Run a command", namespacedName: "workspace_exec" }] as never[]
  };
  const scheduledOccurrence = {
    occurrenceId: "occurrence-1", previousResult: null, relevantMcpServerIds: null, taskGeneration: 1, taskId: "task-1", taskRevision: 1
  };

  /** A transaction that admits the session, binding and secrets, recording chat switch writes. */
  function transaction(existingSession: Readonly<Record<string, unknown>> | null = null) {
    const chatUpdates: unknown[] = [];
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: "user-1" }]),
      chat: {
        findUnique: vi.fn(async () => ({ userId: "user-1" })),
        findUniqueOrThrow: vi.fn(async () => ({ userId: "user-1" })),
        update: vi.fn(async (args: unknown) => { chatUpdates.push(args); return {}; })
      },
      modelRun: { count: vi.fn(async () => 0) },
      modelRunToolCall: { count: vi.fn(async () => 0) },
      user: { update: vi.fn(async () => ({ workspaceBrowserSequence: BigInt(1) })) },
      workspaceExecution: { count: vi.fn(async () => 0) },
      workspacePolicy: { findUnique: vi.fn(async () => ({ enabled: true, version: 3 })) },
      workspaceRunBinding: { count: vi.fn(async () => 0), create: vi.fn(async (_args: unknown) => ({})) },
      // The admitted run is attached to the session it claimed (`attachments.ts`).
      workspaceRunAttachment: { upsert: vi.fn(async (_args: unknown) => ({})) },
      workspaceSecret: { findMany: vi.fn(async () => []) },
      workspaceSession: {
        create: vi.fn(async () => ({})),
        findUnique: vi.fn(async () => existingSession),
        update: vi.fn(async (_args: unknown) => ({}))
      }
    };
    return { chatUpdates, tx };
  }

  function admission(input: Readonly<{ scheduled: boolean; workspace: boolean }>) {
    return {
      admissionKind: "NORMAL_SEND", chatId: "chat-1", userId: "user-1", workspaceEnabled: input.workspace,
      normalizedRequest: input.workspace ? { workspace: normalized } : {},
      ...(input.workspace ? { workspaceAdmissionPlan: plan } : {}),
      ...(input.scheduled ? { scheduledOccurrence } : {})
    } as never;
  }

  it("lets an ordinary send write its Workspace choice back to the chat's switch", async () => {
    for (const workspace of [true, false]) {
      const { chatUpdates, tx } = transaction();
      await insertAcceptedWorkspaceRunBinding(tx as never, admission({ scheduled: false, workspace }), ids);
      expect(chatUpdates).toEqual([{ data: { workspaceEnabled: workspace }, where: { id: "chat-1" } }]);
    }
  });

  it("never lets a scheduled run change an existing chat's Workspace switch, on or off", async () => {
    for (const workspace of [true, false]) {
      const { chatUpdates, tx } = transaction();
      await insertAcceptedWorkspaceRunBinding(tx as never, admission({ scheduled: true, workspace }), ids);
      expect(chatUpdates).toEqual([]);
      // The run itself still gets its Workspace binding.
      expect(tx.workspaceRunBinding.create).toHaveBeenCalledTimes(workspace ? 1 : 0);
    }
  });

  describe("session image", () => {
    const session = {
      id: "ws-1", imageRef: "older-fixture", internetEnabled: true, operationOwner: null,
      runtimeSandboxId: null, sandboxName: "sandbox-1", state: "PENDING"
    };

    it("lets a session without a guest disk adopt the admitted image with the run's claim", async () => {
      // A settled operation that never created a guest leaves READY or STOPPED without a disk too.
      for (const state of ["PENDING", "READY", "STOPPED"]) {
        const { tx } = transaction({ ...session, state });
        await insertAcceptedWorkspaceRunBinding(tx as never, admission({ scheduled: false, workspace: true }), ids);
        expect(tx.workspaceSession.update).toHaveBeenCalledExactlyOnceWith({
          data: { imageRef: "fixture", operationExpiresAt: null, operationOwner: expect.any(String), version: { increment: 1 } },
          where: { id: "ws-1" }
        });
        expect(tx.workspaceRunBinding.create).toHaveBeenCalledWith(expect.objectContaining({
          data: expect.objectContaining({ imageRef: "fixture", workspaceSessionId: "ws-1" })
        }));
      }
    });

    it("still refuses a busy or failed session without a guest disk", async () => {
      for (const busy of [{ state: "FAILED" }, { state: "DELETING" }, { state: "CREATING" }, { operationOwner: "run:other" }]) {
        const { tx } = transaction({ ...session, ...busy });
        await expect(insertAcceptedWorkspaceRunBinding(tx as never, admission({ scheduled: false, workspace: true }), ids))
          .rejects.toMatchObject({ code: "workspace_busy" });
        expect(tx.workspaceSession.update).not.toHaveBeenCalled();
      }
    });

    it("keeps a guest disk on the image it was created from", async () => {
      for (const disk of [
        { runtimeSandboxId: "runtime-1", state: "STOPPED" },
        { runtimeSandboxId: "runtime-1", state: "READY" },
        { runtimeSandboxId: "runtime-1", state: "PENDING" }
      ]) {
        const { tx } = transaction({ ...session, ...disk });
        await expect(insertAcceptedWorkspaceRunBinding(tx as never, admission({ scheduled: false, workspace: true }), ids))
          .rejects.toMatchObject({ code: "workspace_busy" });
        expect(tx.workspaceSession.update).not.toHaveBeenCalled();
        expect(tx.workspaceRunBinding.create).not.toHaveBeenCalled();
      }

      const { tx } = transaction({ ...session, imageRef: "fixture", runtimeSandboxId: "runtime-1", state: "STOPPED" });
      await insertAcceptedWorkspaceRunBinding(tx as never, admission({ scheduled: false, workspace: true }), ids);
      expect(tx.workspaceSession.update.mock.calls[0]?.[0]).toEqual({
        data: { operationExpiresAt: null, operationOwner: expect.any(String), version: { increment: 1 } },
        where: { id: "ws-1" }
      });
    });
  });
});
