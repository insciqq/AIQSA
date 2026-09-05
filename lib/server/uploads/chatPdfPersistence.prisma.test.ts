import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import { NOOP_MEMORY_SOURCE_MUTATION_HOOKS } from "../memory/sourceState";
import { scheduleTemporaryChatDeletion } from "../memory/temporaryRetention";
import { MEMORY_TEMPORARY_RETENTION_POLICY_VERSION } from "../../contracts/memory";
import { createPrismaTemporaryChatDeletionHandler } from "../memory/temporaryDeletion";
import type { MemoryDeletionClaim } from "../memory/coordinator/types";
import { createChatPdfAttempts } from "./chatPdfAttempts";
import { createChatPdfRepository, chatPdfJson } from "./chatPdfPersistence";
import { chatPdfCompatibilityKey, encodeChatPdfArtifact, type ChatPdfWorkPlan } from "./chatPdfCore";
import type { ChatPdfAttachmentAdmission } from "./chatPdfAdmission";

const owners: string[] = [];
const connections: string[] = [];
const attachmentIds: string[] = [];
const repository = createChatPdfRepository(prisma);
const attempts = createChatPdfAttempts(prisma);

async function fixture(vision = false, temporary = false, workspace = false) {
  const userId = randomUUID(); owners.push(userId);
  const sourceChecksum = "a".repeat(64);
  const attachmentId = randomUUID();
  attachmentIds.push(attachmentId);
  let binding: Pick<ChatPdfAttachmentAdmission, "snapshot" | "authority"> = { snapshot: null, authority: null };
  if (vision) {
    const connection = await prisma.providerConnection.create({ data: { id: randomUUID(), displayName: "PDF test", family: "openai_compatible" } });
    connections.push(connection.id);
    const credential = await prisma.providerCredential.create({ data: { id: randomUUID(), connectionId: connection.id, label: "PDF test" } });
    const version = await prisma.providerCredentialVersion.create({ data: {
      id: randomUUID(), credentialId: credential.id, version: 1, testEvidence: { authenticationMode: "none" }, testedAt: new Date(), activatedAt: new Date()
    } });
    const capabilities = { nativePdfInput: false, nativeSearch: false, pdf: true, vision: true, reasoning: false };
    const model = await prisma.providerModel.create({ data: {
      id: randomUUID(), connectionId: connection.id, provider: "openai_compatible", modelId: "fixture", displayName: "PDF test",
      capabilities, defaultParams: {}, inputTokenPriceMicros: 2, outputTokenPriceMicros: 8
    } });
    binding = { authority: { connectionId: connection.id, connectionVersion: 1, credentialId: credential.id,
      credentialVersionId: version.id, modelVersion: 1, providerModelId: model.id }, snapshot: {
      version: 1, connectionDisplayName: "PDF test", modelDisplayName: "PDF test", connectionId: connection.id,
      credentialId: credential.id, credentialVersionId: version.id, providerModelId: model.id, providerFamily: "openai_compatible",
      connection: { allowPrivateNetwork: false, apiRoot: "https://pdf.example.test/v1", authenticationMode: "none", responseTimeoutMs: 120000 },
      model: { adapterKind: "openai_responses_compatible", answerSelectable: true, capabilities, defaultParams: {}, modelClass: "answer", upstreamModelId: "fixture" }
    } };
  }
  const admission: ChatPdfAttachmentAdmission = { ...binding, attachmentId, byteSize: 10, pageCount: 2,
    policyVersion: null, route: vision ? "selected_model_vision" : "local_text", sourceChecksum };
  const accepted = await prisma.$transaction(async (tx) => {
    await tx.user.create({ data: { id: userId, displayName: "PDF owner", status: "active" } });
    const chat = await tx.chat.create({ data: { title: "PDF test", userId,
      ...(temporary ? { memoryMode: "TEMPORARY", temporaryRetentionPolicyVersion: MEMORY_TEMPORARY_RETENTION_POLICY_VERSION,
        temporaryRetentionDeadline: new Date(Date.now() + 3600000) } : {}) } });
    if (temporary) await scheduleTemporaryChatDeletion(tx, { chatId: chat.id, userId,
      deadline: chat.temporaryRetentionDeadline!, now: new Date() });
    const message = await tx.message.create({ data: { chatId: chat.id, role: "user",
      content: { blocks: [{ type: "file", attachmentId }] } } });
    const assistant = await tx.message.create({ data: { chatId: chat.id, role: "assistant",
      parentMessageId: message.id, status: "queued", content: { blocks: [] } } });
    await tx.attachment.create({ data: { id: attachmentId, userId, chatId: chat.id, messageId: message.id,
      kind: "pdf", mimeType: "application/pdf", fileName: "fixture.pdf", storageKey: `test/${attachmentId}`,
      checksum: sourceChecksum, byteSize: 10, metadata: {} } });
    const run = await tx.modelRun.create({ data: { userId, chatId: chat.id, userMessageId: message.id,
      assistantMessageId: assistant.id, modelId: "fixture", provider: "openai_compatible", status: "preparing" } });
    if (workspace) {
      const session = await tx.workspaceSession.create({ data: { chatId: chat.id,
        sandboxName: `aiqsa-ws-${randomUUID()}`, imageRef: "fixture", internetEnabled: false,
        policyRevision: 1, expiresAt: new Date(Date.now() + 3600000) } });
      await tx.workspaceRunBinding.create({ data: { modelRunId: run.id, workspaceSessionId: session.id,
        imageRef: "fixture", internetEnabled: false, policyRevision: 1, runtimeVersion: "fixture",
        mcpVersion: "fixture", toolCatalogHash: "a".repeat(64), toolDefinitions: [{ name: "execute" }],
        outputDirectory: `/workspace/output/${run.id}` } });
    }
    await tx.chat.update({ where: { id: chat.id }, data: { activeLeafMessageId: assistant.id } });
    if (admission.snapshot) await tx.providerRunBinding.create({ data: {
      modelRunId: run.id, role: "answer", credentialSource: "default", connectionId: admission.snapshot.connectionId,
      providerModelId: admission.snapshot.providerModelId, credentialId: admission.snapshot.credentialId,
      credentialVersionId: admission.snapshot.credentialVersionId, executionSnapshot: chatPdfJson(admission.snapshot)
    } });
    await tx.chatPdfRunPreparation.create({ data: { modelRunId: run.id, admissionKey: run.id.replaceAll("-", "").repeat(2),
      snapshot: { version: 1, prepared: { sourceKind: "send", normalizedRequest: { chatId: chat.id } } } } });
    const preparation = await tx.chatPdfAttachmentPreparation.create({ data: {
      modelRunId: run.id, attachmentId, route: admission.route, sourceChecksum, sourceByteSize: 10, pageCount: 2,
      bindingSnapshot: admission.snapshot ? chatPdfJson(admission.snapshot) : Prisma.DbNull,
      bindingAuthority: admission.authority ? chatPdfJson(admission.authority) : Prisma.DbNull,
      providerModelId: admission.snapshot?.providerModelId, credentialVersionId: admission.snapshot?.credentialVersionId,
      compatibilityKey: chatPdfCompatibilityKey(admission)
    } });
    return { chatId: chat.id, runId: run.id, preparationId: preparation.id };
  });
  const claim = await repository.claim();
  expect(claim?.runId).toBe(accepted.runId);
  const plan: ChatPdfWorkPlan = { adaptive: null, compatibilityKey: chatPdfCompatibilityKey(admission),
    limits: { imageBytes: 2097152, imageCount: 3, imagePixels: 10000000, payloadBytes: 9437184 },
    maxBlocks: 100, maxCharacters: 1000, pageCount: 2, parserVersion: 14, renderVersion: 1, promptVersion: 6,
    units: [1, 2].map((page) => ({ page, route: vision ? "vision_required" : "native_only", crops: [], key: String(page).repeat(64) })), version: 1 };
  async function artifact(kind: "local" | "page" | "document") {
    const encoded = encodeChatPdfArtifact({ pageCount: 2, text: "Bounded fixture text" });
    const row = await repository.reserveArtifact(claim!, { admission, kind, pageCount: 2,
      byteSize: encoded.body.length, checksum: encoded.checksum });
    expect(await repository.acceptArtifact(claim!, row.id)).toBe(true);
    return row;
  }
  async function savePlan() {
    const local = await artifact("local");
    await repository.savePlan(claim!, { localArtifactId: local.id, plan, preparationId: accepted.preparationId });
  }
  return { ...accepted, admission, artifact, claim: claim!, plan, savePlan, userId };
}

