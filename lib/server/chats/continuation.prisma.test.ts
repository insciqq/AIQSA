import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, expect, it, vi } from "vitest";
import { textMessageContent } from "../../domain/content";
import { prisma } from "../prisma";
import { createPrismaProjectRepository } from "../projects/prismaRepository";
import type { ProviderAdmissionRole } from "../providerRuntime/admission";
import { ChatContinuationError, createChatContinuationService } from "./continuation";
import { continuationSourceHref, createChatContinuationRepository } from "./continuationRepository";
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

afterAll(() => prisma.$disconnect());

async function fixture(run: (data: { userId: string; chatId: string; leafId: string; projectId: string | null }) => Promise<void>, mode: "NORMAL" | "TEMPORARY" | "PROJECT" = "NORMAL") {
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
    await prisma.workspaceSession.deleteMany({ where: { chat: { OR: [{ userId }, ...(projectId ? [{ projectId }] : [])] } } });
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
  }
}

function service(deps: Parameters<typeof createChatContinuationRepository>[1] = {}) {
  const repository = createChatContinuationRepository(prisma, deps);
  const execute = vi.fn<Parameters<typeof createChatContinuationService>[0]["execute"]>(async (_role, _request, options) => {
    options.onUsage?.({ inputTokens: 50, outputTokens: 12, reasoningTokens: 0, totalTokens: 62 });
    return { summary: "## Goal\nRelease a small feature.\n## Decisions\nKeep find_tools unchanged." };
  });
  return { repository, execute, continueChat: createChatContinuationService({ repository, execute,
    resolveSystemModel: async () => ({ ok: true, credentialScope: "installation", policyVersion: 1,
      providerModelId: "summary-test-model", reasoningEffort: null,
      role: { modelConfiguration: { capabilities: { contextWindow: 32000, structuredOutput: true } },
        snapshot: { providerFamily: "fake", model: { upstreamModelId: "fake-summary" } } } as unknown as ProviderAdmissionRole })
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
      expect(await f.repository.claim(source, input.requestId, { provider: "changed", modelId: original })).toEqual({ kind: "result", result: { status: "running" } });
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
  await prisma.chatContinuation.update({ where: { id: claim.claim.id }, data: { updatedAt: stale } });
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
  }, mode);
  expect(captured).not.toBeNull();
  const seed = captured as unknown as { id: string; storageKey: string };
  expect(await prisma.chatContinuationWorkspaceSeed.findUnique({ where: { id: seed.id } })).toBeNull();
  expect(await prisma.attachmentDeletionJob.count({ where: { storageKey: seed.storageKey } })).toBe(1);
  await prisma.attachmentDeletionJob.deleteMany({ where: { storageKey: seed.storageKey } });
});

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
  expect(await continuationSourceHref(prisma, result.chatId, userId)).toBe(`/?chat=${chatId}`);
  expect(await continuationSourceHref(prisma, result.chatId, randomUUID())).toBeNull();
  expect(await prisma.usageEvent.findMany({ where: { chatId } })).toEqual([
    expect.objectContaining({ userId, inputTokens: 50, outputTokens: 12, reasoningTokens: 0, totalTokens: 62, modelId: "summary-test-model", estimatedCostMicros: null })
  ]);
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
  await prisma.chatContinuation.update({ where: { id: claimed.claim.id }, data: { updatedAt: new Date(Date.now() - 240000) } });
  expect(await f.repository.claim(source, input.requestId)).toEqual({ kind: "failed" });
  expect((await prisma.chatContinuation.findUnique({ where: { id: claimed.claim.id } }))?.status).toBe("failed");
  await expect(f.continueChat(input)).rejects.toMatchObject({ code: "chat_summary_failed" });
  expect(f.execute).not.toHaveBeenCalled();
  const result = await f.continueChat({ ...input, requestId: randomUUID() });
  if (result.status !== "complete") throw new Error("summary missing");
  await prisma.chat.delete({ where: { id: result.chatId } });
  await expect(f.continueChat({ ...input, requestId: randomUUID() })).rejects.toMatchObject({ code: "chat_not_found" });
  expect(f.execute).toHaveBeenCalledOnce();
}));

it("keeps Project ownership and rejects membership loss before commit", () => fixture(async ({ userId, chatId, leafId, projectId }) => {
  const f = service();
  const input = { userId, chatId, expectedLeafMessageId: leafId, requestId: randomUUID() };
  const result = await f.continueChat(input);
  if (result.status !== "complete") throw new Error("summary missing");
  expect(await prisma.chat.findUnique({ where: { id: result.chatId } })).toMatchObject({ projectId, userId: null, memoryMode: "EXCLUDED", workspaceEnabled: false });
  expect(await prisma.projectAuditEvent.count({ where: { projectId: projectId!, eventType: "project_chat_created", metadata: { path: ["chatId"], equals: result.chatId } } })).toBe(1);
  expect(await continuationSourceHref(prisma, result.chatId, userId)).toBe(`/?chat=${chatId}&project=${projectId}`);
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
