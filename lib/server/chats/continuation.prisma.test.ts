import { randomUUID } from "node:crypto";
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

function service() {
  const repository = createChatContinuationRepository(prisma);
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