afterEach(async () => {
  for (const id of owners.splice(0)) await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
    await tx.workspaceRunBinding.deleteMany({ where: { modelRun: { userId: id } } });
    await tx.workspaceSession.deleteMany({ where: { chat: { userId: id } } });
    await tx.memoryDeletionOutbox.updateMany({
      data: { completedAt: null, leaseExpiresAt: new Date(Date.now() + 300000),
        leaseToken: "pdf-test-cleanup", nextAttemptAt: null, state: "RUNNING" },
      where: { operation: "TEMPORARY_DELETE", userId: id }
    });
    await tx.chat.deleteMany({ where: { userId: id, memoryMode: "TEMPORARY" } });
    await tx.memoryDeletionOutbox.deleteMany({ where: { userId: id } });
    await tx.user.deleteMany({ where: { id } });
  });
  for (const id of attachmentIds.splice(0)) await prisma.attachmentDeletionJob.deleteMany({
    where: { storageKey: { startsWith: `chat-pdf/${id}/` } }
  });
  for (const id of connections.splice(0)) {
    await prisma.providerModel.deleteMany({ where: { connectionId: id } });
    await prisma.providerCredentialVersion.deleteMany({ where: { credential: { connectionId: id } } });
    await prisma.providerCredential.deleteMany({ where: { connectionId: id } });
    await prisma.providerConnection.deleteMany({ where: { id } });
  }
});
afterAll(() => prisma.$disconnect());

