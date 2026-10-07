import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, expect, it, vi } from "vitest";
import { textMessageContent } from "../../domain/content";
import { prisma } from "../prisma";
import { createPrismaProjectRepository } from "../projects/prismaRepository";
import type { ProviderAdmissionRole } from "../providerRuntime/admission";
import type { ProviderRunRequest } from "../providers/types";
import { ChatContinuationError, createChatContinuationService } from "./continuation";
import { cancelChatContinuation, continuationSourceHref, createChatContinuationRepository } from "./continuationRepository";
import { createChatContinuationHandler } from "./continuationHandlers";
import { createPrismaChatRepository } from "./prismaRepository";
import { scheduleTemporaryChatDeletion, temporaryRetentionDeadline } from "../memory/temporaryRetention";
import { MEMORY_TEMPORARY_RETENTION_POLICY_VERSION } from "../../contracts/memory";
import { getWorkspaceConfig } from "../workspace/config";
import { DeterministicWorkspaceRuntime } from "../workspace/deterministicRuntime";
import { createPrismaWorkspaceCoordinatorRepository } from "../workspace/coordinator";
import { WorkspaceRuntimeError } from "../workspace/runtime";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import { fenceDeterministicWorkspaceRuntime } from "../workspace/fencedRuntime";
import { runWorkspaceMaintenance } from "../workspace/cleanup";
import { failWorkspaceExportsForLostDisk } from "../workspace/sessionOperation";
import { createPrismaRetentionRepository } from "../retention/prune";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { createArtifactService } from "../artifacts/service";
import type { ArtifactOperation } from "../../contracts/artifacts";
import { CHAT_ASSISTANT_DELETED_MARKER } from "../../contracts/chats";

afterAll(() => prisma.$disconnect());