describe("chat PDF database lifecycle", () => {
  it("durably admits a Workspace original without a document artifact and preserves that outcome for recovery", async () => {
    const h = await fixture(false, true, true);
    await repository.useWorkspaceOriginal(h.claim, h.preparationId, "pdf_local_text_unusable");
    expect(await prisma.chatPdfAttachmentPreparation.findUnique({ where: { id: h.preparationId } }))
      .toMatchObject({ state: "original_only", completedPages: 0, documentArtifactId: null, retryable: false });
    await expect(prisma.chatPdfAttachmentPreparation.update({ where: { id: h.preparationId }, data: { state: "preparing" } }))
      .rejects.toThrow(/chat_pdf_transition_invalid|chat_pdf_preparation_immutable/);
    const runs = createPrismaRunRepository(prisma, { memorySourceHooks: NOOP_MEMORY_SOURCE_MUTATION_HOOKS });
    expect(await runs.loadAttachments(h.userId, [h.admission.attachmentId], undefined, h.runId))
      .toEqual([expect.objectContaining({ workspaceOriginalOnly: true })]);
    await prisma.modelRun.update({ where: { id: h.runId }, data: { normalizedRequest: {}, status: "streaming" } });
    expect(await repository.markAnswerDispatched(h.claim)).toBe(true);
    expect(await repository.claim()).toBeNull();
    expect(await prisma.chatPdfPageAttempt.count({ where: { preparationId: h.preparationId } })).toBe(0);
  });

  it("does not use Workspace degradation to bypass the Personal Memory gate", async () => {
    const h = await fixture(false, false, true);
    await repository.useWorkspaceOriginal(h.claim, h.preparationId, "pdf_local_text_unusable");
    await expect(prisma.modelRun.update({ where: { id: h.runId }, data: { normalizedRequest: {}, status: "streaming" } }))
      .rejects.toThrow(/chat_pdf_memory_not_ready/);
  });

  it("keeps ambiguous Vision work and late usage after continuing with the original", async () => {
    const h = await fixture(true, true, true); await h.savePlan();
    const reserved = await attempts.reserve(h.claim, { preparationId: h.preparationId, page: 1,
      workKey: h.plan.units[0]!.key, requestDigest: "b".repeat(64) });
    if (reserved.kind !== "reserved") throw new Error("reservation missing");
    const dispatch = await attempts.dispatch(h.claim, reserved.attemptId);
    await attempts.ambiguous(dispatch, "pdf_transcription_failed");
    await repository.useWorkspaceOriginal(h.claim, h.preparationId, "pdf_transcription_failed");
    await prisma.modelRun.update({ where: { id: h.runId }, data: { normalizedRequest: {}, status: "streaming" } });
    expect(await repository.markAnswerDispatched(h.claim)).toBe(true);
    await attempts.recordUsage(dispatch, { inputTokens: 9, outputTokens: 2, reasoningTokens: 0 });
    expect(await attempts.list(h.preparationId)).toEqual([expect.objectContaining({
      state: "ambiguous", errorCode: "pdf_transcription_failed", resultArtifactId: null
    })]);
    expect(await prisma.usageEvent.findUnique({ where: { id: dispatch.usageEventId } }))
      .toMatchObject({ inputTokens: 9, outputTokens: 2, totalTokens: 11 });
    expect(await repository.claim()).toBeNull();
  });

  it("rejects original-only state without a Workspace binding or after Stop", async () => {
    const h = await fixture();
    await expect(repository.useWorkspaceOriginal(h.claim, h.preparationId, "pdf_local_text_unusable"))
      .rejects.toThrow("pdf_preparation_unavailable");
    await expect(prisma.chatPdfAttachmentPreparation.update({ where: { id: h.preparationId },
      data: { state: "original_only", errorCode: "pdf_local_text_unusable" } }))
      .rejects.toThrow(/chat_pdf_workspace_original_invalid/);
    await prisma.modelRun.update({ where: { id: h.runId }, data: { normalizedRequest: {}, status: "cancelled" } });
    await expect(repository.useWorkspaceOriginal(h.claim, h.preparationId, "pdf_local_text_unusable"))
      .rejects.toThrow("pdf_preparation_unavailable");
  });

  it("commits a durable PDF gate without a Memory attempt and refuses premature answer dispatch", async () => {
    const h = await fixture();
    expect(await prisma.memoryRetrievalAttempt.count({ where: { modelRunId: h.runId } })).toBe(0);
    await expect(prisma.modelRun.update({ where: { id: h.runId }, data: { normalizedRequest: {}, status: "streaming" } }))
      .rejects.toThrow(/chat_pdf_answer_not_ready/);
    expect(await repository.claim()).toBeNull();
    await expect(repository.load({ ...h.claim, claimToken: randomUUID() })).rejects.toThrow("pdf_preparation_unavailable");
  });

  it("freezes plans, artifact kinds and generations, and monotonic completed work", async () => {
    const h = await fixture(); await h.savePlan();
    await expect(repository.savePlan(h.claim, { preparationId: h.preparationId,
      localArtifactId: (await h.artifact("local")).id, plan: { ...h.plan, promptVersion: 99 } }))
      .rejects.toThrow("pdf_preparation_invalid");
    const wrongKind = await h.artifact("page");
    await repository.beginAssembly(h.claim, h.preparationId);
    await expect(repository.publishDocument(h.claim, h.preparationId, wrongKind.id)).rejects.toThrow(/chat_pdf_artifact_scope_invalid/);
    const document = await h.artifact("document");
    await repository.publishDocument(h.claim, h.preparationId, document.id);
    await expect(prisma.chatPdfAttachmentPreparation.update({ where: { id: h.preparationId }, data: { completedPages: 1 } }))
      .rejects.toThrow(/chat_pdf_preparation_immutable/);
  });

  it("persists unknown usage before dispatch, accounts reported usage once, and never replays ambiguity", async () => {
    const h = await fixture(true); await h.savePlan();
    const work = { preparationId: h.preparationId, page: 1, workKey: h.plan.units[0]!.key, requestDigest: "b".repeat(64) };
    const reserved = await attempts.reserve(h.claim, work);
    expect(reserved.kind).toBe("reserved"); if (reserved.kind !== "reserved") throw new Error("reservation missing");
    const dispatch = await attempts.dispatch(h.claim, reserved.attemptId);
    expect(await prisma.usageEvent.findUnique({ where: { id: dispatch.usageEventId } })).toMatchObject({ inputTokens: null, outputTokens: null, estimatedCostMicros: null });
    await attempts.recordUsage(dispatch, { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 });
    expect(await prisma.usageEvent.findUnique({ where: { id: dispatch.usageEventId } })).toMatchObject({ inputTokens: null, totalTokens: null });
    await expect(attempts.dispatch(h.claim, reserved.attemptId)).rejects.toThrow();
    const usage = { inputTokens: 30, outputTokens: 5, reasoningTokens: 0 };
    await Promise.all([attempts.recordUsage(dispatch, usage), attempts.recordUsage(dispatch, usage)]);
    expect(await prisma.usageEvent.findUnique({ where: { id: dispatch.usageEventId } })).toMatchObject({ inputTokens: 30, outputTokens: 5, totalTokens: 35 });
    expect(await attempts.reserve(h.claim, work)).toEqual({ kind: "ambiguous" });
    expect(await prisma.usageEvent.count({ where: { modelRunId: h.runId } })).toBe(1);
  });

  it("keeps Stop terminal, rejects late publication, and queues all private artifact deletions", async () => {
    const h = await fixture(); await h.savePlan();
    const reserved = await repository.reserveArtifact(h.claim, { admission: h.admission, kind: "document",
      pageCount: 2, byteSize: 100, checksum: "c".repeat(64) });
    await prisma.modelRun.update({ where: { id: h.runId }, data: { normalizedRequest: {}, status: "cancelled" } });
    await expect(repository.acceptArtifact(h.claim, reserved.id)).rejects.toThrow("pdf_preparation_unavailable");
    expect(await prisma.chatPdfRunPreparation.findUnique({ where: { modelRunId: h.runId } })).toMatchObject({ state: "cancelled", claimToken: null });
    await prisma.attachment.delete({ where: { id: h.admission.attachmentId } });
    expect(await prisma.chatPdfArtifact.count({ where: { attachmentId: h.admission.attachmentId } })).toBe(0);
    expect(await prisma.attachmentDeletionJob.findUnique({ where: { storageKey: reserved.storageKey } })).toMatchObject({ storageKey: reserved.storageKey });
  });

  it("preserves a detached receipt for late usage after document deletion", async () => {
    const h = await fixture(true); await h.savePlan();
    const reserved = await attempts.reserve(h.claim, { preparationId: h.preparationId, page: 1,
      workKey: h.plan.units[0]!.key, requestDigest: "d".repeat(64) });
    if (reserved.kind !== "reserved") throw new Error("reservation missing");
    const dispatch = await attempts.dispatch(h.claim, reserved.attemptId);
    await prisma.modelRun.update({ where: { id: h.runId }, data: { normalizedRequest: {}, status: "cancelled" } });
    await prisma.attachment.delete({ where: { id: h.admission.attachmentId } });
    expect(await prisma.usageEvent.findUnique({ where: { id: dispatch.usageEventId } })).toMatchObject({
      chatPdfPreparation: true, chatPdfPageAttemptId: null, inputTokens: null
    });
    await attempts.recordUsage(dispatch, { inputTokens: 9, outputTokens: 2, reasoningTokens: 0 });
    await attempts.recordUsage(dispatch, { inputTokens: 99, outputTokens: 22, reasoningTokens: 0 });
    expect(await prisma.usageEvent.findUnique({ where: { id: dispatch.usageEventId } })).toMatchObject({
      inputTokens: 9, outputTokens: 2, totalTokens: 11
    });
    await expect(prisma.usageEvent.update({ where: { id: dispatch.usageEventId }, data: { inputTokens: 99 } }))
      .rejects.toThrow(/chat_pdf_usage_immutable/);
  });

  it("preserves document charges when a Temporary answer completes and excludes them from answer replay", async () => {
    const h = await fixture(true, true); await h.savePlan();
    for (const page of [1, 2]) {
      const reserved = await attempts.reserve(h.claim, { preparationId: h.preparationId, page,
        workKey: h.plan.units[page - 1]!.key, requestDigest: String(page).repeat(64) });
      if (reserved.kind !== "reserved") throw new Error("reservation missing");
      const dispatch = await attempts.dispatch(h.claim, reserved.attemptId);
      const usage = { inputTokens: 10, outputTokens: 2, reasoningTokens: 0 };
      await attempts.recordUsage(dispatch, usage);
      await attempts.settle(dispatch, { resultArtifactId: (await h.artifact("page")).id, usage });
    }
    await repository.completedPages(h.claim, h.preparationId);
    await repository.beginAssembly(h.claim, h.preparationId);
    await repository.publishDocument(h.claim, h.preparationId, (await h.artifact("document")).id);
    const run = await prisma.modelRun.update({ where: { id: h.runId }, data: { normalizedRequest: {}, status: "streaming" } });
    expect(await repository.markAnswerDispatched(h.claim)).toBe(true);
    const runs = createPrismaRunRepository(prisma, { memorySourceHooks: NOOP_MEMORY_SOURCE_MUTATION_HOOKS });
    expect(await runs.completeRun({ runId: h.runId, assistantMessageId: run.assistantMessageId!, chatId: h.chatId,
      userMessageId: run.userMessageId, userId: h.userId, provider: run.provider, modelId: run.modelId,
      finalText: "The answer", usage: { inputTokens: 20, outputTokens: 3, reasoningTokens: 0 } })).toBe(true);
    const receipts = await prisma.usageEvent.findMany({ where: { modelRunId: h.runId } });
    expect(receipts.filter(({ chatPdfPreparation }) => chatPdfPreparation)).toHaveLength(2);
    expect(receipts.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0)).toBe(40);
    expect(await runs.loadRunUsageAttributions!({ runId: h.runId, userId: h.userId })).toHaveLength(1);
    expect(await prisma.memoryRetrievalAttempt.count({ where: { modelRunId: h.runId } })).toBe(0);
  });

  it("reuses only an exact settled page in a new sibling generation without a second receipt", async () => {
    const h = await fixture(true); await h.savePlan();
    const work = { preparationId: h.preparationId, page: 1,
      workKey: h.plan.units[0]!.key, requestDigest: "e".repeat(64) };
    const reserved = await attempts.reserve(h.claim, work);
    if (reserved.kind !== "reserved") throw new Error("reservation missing");
    const dispatch = await attempts.dispatch(h.claim, reserved.attemptId);
    const page = await h.artifact("page");
    await attempts.settle(dispatch, { resultArtifactId: page.id,
      usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } });
    await prisma.modelRun.update({ where: { id: h.runId }, data: { normalizedRequest: {}, status: "cancelled" } });
    const next = await prisma.$transaction(async (tx) => {
      const old = await tx.modelRun.findUniqueOrThrow({ where: { id: h.runId } });
      const assistant = await tx.message.create({ data: { chatId: h.chatId,
        parentMessageId: old.userMessageId, role: "assistant", status: "queued", content: { blocks: [] } } });
      const run = await tx.modelRun.create({ data: { chatId: h.chatId, userId: h.userId,
        assistantMessageId: assistant.id, userMessageId: old.userMessageId,
        provider: old.provider, modelId: old.modelId, status: "preparing" } });
      const { id: _bindingId, modelRunId: _oldRunId, ...binding } = await tx.providerRunBinding.findFirstOrThrow({ where: { modelRunId: h.runId } });
      void _bindingId; void _oldRunId;
      await tx.providerRunBinding.create({ data: { ...binding, executionSnapshot: chatPdfJson(binding.executionSnapshot), modelRunId: run.id } });
      await tx.chatPdfRunPreparation.create({ data: { modelRunId: run.id, admissionKey: "f".repeat(64), snapshot: {} } });
      const { id: _preparationId, modelRunId: _priorRunId, ...prior } = await tx.chatPdfAttachmentPreparation.findUniqueOrThrow({ where: { id: h.preparationId } });
      void _preparationId; void _priorRunId;
      const preparation = await tx.chatPdfAttachmentPreparation.create({ data: { ...prior, modelRunId: run.id,
        state: "checking", workPlan: Prisma.DbNull, localArtifactId: null, errorCode: null,
        bindingSnapshot: chatPdfJson(prior.bindingSnapshot), bindingAuthority: chatPdfJson(prior.bindingAuthority) } });
      return { runId: run.id, preparationId: preparation.id };
    });
    const claim = await repository.claim(); expect(claim?.runId).toBe(next.runId);
    const local = await repository.reserveArtifact(claim!, { admission: h.admission,
      kind: "local", pageCount: 2, byteSize: 10, checksum: "d".repeat(64) });
    await repository.acceptArtifact(claim!, local.id);
    await repository.savePlan(claim!, { preparationId: next.preparationId, localArtifactId: local.id, plan: h.plan });
    expect(await attempts.reserve(claim!, { ...work, preparationId: next.preparationId }))
      .toEqual({ kind: "settled", resultArtifactId: page.id });
    expect(await prisma.usageEvent.count({ where: { modelRunId: next.runId } })).toBe(0);
    expect(await prisma.chatPdfPageAttempt.findFirst({ where: { preparationId: next.preparationId } }))
      .toMatchObject({ reusedFromAttemptId: reserved.attemptId });
  });

  it("deletes an expired Temporary PDF through its guarded aggregate handler and fences late work", async () => {
    const h = await fixture(false, true); await h.savePlan();
    const artifacts = await prisma.chatPdfArtifact.findMany({ where: { attachmentId: h.admission.attachmentId } });
    const now = new Date(Date.now() + 7200000);
    const obligation = await prisma.memoryDeletionOutbox.findFirstOrThrow({ where: { userId: h.userId, targetId: h.chatId } });
    const claim: MemoryDeletionClaim = { ...obligation, claimToken: randomUUID(),
      leaseExpiresAt: new Date(now.getTime() + 300000), recoveredLease: false, resumedFromBlocked: false };
    await prisma.memoryDeletionOutbox.update({ where: { id: obligation.id }, data: {
      state: "RUNNING", leaseToken: claim.claimToken, leaseExpiresAt: claim.leaseExpiresAt, nextAttemptAt: null
    } });
    const removed: string[] = [];
    const handler = createPrismaTemporaryChatDeletionHandler({ async deleteObject(key) { removed.push(key); } }, prisma);
    const result = await handler.execute(claim, { now: () => now, signal: new AbortController().signal });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
      await result.apply(tx, claim);
      await tx.memoryDeletionOutbox.update({ where: { id: claim.id }, data: {
        state: "SUCCEEDED", completedAt: now, lastAuditAt: now, leaseToken: null, leaseExpiresAt: null
      } });
    });
    expect(removed).toEqual(expect.arrayContaining([`test/${h.admission.attachmentId}`, ...artifacts.map((a) => a.storageKey)]));
    expect(await prisma.chat.count({ where: { id: h.chatId } })).toBe(0);
    expect(await prisma.chatPdfArtifact.count({ where: { attachmentId: h.admission.attachmentId } })).toBe(0);
    await expect(repository.load(h.claim)).rejects.toThrow("pdf_preparation_unavailable");
    expect(await prisma.attachmentDeletionJob.count({ where: { storageKey: { in: artifacts.map((a) => a.storageKey) } } })).toBe(artifacts.length);
  });
});