it.each([
  ["TRANSFERRED", false], ["TRANSFERRED", true],
  ["FAILED", false], ["FAILED", true]
] as const)("deletes both chats of a %s seed with its user (destination created first: %s)", async (status, destinationFirst) => {
  const userId = randomUUID();
  const sourceChatId = randomUUID();
  const newChatId = randomUUID();
  const seedId = randomUUID();
  const storageKey = status === "TRANSFERRED" ? `workspace-continuation/${seedId}.tar.gz` : null;
  await prisma.user.create({ data: { id: userId, displayName: "Continuation cascade fixture", status: "active" } });
  try {
    for (const id of destinationFirst ? [newChatId, sourceChatId] : [sourceChatId, newChatId]) {
      await prisma.chat.create({ data: { id, userId, title: "Continuation cascade fixture" } });
    }
    await prisma.chatContinuationWorkspaceSeed.create({ data: {
      id: seedId, sourceChatId, newChatId, status, storageKey,
      ...(storageKey ? { checksum: "a".repeat(64), byteSize: 1 } : {})
    } });
    await expect(prisma.user.delete({ where: { id: userId } })).resolves.toMatchObject({ id: userId });
    expect(await prisma.chat.count({ where: { id: { in: [sourceChatId, newChatId] } } })).toBe(0);
    expect(await prisma.chatContinuationWorkspaceSeed.count({ where: { id: seedId } })).toBe(0);
    if (storageKey) expect(await prisma.attachmentDeletionJob.count({ where: { storageKey } })).toBe(1);
  } finally {
    await prisma.chatContinuationWorkspaceSeed.deleteMany({ where: { id: seedId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    if (storageKey) await prisma.attachmentDeletionJob.deleteMany({ where: { storageKey } });
  }
});

async function fixture(
  run: (data: { userId: string; chatId: string; leafId: string; projectId: string | null }) => Promise<void>,
  mode: "NORMAL" | "TEMPORARY" | "PROJECT" = "NORMAL",
  // A test that asserts the seed cleanup its owner's deletion enqueues removes it itself.
  options: Readonly<{ retainSeedCleanup?: boolean }> = {}
) {
  const userId = randomUUID();
  const leafId = randomUUID();
  let projectId: string | null = null;
  await prisma.user.create({ data: { id: userId, displayName: "Summary test", status: "active" } });
  try {
    if (mode === "PROJECT") {
      const result = await createPrismaProjectRepository(prisma).create({ userId, actorDisplayName: "Summary test", name: "Summary project", description: "" });
      if (result.kind !== "ok") throw new Error(result.kind);
      projectId = result.value.id;
    }
    const deadline = mode === "TEMPORARY" ? temporaryRetentionDeadline(new Date()) : null;
    const chat = await prisma.$transaction(async (tx) => {
      const created = await tx.chat.create({ data: { title: "Summary source",
      ...(projectId ? { projectId, userId: null, memoryMode: "EXCLUDED", createdByUserId: userId, createdByDisplayName: "Summary test" }
        : { userId, memoryMode: mode === "TEMPORARY" ? "TEMPORARY" : "NORMAL" }),
      ...(deadline ? { temporaryRetentionDeadline: deadline, temporaryRetentionPolicyVersion: MEMORY_TEMPORARY_RETENTION_POLICY_VERSION } : {})
      } });
      if (deadline) await scheduleTemporaryChatDeletion(tx, { chatId: created.id, deadline, now: new Date(), userId });
      return created;
    });
    const first = await prisma.message.create({ data: { chatId: chat.id, role: "user", status: "complete", content: textMessageContent("Our goal: release a small feature."),
      ...(projectId ? { authorUserId: userId, authorDisplayName: "Summary test", authorProjectRole: "OWNER" } : {})
    } });
    await prisma.message.create({ data: { id: leafId, chatId: chat.id, parentMessageId: first.id, role: "assistant", status: "complete", content: textMessageContent("Decision: keep find_tools unchanged.") } });
    await prisma.message.create({ data: { chatId: chat.id, parentMessageId: first.id, role: "assistant", status: "complete", content: textMessageContent("SIBLING_PRIVATE_TEXT") } });
    await prisma.chat.update({ where: { id: chat.id }, data: { activeLeafMessageId: leafId } });
    await run({ userId, chatId: chat.id, leafId, projectId });
  } finally {
    // Seeds outlive a deleted source chat and their archives are keyed by seed,
    // not by user, so the cleanup jobs they leave are removed by exact key.
    const ownedChats = [{ userId }, ...(projectId ? [{ projectId }] : [])];
    const seeds = await prisma.chatContinuationWorkspaceSeed.findMany({ select: { id: true, storageKey: true }, where: {
      OR: [{ sourceChat: { OR: ownedChats } }, { newChat: { OR: ownedChats } }]
    } });
    await prisma.workspaceSession.deleteMany({ where: { chat: { OR: ownedChats } } });
    if (mode === "NORMAL") await prisma.chat.deleteMany({ where: { userId } });
    if (projectId) await prisma.project.deleteMany({ where: { id: projectId } });
    // Disposable fixtures obey the temporary deletion authority used by its normal lifecycle lane.
    if (mode === "TEMPORARY") {
      await prisma.$transaction(async (tx) => {
        await tx.memoryDeletionOutbox.updateMany({ where: { userId, operation: "TEMPORARY_DELETE" }, data: {
          state: "RUNNING", leaseToken: "summary-test-cleanup", leaseExpiresAt: new Date(Date.now() + 60000),
          completedAt: null, nextAttemptAt: null
        } });
        await tx.chat.deleteMany({ where: { userId } });
      });
      await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
    }
    await prisma.user.deleteMany({ where: { id: userId } });
    const seedKeys = options.retainSeedCleanup ? [] : seeds.flatMap((seed) =>
      [`workspace-continuation/${seed.id}.tar.gz`, ...(seed.storageKey ? [seed.storageKey] : [])]);
    if (!options.retainSeedCleanup) {
      await prisma.chatContinuationWorkspaceSeed.deleteMany({ where: { id: { in: seeds.map((seed) => seed.id) } } });
    }
    await prisma.attachmentDeletionJob.deleteMany({ where: { OR: [{ storageKey: { contains: userId } }, { storageKey: { in: seedKeys } }] } });
  }
}

function service(deps: Parameters<typeof createChatContinuationRepository>[1] = {}) {
  const repository = createChatContinuationRepository(prisma, deps);
  const execute = vi.fn<Parameters<typeof createChatContinuationService>[0]["execute"]>(async (_role, _request, options) => {
    await options.beforeDispatch?.();
    options.onUsage?.({ inputTokens: 50, outputTokens: 12, reasoningTokens: 0, totalTokens: 62 });
    return { summary: "## Goal\nRelease a small feature.\n## Decisions\nKeep find_tools unchanged." };
  });
  return { repository, execute, continueChat: createChatContinuationService({ repository, execute,
    resolveSystemModel: async () => ({ ok: true, credentialScope: "installation", policyVersion: 1,
      providerModelId: "summary-test-model", reasoningEffort: null,
      role: { modelConfiguration: { capabilities: { contextWindow: 32000, structuredOutput: true } },
        snapshot: { providerFamily: "fake", connection: { responseTimeoutMs: 300000 },
          model: { adapterKind: "fake", capabilities: { contextWindow: 32000, maxOutputTokens: 8192, structuredOutput: true },
            defaultParams: {}, upstreamModelId: "fake-summary" } } } as unknown as ProviderAdmissionRole })
  }) };
}

it.each([
  ["NORMAL", "exposed"], ["NORMAL", "unexposed"], ["NORMAL", "absent"],
  ["PROJECT", "exposed"], ["PROJECT", "unexposed"], ["PROJECT", "absent"]
] as const)("preserves model and Knowledge defaults for %s continuation with %s selection", async (mode, selectionState) => {
  const template = await prisma.providerModel.findUniqueOrThrow({ where: { id: providerTemplateIds.fakeModel } });
  const modelIds = [randomUUID()];
  try {
    for (const id of modelIds) await prisma.providerModel.create({ data: {
      id, connectionId: template.connectionId, provider: template.provider, modelId: `summary-${id}`,
      displayName: "Continuation model", activeVersion: template.activeVersion, activatedAt: template.activatedAt,
      activeConfig: template.activeConfig as Prisma.InputJsonValue,
      capabilities: template.capabilities as Prisma.InputJsonValue,
      defaultParams: template.defaultParams as Prisma.InputJsonValue
    } });
    const original = modelIds[0]!;
    const selected = template.id;
    await fixture(async ({ userId, chatId, leafId, projectId }) => {
      const knowledge = { version: 1, mode: "explicit", baseIds: [randomUUID()], sourceIds: [] };
      await prisma.chat.update({ where: { id: chatId }, data: { defaultProviderModelId: original, defaultKnowledgePlan: knowledge } });
      if (projectId) {
        await prisma.projectModelBinding.deleteMany({ where: { projectId } });
        await prisma.projectModelBinding.create({ data: { projectId, providerModelId: original } });
      }
      // A personal grant must never grant access to an unbound Project model.
      if (mode === "PROJECT" || selectionState === "exposed") {
        await prisma.accessGrant.create({ data: { userId, providerModelId: selected } });
      }
      if (projectId && selectionState === "exposed") {
        await prisma.projectModelBinding.create({ data: { projectId, providerModelId: selected } });
      }
      const f = service();
      const input = { userId, chatId, expectedLeafMessageId: leafId, requestId: randomUUID(),
        ...(selectionState === "absent" ? {} : { modelSelection: { provider: template.connectionId, modelId: selected } }) };
      const source = await f.repository.loadSource(input);
      const first = await f.repository.claim(source, input.requestId, input.modelSelection);
      if (first.kind !== "claimed") throw new Error("claim missing");
      expect(await f.repository.claim(source, input.requestId, { provider: "changed", modelId: original })).toEqual({ kind: "result", result: { status: "running", progress: { completedParts: 0, stage: "preparing" } } });
      expect(await prisma.chatContinuation.findUnique({ where: { id: first.claim.id } })).toMatchObject({
        requestedProviderModelId: selectionState === "exposed" ? selected : null
      });
      const result = await f.repository.complete(source, first.claim, "Conversation summary");
      if (result.status !== "complete") throw new Error("summary missing");
      expect(await prisma.chat.findUnique({ where: { id: result.chatId } })).toMatchObject({
        defaultProviderModelId: selectionState === "exposed" ? selected : original,
        defaultKnowledgePlan: knowledge, workspaceEnabled: false, projectId,
        memoryMode: mode === "PROJECT" ? "EXCLUDED" : "NORMAL"
      });
      expect(await prisma.workspaceSession.count({ where: { chatId: result.chatId } })).toBe(0);
      const reopened = await createPrismaChatRepository(prisma).getChat({ chatId: result.chatId, userId });
      expect(reopened?.defaultModelId).toBe(selectionState === "exposed" ? selected : original);
      expect(await f.continueChat({ ...input, modelSelection: { provider: "changed", modelId: original } })).toEqual(result);
      expect(f.execute).not.toHaveBeenCalled();
    }, mode);
  } finally {
    await prisma.providerModel.deleteMany({ where: { id: { in: modelIds } } });
  }
});

async function workspaceSource(chatId: string) {
  const config = getWorkspaceConfig({ AIQSA_TEST_MODE: "1", AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1", NODE_ENV: "test" });
  const runtime = new DeterministicWorkspaceRuntime(config);
  const storage = createMemoryStorageAdapter();
  await prisma.chat.update({ where: { id: chatId }, data: { workspaceEnabled: true } });
  const sessionId = `ws_${randomUUID().replaceAll("-", "").padEnd(40, "0")}`;
  const sandboxName = `aiqsa-ws-${sessionId}`;
  const disk = await runtime.ensureSession({ ...config, sessionId, sandboxName, runtimeSandboxId: null, internetEnabled: false });
  const session = await prisma.workspaceSession.create({ data: { id: sessionId, chatId, sandboxName,
    imageRef: config.imageRef, internetEnabled: false, policyRevision: 1, runtimeSandboxId: disk.runtimeSandboxId,
    state: "STOPPED", stoppedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) } });
  await runtime.callBoundTool({ sessionId, runtimeSandboxId: disk.runtimeSandboxId, modelRunId: "fixture", modelRunToolCallId: "write",
    originalName: "sandbox_fs_write", arguments: { path: "/workspace/project/persisted.txt", content: "private file bytes" } });
  return { runtime: fenceDeterministicWorkspaceRuntime(runtime), storage, session, config };
}

it("releases a cancellation before capture and ignores a late failure from an older attempt", () => fixture(async ({ chatId, userId, leafId }) => {
  const w = await workspaceSource(chatId);
  const f = service(w);
  const source = await f.repository.loadSource({ chatId, userId, expectedLeafMessageId: leafId, requestId: randomUUID() });
  const first = await f.repository.claim(source, randomUUID());
  if (first.kind !== "claimed") throw new Error("claim missing");
  await f.repository.fail(first.claim, "chat_summary_cancelled");
  expect(await prisma.workspaceSession.findUnique({ where: { id: w.session.id } })).toMatchObject({ operationOwner: null });
  const next = await f.repository.claim(source, randomUUID());
  if (next.kind !== "claimed") throw new Error("claim missing");
  await f.repository.fail(first.claim, "chat_summary_failed");
  await expect(f.repository.captureWorkspace!(source, first.claim)).rejects.toMatchObject({ code: "chat_changed" });
  expect(await prisma.chatContinuationWorkspaceSeed.findUnique({ where: { continuationId: next.claim.id } })).toMatchObject({ status: "CAPTURING" });
  await f.repository.fail(next.claim, "chat_summary_cancelled");
}));

it("cleans an archive when a process dies between capture and destination creation", () => fixture(async ({ chatId, userId, leafId }) => {
  const w = await workspaceSource(chatId);
  const f = service(w);
  const source = await f.repository.loadSource({ chatId, userId, expectedLeafMessageId: leafId, requestId: randomUUID() });
  const claim = await f.repository.claim(source, randomUUID());
  if (claim.kind !== "claimed") throw new Error("claim missing");
  await f.repository.captureWorkspace!(source, claim.claim);
  const seed = await prisma.chatContinuationWorkspaceSeed.findUniqueOrThrow({ where: { continuationId: claim.claim.id } });
  expect(seed.status).toBe("READY");
  const stale = new Date(Date.now() - 240_000);
  await prisma.chatContinuation.update({ where: { id: claim.claim.id }, data: { updatedAt: stale, leaseExpiresAt: stale } });
  await prisma.chatContinuationWorkspaceSeed.update({ where: { id: seed.id }, data: { updatedAt: stale } });
  await runWorkspaceMaintenance({ config: w.config, prisma, runtime: w.runtime });
  expect(await prisma.chatContinuationWorkspaceSeed.findUnique({ where: { id: seed.id } })).toMatchObject({ status: "ABANDONED" });
  expect(await prisma.chatContinuation.findUnique({ where: { id: claim.claim.id } })).toMatchObject({ status: "failed" });
  expect(await prisma.attachmentDeletionJob.count({ where: { storageKey: seed.storageKey! } })).toBe(1);
  await prisma.chatContinuationWorkspaceSeed.update({ where: { id: seed.id }, data: { storageKey: null, checksum: null, byteSize: null } });
  await prisma.attachmentDeletionJob.deleteMany({ where: { storageKey: seed.storageKey! } });
}));

it("retries an interrupted restore, fences stale completion and never replays a settled seed", () => fixture(async ({ chatId, userId, leafId }) => {
  const w = await workspaceSource(chatId);
  const result = await service(w).continueChat({ chatId, userId, expectedLeafMessageId: leafId, requestId: randomUUID() });
  if (result.status !== "complete") throw new Error("summary missing");
  const session = await prisma.workspaceSession.create({ data: {
    chatId: result.chatId, sandboxName: `aiqsa-ws-${randomUUID()}`, imageRef: w.session.imageRef, internetEnabled: false,
    policyRevision: 1, expiresAt: new Date(Date.now() + 3_600_000), operationOwner: "run:destination", version: 1
  } });
  const repository = createPrismaWorkspaceCoordinatorRepository(prisma);
  const input = { chatId: result.chatId, sessionId: session.id, operation: { owner: "run:destination", generation: 1 } };
  const first = await repository.claimContinuationSeed!(input);
  expect(first).not.toBeNull();
  await expect(repository.claimContinuationSeed!(input)).rejects.toMatchObject({ code: "workspace_archive_restore_failed" });
  await prisma.chatContinuationWorkspaceSeed.update({ where: { id: first!.id }, data: { leaseExpiresAt: new Date(Date.now() - 1) } });
  const retry = await repository.claimContinuationSeed!(input);
  expect(retry?.token).not.toBe(first!.token);
  expect(await repository.settleContinuationSeed!({ id: first!.id, token: first!.token, status: "RESTORED" })).toBe(false);
  expect(await repository.settleContinuationSeed!({ id: retry!.id, token: retry!.token, status: "RESTORED" })).toBe(true);
  expect(await repository.claimContinuationSeed!(input)).toBeNull();
  await prisma.$transaction((tx) => failWorkspaceExportsForLostDisk(tx, session.id));
  expect(await prisma.chatContinuationWorkspaceSeed.findUnique({ where: { id: retry!.id } })).toMatchObject({
    status: "ABANDONED", failureCode: "workspace_restored_disk_lost"
  });
  expect(await repository.claimContinuationSeed!(input)).toBeNull();
}));

it.each(["workspace_runtime_unavailable", "workspace_archive_limit_exceeded", "workspace_archive_invalid"] as const)(
  "continues after %s and never tries to restore a failed capture", (code) => fixture(async ({ chatId, userId, leafId }) => {
    const w = await workspaceSource(chatId);
    vi.spyOn(w.runtime, "createProjectArchive").mockRejectedValueOnce(new WorkspaceRuntimeError(code));
    const result = await service(w).continueChat({ chatId, userId, expectedLeafMessageId: leafId, requestId: randomUUID() });
    if (result.status !== "complete") throw new Error("summary missing");
    const seed = await prisma.chatContinuationWorkspaceSeed.findUniqueOrThrow({ where: { newChatId: result.chatId } });
    expect(seed).toMatchObject({ status: "FAILED", failureCode: code, storageKey: null });
    expect(await prisma.workspaceSession.findUnique({ where: { id: w.session.id } })).toMatchObject({ operationOwner: null });
    const destination = await prisma.workspaceSession.create({ data: {
      chatId: result.chatId, sandboxName: `aiqsa-ws-${randomUUID()}`, imageRef: w.session.imageRef, internetEnabled: false,
      policyRevision: 1, expiresAt: new Date(Date.now() + 3_600_000), operationOwner: "run:destination", version: 1
    } });
    await expect(createPrismaWorkspaceCoordinatorRepository(prisma).claimContinuationSeed!({
      chatId: result.chatId, sessionId: destination.id, operation: { owner: "run:destination", generation: 1 }
    })).resolves.toBeNull();
  })
);

it("captures once, transfers ownership, and preserves the seed when its source is deleted", () => fixture(async ({ chatId, userId, leafId }) => {
  const w = await workspaceSource(chatId);
  const capture = vi.spyOn(w.runtime, "createProjectArchive");
  const f = service(w);
  const request = { chatId, userId, expectedLeafMessageId: leafId, requestId: randomUUID() };
  const result = await f.continueChat(request);
  if (result.status !== "complete") throw new Error("summary missing");
  expect(await f.continueChat(request)).toEqual(result);
  expect(capture).toHaveBeenCalledOnce();
  // The seed is captured only after the runtime proves it restorable.
  expect(capture).toHaveBeenCalledWith(expect.objectContaining({ restorable: true }));
  const seed = await prisma.chatContinuationWorkspaceSeed.findUniqueOrThrow({ where: { newChatId: result.chatId } });
  expect(seed).toMatchObject({ status: "TRANSFERRED", checksum: expect.any(String), byteSize: expect.any(Number) });
  expect(w.storage.objects.has(seed.storageKey!)).toBe(true);
  const retention = createPrismaRetentionRepository(prisma);
  const prematureDeletion = await prisma.attachmentDeletionJob.create({ data: { storageKey: seed.storageKey!, createdAt: new Date(0) } });
  expect(await retention.findClaimableAttachmentDeletionJobIds({ claimableBefore: new Date(), limit: 1000 })).not.toContain(prematureDeletion.id);
  await prisma.attachmentDeletionJob.delete({ where: { id: prematureDeletion.id } });
  expect(f.execute.mock.calls[0]![1].userPrompt).not.toContain("private file bytes");
  expect(await prisma.attachment.count({ where: { storageKey: seed.storageKey! } })).toBe(0);
  await prisma.workspaceSession.delete({ where: { id: w.session.id } });
  await prisma.chat.delete({ where: { id: chatId } });
  expect(await prisma.chatContinuationWorkspaceSeed.findUnique({ where: { id: seed.id } })).toMatchObject({ sourceChatId: null, newChatId: result.chatId, status: "TRANSFERRED" });
  expect(await prisma.attachmentDeletionJob.count({ where: { storageKey: seed.storageKey! } })).toBe(0);
  await prisma.chat.delete({ where: { id: result.chatId } });
  expect(await prisma.chatContinuationWorkspaceSeed.findUnique({ where: { id: seed.id } })).toBeNull();
  expect(await prisma.attachmentDeletionJob.count({ where: { storageKey: seed.storageKey! } })).toBe(1);
  const deletion = await prisma.attachmentDeletionJob.update({ where: { storageKey: seed.storageKey! }, data: { createdAt: new Date(0) } });
  expect(await retention.findClaimableAttachmentDeletionJobIds({ claimableBefore: new Date(), limit: 1000 })).toContain(deletion.id);
  await prisma.attachmentDeletionJob.deleteMany({ where: { storageKey: seed.storageKey! } });
}));

it.each(["PROJECT", "TEMPORARY"] as const)("cleans a transferred seed with its %s owner", async (mode) => {
  let captured: { id: string; storageKey: string | null } | null = null;
  await fixture(async ({ chatId, userId, leafId, projectId }) => {
    const result = await service(await workspaceSource(chatId)).continueChat({ chatId, userId, expectedLeafMessageId: leafId, requestId: randomUUID() });
    if (result.status !== "complete") throw new Error("summary missing");
    expect(await prisma.chat.findUnique({ where: { id: result.chatId } })).toMatchObject({
      projectId, workspaceEnabled: true, memoryMode: mode === "TEMPORARY" ? "TEMPORARY" : "EXCLUDED"
    });
    captured = await prisma.chatContinuationWorkspaceSeed.findUniqueOrThrow({ where: { newChatId: result.chatId }, select: { id: true, storageKey: true } });
  }, mode, { retainSeedCleanup: true });
  expect(captured).not.toBeNull();
  const seed = captured as unknown as { id: string; storageKey: string };
  expect(await prisma.chatContinuationWorkspaceSeed.findUnique({ where: { id: seed.id } })).toBeNull();
  expect(await prisma.attachmentDeletionJob.count({ where: { storageKey: seed.storageKey } })).toBe(1);
  await prisma.attachmentDeletionJob.deleteMany({ where: { storageKey: seed.storageKey } });
});

it.each(["bound", "deleted"] as const)("continues a chat with its Assistant and changed rows, never a deleted Assistant's marker (%s)", (state) => fixture(async ({ userId, chatId, leafId }) => {
  const assistant = await prisma.assistantDefinition.create({ data: {
    avatar: { accents: [0, 4], backgroundShape: "circle", foregroundShape: "diamond", kind: "generated",
      paletteId: "ocean", recipeVersion: 1, rotations: [0, 2] },
    name: "Continued Assistant", ownerUserId: userId, providerModelId: providerTemplateIds.fakeModel,
    searchPlan: { mode: "off" }, systemPrompt: "Answer directly.", toolsPolicy: "adjustable"
  } });
  try {
    const overrides = { tools: { mode: "load_all" } };
    await prisma.chat.update({ where: { id: chatId }, data: state === "bound"
      ? { assistantId: assistant.id, assistantOverrides: overrides }
      : { assistantId: null, assistantOverrides: CHAT_ASSISTANT_DELETED_MARKER } });
    const f = service();
    const input = { userId, chatId, expectedLeafMessageId: leafId, requestId: randomUUID() };
    const source = await f.repository.loadSource(input);
    const claimed = await f.repository.claim(source, input.requestId);
    if (claimed.kind !== "claimed") throw new Error("claim missing");
    const result = await f.repository.complete(source, claimed.claim, "Conversation summary");
    if (result.status !== "complete") throw new Error("summary missing");
    await expect(prisma.chat.findUniqueOrThrow({
      select: { assistantId: true, assistantOverrides: true }, where: { id: result.chatId }
    })).resolves.toEqual(state === "bound"
      ? { assistantId: assistant.id, assistantOverrides: overrides }
      : { assistantId: null, assistantOverrides: null });
    await expect(createPrismaChatRepository(prisma).getChat({ chatId: result.chatId, userId }))
      .resolves.toMatchObject({ assistantId: state === "bound" ? assistant.id : null });
  } finally {
    // The foreign key detaches the chats; the fixture removes them.
    await prisma.assistantDefinition.deleteMany({ where: { id: assistant.id } });
  }
}));

it("serves one visible summary from the active branch, preserving source, scope, usage and authorized source navigation", () => fixture(async ({ userId, chatId, leafId }) => {
  const before = await prisma.chat.findUniqueOrThrow({ where: { id: chatId } });
  const f = service();
  const complete = vi.spyOn(f.repository, "complete");
  const usage = vi.spyOn(f.repository, "recordUsage");
  const handler = createChatContinuationHandler({ continueChat: f.continueChat,
    resolveAuth: async () => ({ id: "session", userId, expiresAt: new Date(Date.now() + 60000),
      user: { id: userId, displayName: "Summary test", email: null, role: "user", status: "active" } }) });
  const input = { expectedLeafMessageId: leafId, requestId: randomUUID() };
  const request = () => handler(new Request(`http://localhost/api/chats/${chatId}/continue`, {
    method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" }
  }), { params: Promise.resolve({ chatId }) });
  const response = await request();
  const failure = [...complete.mock.settledResults, ...usage.mock.settledResults].find((result) => result.type === "rejected");
  if (failure?.type === "rejected") throw failure.value;
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.status).toBe("complete");
  expect((await (await request()).json()).chatId).toBe(result.chatId);
  expect(f.execute).toHaveBeenCalledOnce();
  expect(f.execute.mock.calls[0]?.[1].userPrompt).not.toContain("SIBLING_PRIVATE_TEXT");
  const detail = await createPrismaChatRepository(prisma).getChat({ chatId: result.chatId, userId });
  expect(detail?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  expect(detail?.messages[1]?.content).toEqual(textMessageContent("Conversation summary\n\n## Goal\nRelease a small feature.\n## Decisions\nKeep find_tools unchanged."));
  expect(detail?.hasContinuationSource).toBe(true);
  const child = await prisma.chat.findUniqueOrThrow({ where: { id: result.chatId } });
  expect(child).toMatchObject({ userId, projectId: null, memoryMode: "NORMAL", workspaceEnabled: false });
  expect(await prisma.chat.findUnique({ where: { id: chatId } })).toEqual(before);
  expect(await continuationSourceHref(prisma, result.chatId, userId)).toBe(`/c/${chatId}`);
  expect(await continuationSourceHref(prisma, result.chatId, randomUUID())).toBeNull();
  expect(await prisma.usageEvent.findMany({ where: { chatId } })).toEqual([
    expect.objectContaining({ userId, purpose: "chat_summary", inputTokens: 50, outputTokens: 12, reasoningTokens: 0, totalTokens: 62,
      modelId: "summary-test-model", estimatedCostMicros: null })
  ]);
}));

it("carries exact artifact context into a summarized chat and keeps it after source deletion", () => fixture(async ({ userId, chatId, leafId }) => {
  const storage = createMemoryStorageAdapter();
  const artifacts = createArtifactService(prisma, storage);
  const operation = { intent: "create", kind: "slides", title: "Release deck", entrypoint: "index.html",
    files: [{ path: "index.html", mimeType: "text/html", text: "<main><h1>Release</h1><img src=\"picture.png\"></main>" }] } satisfies ArtifactOperation;
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4n8AAAAASUVORK5CYII=", "base64");
  const image = await prisma.attachment.create({ data: { userId, chatId, status: "ready", kind: "image",
    fileName: "private-image.png", mimeType: "image/png", byteSize: bytes.length, storageKey: `continuation-test/${userId}/image.png`, metadata: {} } });
  await storage.putObject({ body: bytes, contentType: "image/png", storageKey: image.storageKey });
  const withImage: ArtifactOperation = { ...operation, files: [...operation.files, { path: "picture.png", mimeType: "image/png", assetRef: image.id }] };
  const version = await artifacts.createVersion({ ownerUserId: userId, sourceChatId: chatId, operation: withImage });
  const publication = await artifacts.publish({ artifactId: version!.artifactId, versionId: version!.id, ownerUserId: userId });
  const originalPublic = await artifacts.publicBundle(publication.shareToken);
  expect(originalPublic?.body.toString()).toContain(`data:image/png;base64,${bytes.toString("base64")}`);
  const f = service();
  const result = await f.continueChat({ chatId, userId, expectedLeafMessageId: leafId, requestId: randomUUID() });
  if (result.status !== "complete") throw new Error("summary missing");

  expect(await prisma.artifactChatBinding.findMany({ where: { artifactId: version!.artifactId }, select: { chatId: true, versionId: true } }))
    .toEqual(expect.arrayContaining([{ chatId, versionId: version!.id }, { chatId: result.chatId, versionId: version!.id }]));
  const compactContext = await artifacts.contextForChat({ ownerUserId: userId, chatId: result.chatId, maxInlineSourceBytes: 0 });
  expect(compactContext).toEqual([expect.objectContaining({
    artifact_id: version!.artifactId, base_version_id: version!.id, title: "Release deck", version_number: 1
  })]);
  expect(compactContext[0]!.files).toEqual([
    { path: "index.html", mimeType: "text/html", bytes: Buffer.byteLength(operation.files[0]!.text) },
    expect.objectContaining({ path: "picture.png", mimeType: "image/png", bytes: bytes.length, binary: true })
  ]);
  expect(compactContext[0]!.files.every(file => file.text === undefined)).toBe(true);

  const readRequest: ProviderRunRequest = {
    artifactTool: true, artifactReferences: [{ artifactId: version!.artifactId, versionId: version!.id }],
    attachmentIds: [], attachments: [], chatId: result.chatId,
    content: textMessageContent("Read the accepted release deck."),
    knowledgePlan: { version: 1, mode: "none", baseIds: [], sourceIds: [] },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, toolCalling: true, vision: false },
    modelId: "continuation-artifact-read", provider: "fake", params: {},
    prompt: { system: null, developer: null }, searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto"
  };
  const readAcceptedVersion = () => artifacts.execute({ id: "read-deck", name: "read_artifact",
    arguments: { artifact_id: version!.artifactId } }, { userId, runId: "continuation-read-run", request: readRequest });

  await prisma.chat.delete({ where: { id: chatId } });
  await prisma.attachment.deleteMany({ where: { id: image.id } });
  await storage.deleteObject(image.storageKey);
  expect(await artifacts.contextForChat({ ownerUserId: userId, chatId: result.chatId })).toEqual([expect.objectContaining({
    artifact_id: version!.artifactId, base_version_id: version!.id
  })]);
  const originalRead = await readAcceptedVersion();
  expect(originalRead).toMatchObject({ status: "complete", content: [{ type: "json", value: {
    artifact_id: version!.artifactId, version_id: version!.id, truncated: false, files: [
      { path: "index.html", mimeType: "text/html", offset: 0, bytes: Buffer.byteLength(operation.files[0]!.text), text: operation.files[0]!.text },
      { path: "picture.png", mimeType: "image/png", offset: 0, bytes: bytes.length, binary: true }
    ]
  } }] });
  const next = await artifacts.createVersion({ ownerUserId: userId, sourceChatId: result.chatId, allowedAssetRefs: [],
    operation: { intent: "update", baseVersionId: version!.id, title: "Updated release deck",
      edits: [{ path: "index.html", old_string: "<h1>Release</h1>", new_string: "<h1>Ready</h1>" }] } });
  expect(next).toMatchObject({ artifactId: version!.artifactId, versionNumber: 2 });
  const updatedBundle = await artifacts.getPrivateBundle({ ownerUserId: userId, artifactId: version!.artifactId, versionId: next!.id });
  expect(updatedBundle?.body.toString()).toContain("<h1>Ready</h1>");
  expect(updatedBundle?.body.toString()).toContain(`data:image/png;base64,${bytes.toString("base64")}`);
  expect(await readAcceptedVersion()).toEqual(originalRead);
  const continued = await prisma.chat.findUniqueOrThrow({ where: { id: result.chatId } });
  const twice = await f.continueChat({ userId, chatId: continued.id, expectedLeafMessageId: continued.activeLeafMessageId!, requestId: randomUUID() });
  if (twice.status !== "complete") throw new Error("second summary missing");
  expect(await artifacts.contextForChat({ ownerUserId: userId, chatId: twice.chatId })).toEqual([expect.objectContaining({
    artifact_id: version!.artifactId, base_version_id: next!.id, title: "Updated release deck", version_number: 2
  })]);
  expect(await artifacts.contextForChat({ ownerUserId: randomUUID(), chatId: twice.chatId })).toEqual([]);
  expect((await artifacts.publicBundle(publication.shareToken))?.body).toEqual(originalPublic?.body);
  await artifacts.archive({ artifactId: version!.artifactId, ownerUserId: userId });
}));

it("serializes concurrent claims and rejects other owners, active runs, source changes and cancelled operations", () => fixture(async ({ userId, chatId, leafId }) => {
  const f = service();
  const input = { userId, chatId, expectedLeafMessageId: leafId, requestId: randomUUID() };
  const source = await f.repository.loadSource(input);
  const claims = await Promise.all([f.repository.claim(source, input.requestId), f.repository.claim(source, randomUUID())]);
  expect(claims.map((claim) => claim.kind).sort()).toEqual(["claimed", "result"]);
  await expect(f.repository.loadSource({ ...input, userId: randomUUID() })).rejects.toMatchObject({ code: "chat_not_found" });
  const claimed = claims.find((claim) => claim.kind === "claimed");
  if (claimed?.kind !== "claimed") throw new Error("claim missing");
  await prisma.chat.update({ where: { id: chatId }, data: { title: "Changed while summarizing" } });
  await expect(f.repository.complete(source, claimed.claim, "summary")).rejects.toMatchObject({ code: "chat_changed" });
  await f.repository.fail(claimed.claim, "chat_changed");
  const controller = new AbortController();
  f.execute.mockImplementation(async () => { controller.abort(); return { summary: "summary" }; });
  await expect(f.continueChat({ ...input, requestId: randomUUID(), signal: controller.signal })).rejects.toMatchObject({ code: "chat_summary_cancelled" });
  expect(await prisma.chat.count({ where: { userId } })).toBe(1);
  const root = await prisma.message.findFirstOrThrow({ where: { chatId, role: "user" } });
  const run = await prisma.modelRun.create({ data: { chatId, userId, userMessageId: root.id,
    assistantMessageId: leafId, modelId: "fake-summary", provider: "fake", status: "queued", normalizedRequest: {} } });
  await expect(f.repository.loadSource(input)).rejects.toMatchObject({ code: "chat_busy" });
  await prisma.modelRun.delete({ where: { id: run.id } });
}));

it("never replays a stopped attempt automatically and preserves deleted-child tombstones", () => fixture(async ({ userId, chatId, leafId }) => {
  const f = service();
  const input = { userId, chatId, expectedLeafMessageId: leafId, requestId: randomUUID() };
  const source = await f.repository.loadSource(input);
  const claimed = await f.repository.claim(source, input.requestId);
  if (claimed.kind !== "claimed") throw new Error("claim missing");
  await prisma.chatContinuation.update({ where: { id: claimed.claim.id }, data: { updatedAt: new Date(Date.now() - 240000), leaseExpiresAt: new Date(Date.now() - 60000) } });
  await expect(f.repository.claim(source, input.requestId)).rejects.toMatchObject({ code: "chat_summary_failed" });
  expect((await prisma.chatContinuation.findUnique({ where: { id: claimed.claim.id } }))?.status).toBe("failed");
  await expect(f.continueChat(input)).rejects.toMatchObject({ code: "chat_summary_failed" });
  expect(f.execute).not.toHaveBeenCalled();
  const result = await f.continueChat({ ...input, requestId: randomUUID() });
  if (result.status !== "complete") throw new Error("summary missing");
  await prisma.chat.delete({ where: { id: result.chatId } });
  await expect(f.continueChat({ ...input, requestId: randomUUID() })).rejects.toMatchObject({ code: "chat_not_found" });
  expect(f.execute).toHaveBeenCalledOnce();
}));

async function lapseLease(continuationId: string) {
  // A dead worker renews nothing; age its liveness lease past expiry.
  const stale = new Date(Date.now() - 240_000);
  await prisma.chatContinuation.update({ where: { id: continuationId }, data: { updatedAt: stale, leaseExpiresAt: new Date(Date.now() - 60_000) } });
}

it.each([
  ["NORMAL", "none", true], ["PROJECT", "none", false],
  ["NORMAL", "no_source_disk", false], ["PROJECT", "no_source_disk", true]
] as const)("settles a cancelled %s attempt (Workspace seed: %s) after its worker dies; old poll first: %s", (mode, seedMode, pollFirst) => fixture(async ({ userId, chatId, leafId }) => {
  if (seedMode === "no_source_disk") await prisma.chat.update({ where: { id: chatId }, data: { workspaceEnabled: true } });
  const f = service();
  const input = { userId, chatId, expectedLeafMessageId: leafId, requestId: randomUUID() };
  const source = await f.repository.loadSource(input);
  const first = await f.repository.claim(source, input.requestId);
  if (first.kind !== "claimed") throw new Error("claim missing");
  const firstSeed = seedMode === "no_source_disk"
    ? await prisma.chatContinuationWorkspaceSeed.findUniqueOrThrow({ where: { continuationId: first.claim.id } }) : null;
  expect(firstSeed?.status ?? null).toBe(seedMode === "no_source_disk" ? "NO_SOURCE_DISK" : null);
  await cancelChatContinuation(prisma, input);
  // While the worker's lease is live it settles its own cancellation.
  await expect(f.repository.claim(source, randomUUID())).rejects.toMatchObject({ code: "chat_summary_cancelled" });
  expect(await prisma.chatContinuation.findUniqueOrThrow({ where: { id: first.claim.id } })).toMatchObject({ status: "running" });
  await lapseLease(first.claim.id);
  if (pollFirst) {
    // Repeated polls and Cancel never buy the summary again.
    await expect(f.continueChat(input)).rejects.toMatchObject({ code: "chat_summary_cancelled" });
    await cancelChatContinuation(prisma, input);
    await expect(f.continueChat(input)).rejects.toMatchObject({ code: "chat_summary_cancelled" });
    expect(await prisma.chatContinuation.findUniqueOrThrow({ where: { id: first.claim.id } }))
      .toMatchObject({ status: "failed", errorCode: "chat_summary_cancelled", attemptId: first.claim.attemptId });
  }
  const next = await f.repository.claim(source, randomUUID());
  if (next.kind !== "claimed") throw new Error("fresh claim missing");
  expect(next.claim.attemptId).not.toBe(first.claim.attemptId);
  expect(await prisma.chatContinuation.findUniqueOrThrow({ where: { id: next.claim.id } }))
    .toMatchObject({ status: "running", attemptId: next.claim.attemptId, cancelRequestedAt: null, errorCode: null });
  if (firstSeed) {
    expect(await prisma.chatContinuationWorkspaceSeed.findUniqueOrThrow({ where: { id: firstSeed.id } }))
      .toMatchObject({ continuationId: null, status: "ABANDONED", failureCode: "chat_summary_cancelled" });
    expect(await prisma.chatContinuationWorkspaceSeed.findUniqueOrThrow({ where: { continuationId: next.claim.id } }))
      .toMatchObject({ status: "NO_SOURCE_DISK" });
  }
  // The dead attempt's late worker can neither publish nor settle its successor.
  expect(await f.repository.heartbeat!(first.claim, { completedParts: 1, stage: "summarizing" })).toBe(false);
  await expect(f.repository.complete(source, first.claim, "Late output")).rejects.toMatchObject({ code: "chat_changed" });
  await f.repository.fail(first.claim, "chat_summary_failed");
  expect(await prisma.chatContinuation.findUniqueOrThrow({ where: { id: next.claim.id } }))
    .toMatchObject({ status: "running", attemptId: next.claim.attemptId, newChatId: null });
  expect(await prisma.chat.count({ where: mode === "PROJECT" ? { createdByUserId: userId } : { userId } })).toBe(1);
  expect(f.execute).not.toHaveBeenCalled();
  await f.repository.fail(next.claim, "chat_summary_cancelled");
}, mode));

it("abandons a dead cancelled attempt's capture seed and retires its Workspace reservation before a fresh attempt", () => fixture(async ({ chatId, userId, leafId }) => {
  const w = await workspaceSource(chatId);
  const f = service(w);
  const input = { userId, chatId, expectedLeafMessageId: leafId, requestId: randomUUID() };
  const source = await f.repository.loadSource(input);
  const first = await f.repository.claim(source, input.requestId);
  if (first.kind !== "claimed") throw new Error("claim missing");
  const firstSeed = await prisma.chatContinuationWorkspaceSeed.findUniqueOrThrow({ where: { continuationId: first.claim.id } });
  expect(firstSeed.status).toBe("CAPTURING");
  expect(await prisma.workspaceSession.findUnique({ where: { id: w.session.id } }))
    .toMatchObject({ operationOwner: `continuation:${first.claim.id}` });
  await cancelChatContinuation(prisma, input);
  await lapseLease(first.claim.id);
  await expect(f.repository.claim(source, input.requestId)).rejects.toMatchObject({ code: "chat_summary_cancelled" });
  expect(await prisma.chatContinuationWorkspaceSeed.findUniqueOrThrow({ where: { id: firstSeed.id } }))
    .toMatchObject({ status: "ABANDONED", failureCode: "chat_summary_cancelled", leaseToken: null, leaseExpiresAt: null });
  const released = await prisma.workspaceSession.findUniqueOrThrow({ where: { id: w.session.id } });
  expect(released).toMatchObject({ operationOwner: null, operationExpiresAt: null });
  const next = await f.repository.claim(source, randomUUID());
  if (next.kind !== "claimed") throw new Error("fresh claim missing");
  const nextSeed = await prisma.chatContinuationWorkspaceSeed.findUniqueOrThrow({ where: { continuationId: next.claim.id } });
  expect(nextSeed).toMatchObject({ status: "CAPTURING" });
  expect(nextSeed.id).not.toBe(firstSeed.id);
  expect(await prisma.chatContinuationWorkspaceSeed.findUniqueOrThrow({ where: { id: firstSeed.id } }))
    .toMatchObject({ continuationId: null, status: "ABANDONED" });
  expect(await prisma.workspaceSession.findUniqueOrThrow({ where: { id: w.session.id } }))
    .toMatchObject({ operationOwner: `continuation:${next.claim.id}`, version: released.version + 1 });
  await expect(f.repository.captureWorkspace!(source, first.claim)).rejects.toMatchObject({ code: "chat_changed" });
  await f.repository.fail(next.claim, "chat_summary_cancelled");
  expect(await prisma.workspaceSession.findUnique({ where: { id: w.session.id } })).toMatchObject({ operationOwner: null });
}));

it.each(["CAPTURING", "READY"] as const)("keeps cancellation when Workspace maintenance settles a dead %s attempt first", (seedStatus) => fixture(async ({ chatId, userId, leafId }) => {
  const w = await workspaceSource(chatId);
  const f = service(w);
  const input = { userId, chatId, expectedLeafMessageId: leafId, requestId: randomUUID() };
  const source = await f.repository.loadSource(input);
  const first = await f.repository.claim(source, input.requestId);
  if (first.kind !== "claimed") throw new Error("claim missing");
  if (seedStatus === "READY") await f.repository.captureWorkspace!(source, first.claim);
  // A CAPTURING seed whose reservation maintenance has already retired; the
  // worker never entered the runtime operation.
  else await prisma.workspaceSession.update({ where: { id: w.session.id }, data: { operationOwner: null, operationExpiresAt: null } });
  const seed = await prisma.chatContinuationWorkspaceSeed.findUniqueOrThrow({ where: { continuationId: first.claim.id } });
  expect(seed.status).toBe(seedStatus);
  await cancelChatContinuation(prisma, input);
  const stale = new Date(Date.now() - 240_000);
  await lapseLease(first.claim.id);
  await prisma.chatContinuationWorkspaceSeed.update({ where: { id: seed.id }, data: { updatedAt: stale,
    ...(seedStatus === "CAPTURING" ? { leaseExpiresAt: stale } : {}) } });
  await runWorkspaceMaintenance({ config: w.config, prisma, runtime: w.runtime });
  expect(await prisma.chatContinuation.findUniqueOrThrow({ where: { id: first.claim.id } }))
    .toMatchObject({ status: "failed", errorCode: "chat_summary_cancelled" });
  expect(await prisma.chatContinuationWorkspaceSeed.findUniqueOrThrow({ where: { id: seed.id } })).toMatchObject({ status: "ABANDONED" });
  await expect(f.continueChat(input)).rejects.toMatchObject({ code: "chat_summary_cancelled" });
  const next = await f.repository.claim(source, randomUUID());
  if (next.kind !== "claimed") throw new Error("fresh claim missing");
  expect(f.execute).not.toHaveBeenCalled();
  await f.repository.fail(next.claim, "chat_summary_cancelled");
  if (seed.storageKey) {
    expect(await prisma.attachmentDeletionJob.count({ where: { storageKey: seed.storageKey } })).toBe(1);
    await prisma.chatContinuationWorkspaceSeed.update({ where: { id: seed.id }, data: { storageKey: null, checksum: null, byteSize: null } });
    await prisma.attachmentDeletionJob.deleteMany({ where: { storageKey: seed.storageKey } });
  }
}));

it("keeps Project ownership and rejects membership loss before commit", () => fixture(async ({ userId, chatId, leafId, projectId }) => {
  const f = service();
  const input = { userId, chatId, expectedLeafMessageId: leafId, requestId: randomUUID() };
  const result = await f.continueChat(input);
  if (result.status !== "complete") throw new Error("summary missing");
  expect(await prisma.chat.findUnique({ where: { id: result.chatId } })).toMatchObject({ projectId, userId: null, memoryMode: "EXCLUDED", workspaceEnabled: false });
  expect(await prisma.projectAuditEvent.count({ where: { projectId: projectId!, eventType: "project_chat_created", metadata: { path: ["chatId"], equals: result.chatId } } })).toBe(1);
  expect(await continuationSourceHref(prisma, result.chatId, userId)).toBe(`/p/${projectId}/c/${chatId}`);
  const memberId = randomUUID();
  await prisma.user.create({ data: { id: memberId, displayName: "Contributor", status: "active" } });
  try {
    const grant = await prisma.projectGrant.create({ data: { projectId: projectId!, userId: memberId, role: "CONTRIBUTOR" } });
    await prisma.chat.update({ where: { id: chatId }, data: { title: "Next snapshot" } });
    const source = await f.repository.loadSource({ ...input, userId: memberId });
    const claim = await f.repository.claim(source, randomUUID());
    if (claim.kind !== "claimed") throw new Error("claim missing");
    await prisma.projectGrant.delete({ where: { id: grant.id } });
    await expect(f.repository.complete(source, claim.claim, "summary")).rejects.toBeInstanceOf(ChatContinuationError);
    expect(await continuationSourceHref(prisma, result.chatId, memberId)).toBeNull();
    await f.repository.fail(claim.claim, "chat_not_found");
  } finally { await prisma.user.delete({ where: { id: memberId } }); }
}, "PROJECT"));

it("keeps temporary continuations temporary with a deletion deadline and no Workspace", () => fixture(async ({ userId, chatId, leafId }) => {
  const result = await service().continueChat({ userId, chatId, expectedLeafMessageId: leafId, requestId: randomUUID() });
  if (result.status !== "complete") throw new Error("summary missing");
  expect(await prisma.chat.findUnique({ where: { id: result.chatId } })).toMatchObject({
    userId, memoryMode: "TEMPORARY", temporaryRetentionDeadline: expect.any(Date), workspaceEnabled: false
  });
  expect(await prisma.memoryDeletionOutbox.count({ where: { userId, targetId: result.chatId, operation: "TEMPORARY_DELETE" } })).toBe(1);
}, "TEMPORARY"));

it("renews a long-running continuation, reuses settled parts, fences cancellation and never replays unknown dispatch", () => fixture(async ({ userId, chatId, leafId }) => {
  const repository = createChatContinuationRepository(prisma);
  const input = { userId, chatId, expectedLeafMessageId: leafId, requestId: randomUUID() };
  const source = await repository.loadSource(input);
  const accepted = await repository.claim(source, input.requestId);
  if (accepted.kind !== "claimed") throw new Error("claim missing");
  const claim = accepted.claim;
  await prisma.chatContinuation.update({ where: { id: claim.id }, data: { updatedAt: new Date(Date.now() - 3600000) } });
  expect(await repository.heartbeat!(claim, { completedParts: 3, stage: "combining" })).toBe(true);
  expect(await repository.claim(source, input.requestId)).toMatchObject({ kind: "result", result: {
    status: "running", progress: { completedParts: 3, stage: "combining" }
  } });
  const settled = "a".repeat(64), unknown = "b".repeat(64);
  await repository.beginStep!(claim, settled);
  await repository.settleStep!(claim, settled, { summary: "Settled fixture summary." });
  expect(await repository.loadStep!(claim, settled)).toBe("Settled fixture summary.");
  await repository.beginStep!(claim, unknown);
  await expect(repository.loadStep!(claim, unknown)).rejects.toMatchObject({ code: "chat_summary_outcome_unknown" });
  const { cancelChatContinuation } = await import("./continuationRepository");
  await cancelChatContinuation(prisma, { chatId, userId, requestId: input.requestId });
  expect(await repository.heartbeat!(claim, { completedParts: 3, stage: "combining" })).toBe(false);
  await expect(repository.complete(source, claim, "Late output")).rejects.toBeInstanceOf(ChatContinuationError);
  expect(await prisma.chatContinuation.findUniqueOrThrow({ where: { id: claim.id } })).toMatchObject({ newChatId: null });
}));

it("rolls back the destination if cancellation wins after the completion preflight", () => fixture(async ({ userId, chatId, leafId }) => {
  const repository = createChatContinuationRepository(prisma);
  const input = { userId, chatId, expectedLeafMessageId: leafId, requestId: randomUUID() };
  const source = await repository.loadSource(input);
  const accepted = await repository.claim(source, input.requestId);
  if (accepted.kind !== "claimed") throw new Error("claim missing");
  const { cancelChatContinuation } = await import("./continuationRepository");
  const client = prisma.$extends({ query: { chat: { async create({ args, query }) {
    await cancelChatContinuation(prisma, input);
    return query(args);
  } } } });
  const racing = createChatContinuationRepository(client as unknown as typeof prisma);
  await expect(racing.complete(source, accepted.claim, "Late output")).rejects.toBeInstanceOf(ChatContinuationError);
  expect(await prisma.chat.count({ where: { userId } })).toBe(1);
  expect(await prisma.chatContinuation.findUniqueOrThrow({ where: { id: accepted.claim.id } }))
    .toMatchObject({ newChatId: null, cancelRequestedAt: expect.any(Date) });
}));
