import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../prisma";
import { loadChatUsageTotals } from "../chats/usageTotals";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import type { AvailableVisionAnalysisPlan } from "../providerRuntime/visionAnalysis";
import type { createAcceptedProviderRequestExecutor } from "../providerRuntime/acceptedRequestExecutor";
import type { createWorkspaceSelectedCaptures } from "../workspace/selectedCapture";
import { knowledgeImageObservationRequestHash, type KnowledgeImageObservationPlan } from "../knowledge/imageObservation";
import { createConversationImageSource } from "./conversationImages";
import { createKnowledgeImageObservationStore } from "./knowledgeObservation";
import { createVisionAnalysisService } from "./service";
import { createMemoryStorageAdapter } from "../../../tests/support/storage";

/**
 * The one frozen Knowledge image description per run, against a disposable
 * PostgreSQL: the claim and its usage receipt exist before dispatch, a
 * dispatched description is never sent again (also after a crash), usage
 * settles once, and run deletion removes the private result.
 */
afterAll(() => prisma.$disconnect());
const json = (value: unknown) => value as Prisma.InputJsonValue;
const question = "Does the headline in my poster follow the style guide?";
const images = [{ version: 1, id: "d".repeat(64), byteSize: 3, checksum: "a".repeat(64), mimeType: "image/png", width: 2, height: 2, frames: 1,
  source: { attachmentId: "synthetic", mimeType: "image/png", byteSize: 3, checksum: "b".repeat(64), width: 2, height: 2 }, transform: null }];

async function createFixture(db: PrismaClient) {
  const user = await db.user.create({ data: { id: randomUUID(), displayName: "Synthetic Knowledge image owner", status: "active" } });
  const connectionConfig = { apiRoot: "https://knowledge-image-fixture.example.test/v1", authenticationMode: "bearer" as const,
    allowPrivateNetwork: false, responseTimeoutMs: 5000 };
  const connection = await db.providerConnection.create({ data: { id: randomUUID(), displayName: "Synthetic Vision", family: "openai_compatible",
    enabled: true, activeVersion: 1, activatedAt: new Date(), activeConfig: connectionConfig } });
  const credential = await db.providerCredential.create({ data: { id: randomUUID(), connectionId: connection.id, label: "Synthetic", enabled: true } });
  const version = await db.providerCredentialVersion.create({ data: { id: randomUUID(), credentialId: credential.id, version: 1,
    secretEnvelope: "synthetic-not-dispatched", testEvidence: {}, testedAt: new Date(), activatedAt: new Date() } });
  const modelConfig = { adapterKind: "openai_responses_compatible" as const, modelClass: "answer" as const, upstreamModelId: "vision",
    answerSelectable: true, defaultParams: {}, capabilities: { vision: true, nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, streaming: true } };
  const model = await db.providerModel.create({ data: { id: randomUUID(), connectionId: connection.id, provider: "openai_compatible", modelId: "vision",
    modelClass: "answer", displayName: "Vision", activeConfig: modelConfig, activeVersion: 1, activatedAt: new Date(), capabilities: modelConfig.capabilities,
    defaultParams: {}, inputTokenPriceUsdPerMillion: 1, outputTokenPriceUsdPerMillion: 2 } });
  const vision: AvailableVisionAnalysisPlan = { version: 1, available: true, policyVersion: 1, reasoningEffort: null, verifiedVisionInput: true,
    authority: { connectionId: connection.id, providerModelId: model.id, credentialId: credential.id, credentialVersionId: version.id, modelVersion: 1, connectionVersion: 1 },
    snapshot: { version: 1, connectionId: connection.id, providerModelId: model.id, credentialId: credential.id, credentialVersionId: version.id,
      connectionDisplayName: "Synthetic Vision", modelDisplayName: "Vision", providerFamily: "openai_compatible", connection: connectionConfig, model: modelConfig } };
  const chat = await db.chat.create({ data: { id: randomUUID(), userId: user.id, title: "Synthetic Knowledge image", memoryMode: "EXCLUDED" } });
  const message = await db.message.create({ data: { id: randomUUID(), chatId: chat.id, role: "user", content: {} } });
  const run = await db.modelRun.create({ data: { id: randomUUID(), chatId: chat.id, userId: user.id, userMessageId: message.id, provider: "fake",
    modelId: "text-only", status: "streaming", normalizedRequest: {} } });
  // The same deployment is the run's answer and its System Vision binding: each route reads only its own key.
  for (const bindingKey of ["answer", "vision_analysis"] as const) await db.providerRunBinding.create({ data: { id: randomUUID(), modelRunId: run.id,
    bindingKey, role: bindingKey, credentialSource: "default", connectionId: connection.id, providerModelId: model.id, credentialId: credential.id,
    credentialVersionId: version.id, executionSnapshot: json(vision.snapshot) } });
  const attachmentId = randomUUID();
  const plan: KnowledgeImageObservationPlan = { version: 1, route: "system_vision", imageIds: [attachmentId], vision };
  const context = { runId: run.id, userId: user.id, chatId: chat.id, requestHash: knowledgeImageObservationRequestHash(plan, question) };
  return { db, plan, attachmentId, context, store: createKnowledgeImageObservationStore(db) };
}
type Fixture = Awaited<ReturnType<typeof createFixture>>;

/** One rolled-back transaction per case: no committed state survives. */
async function fixture(check: (f: Fixture) => Promise<void>) {
  const rollback = new Error("knowledge_image_fixture_rollback");
  try { await prisma.$transaction(async tx => {
    const db = new Proxy(tx, { get(target, property) { return property === "$transaction"
      ? (operation: (client: Prisma.TransactionClient) => unknown) => operation(tx) : Reflect.get(target, property); } }) as unknown as PrismaClient;
    await check(await createFixture(db));
    await db.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
    throw rollback;
  }, { timeout: 30_000 }); } catch (error) { if (error !== rollback) throw error; }
}

describe("Knowledge image observation persistence", () => {
  it("claims one dispatch with its receipt, settles provider usage once and reuses the result", async () => fixture(async f => {
    const destination = await f.store.destination(f.context, f.plan);
    if (!destination) throw Error("expected the frozen System Vision destination");
    expect(await f.store.load(f.context)).toBeNull();
    expect(await f.store.dispatch(f.context, destination, json(images))).toBeNull();
    // A claimed but unsettled description is crash-ambiguous and never claimed again.
    expect(await f.store.load(f.context)).toEqual({ kind: "unknown" });
    expect(await f.store.dispatch(f.context, destination, json(images))).toEqual({ kind: "unknown" });
    const receipt = await f.db.usageEvent.findUniqueOrThrow({ where: { knowledgeImageObservationRunId: f.context.runId } });
    expect(receipt).toMatchObject({ visionAnalysis: true, modelRunId: f.context.runId, chatId: f.context.chatId,
      providerModelId: f.plan.vision.authority.providerModelId, inputTokens: null, usageCompleteness: "UNAVAILABLE" });
    const observation = { text: "A poster whose headline is set in a script typeface.", truncated: false };
    const signal = new AbortController().signal;
    expect(await f.store.settle(f.context, { kind: "observed", observation }, { inputTokens: 3, outputTokens: 2 }, false, signal))
      .toEqual({ kind: "observed", observation });
    expect(await f.store.settle(f.context, { kind: "failed", code: "vision_analysis_provider_failed" }, { inputTokens: 30 }, false, signal))
      .toEqual({ kind: "observed", observation });
    expect(await f.store.load(f.context)).toEqual({ kind: "observed", observation });
    expect(await f.store.load({ ...f.context, requestHash: "e".repeat(64) })).toEqual({ kind: "failed", code: "knowledge_image_observation_conflict" });
    expect(await f.db.knowledgeImageObservation.findUniqueOrThrow({ where: { modelRunId: f.context.runId } })).toMatchObject({
      providerBindingKey: "vision_analysis", state: "settled", failureCode: null, images });
    expect(await f.db.usageEvent.count({ where: { modelRunId: f.context.runId } })).toBe(1);
    expect(await f.db.usageEvent.findUniqueOrThrow({ where: { id: receipt.id } })).toMatchObject({
      inputTokens: 3, outputTokens: 2, totalTokens: 5, usageCompleteness: "COMPLETE", estimatedCostMicros: 7 });
    // A pre-answer receipt counts in the chat total but never as the run's answer usage.
    expect(await f.db.$transaction(tx => loadChatUsageTotals(tx, f.context.chatId))).toMatchObject({
      hasCompletedAnswer: false, recordCount: 1, totalTokens: 5, estimatedCostMicros: 7 });
    expect(await createPrismaRunRepository(f.db).loadRunUsageAttributions({ runId: f.context.runId, userId: f.context.userId })).toEqual([]);
  }));

  it("keeps an ambiguous provider outcome and the usage received, and a late success after Stop unpublished", async () => fixture(async f => {
    const destination = (await f.store.destination(f.context, f.plan))!;
    await f.store.dispatch(f.context, destination, json(images));
    const signal = new AbortController().signal;
    expect(await f.store.settle(f.context, { kind: "failed", code: "vision_analysis_provider_failed" }, { inputTokens: 4 }, true, signal))
      .toEqual({ kind: "unknown" });
    expect(await f.db.knowledgeImageObservation.findUniqueOrThrow({ where: { modelRunId: f.context.runId } }))
      .toMatchObject({ state: "ambiguous", failureCode: "vision_analysis_provider_failed" });
    expect(await f.store.load(f.context)).toEqual({ kind: "unknown" });
    expect(await f.db.usageEvent.findUniqueOrThrow({ where: { knowledgeImageObservationRunId: f.context.runId } }))
      .toMatchObject({ inputTokens: 4 });

    const stopped = await createFixture(f.db);
    const stoppedDestination = (await stopped.store.destination(stopped.context, stopped.plan))!;
    await stopped.store.dispatch(stopped.context, stoppedDestination, json(images));
    await f.db.modelRun.update({ where: { id: stopped.context.runId }, data: { status: "cancelled" } });
    expect(await stopped.store.settle(stopped.context, { kind: "observed", observation: { text: "Late success.", truncated: false } },
      { inputTokens: 5, outputTokens: 1 }, false, signal)).toEqual({ kind: "failed", code: "vision_analysis_cancelled" });
    expect(await f.db.usageEvent.findUniqueOrThrow({ where: { knowledgeImageObservationRunId: stopped.context.runId } }))
      .toMatchObject({ inputTokens: 5, outputTokens: 1 });
    expect(JSON.stringify(await f.db.knowledgeImageObservation.findUniqueOrThrow({ where: { modelRunId: stopped.context.runId } })))
      .not.toContain("Late success.");
  }));

  it("binds each route only to its own frozen destination and refuses a revoked credential before claiming", async () => fixture(async f => {
    expect(await f.store.destination(f.context, f.plan)).toMatchObject({ bindingKey: "vision_analysis" });
    expect(await f.store.destination(f.context, { version: 1, route: "answer_model", imageIds: f.plan.imageIds }))
      .toMatchObject({ bindingKey: "answer", reasoningEffort: null });
    // An answer binding without verified image input never describes images.
    const textOnly = { ...f.plan.vision.snapshot, model: { ...f.plan.vision.snapshot.model,
      capabilities: { ...f.plan.vision.snapshot.model.capabilities, vision: false } } };
    await f.db.providerRunBinding.updateMany({ where: { modelRunId: f.context.runId, bindingKey: "answer" }, data: { executionSnapshot: json(textOnly) } });
    expect(await f.store.destination(f.context, { version: 1, route: "answer_model", imageIds: f.plan.imageIds })).toBeNull();
    // A System Vision plan that differs from the run's binding is not this run's destination.
    expect(await f.store.destination(f.context, { ...f.plan, vision: { ...f.plan.vision,
      snapshot: { ...f.plan.vision.snapshot, modelDisplayName: "Changed" } } })).toBeNull();
    const destination = (await f.store.destination(f.context, f.plan))!;
    await f.db.providerCredentialVersion.update({ where: { id: f.plan.vision.authority.credentialVersionId }, data: { revokedAt: new Date() } });
    await expect(f.store.dispatch(f.context, destination, json(images))).rejects.toThrow("vision_model_unavailable");
    expect(await f.db.knowledgeImageObservation.count({ where: { modelRunId: f.context.runId } })).toBe(0);
    expect(await f.db.usageEvent.count({ where: { modelRunId: f.context.runId } })).toBe(0);
  }));

  it("describes the owner's conversation image once through the service and never after a crash", async () => fixture(async f => {
    const storage = createMemoryStorageAdapter();
    const png = await sharp({ create: { width: 3, height: 2, channels: 3, background: "#ff0000" } }).png().toBuffer();
    await storage.putObject({ storageKey: `synthetic-knowledge-image/${f.attachmentId}`, contentType: "image/png", body: png });
    await f.db.attachment.create({ data: { id: f.attachmentId, userId: f.context.userId, chatId: f.context.chatId, kind: "image",
      mimeType: "image/png", fileName: "poster.png", storageKey: `synthetic-knowledge-image/${f.attachmentId}`,
      checksum: createHash("sha256").update(png).digest("hex"), byteSize: png.byteLength, status: "ready", metadata: {} } });
    const execute = vi.fn<ReturnType<typeof createAcceptedProviderRequestExecutor>>().mockResolvedValue({
      finalText: "A red rectangle with no headline.", finalProviderResponsePreview: {}, usage: { inputTokens: 8, outputTokens: 3 } });
    const service = createVisionAnalysisService(f.db, {} as unknown as ReturnType<typeof createWorkspaceSelectedCaptures>,
      { execute, conversationImages: createConversationImageSource(f.db, storage), knowledgeObservationStore: f.store });
    const input = { plan: f.plan, question, runId: f.context.runId, userId: f.context.userId, chatId: f.context.chatId,
      authorize: async () => true, signal: new AbortController().signal };
    expect(await service.observeKnowledgeImages(input)).toEqual({ kind: "observed",
      observation: { text: "A red rectangle with no headline.", truncated: false } });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![1].attachments).toEqual([expect.objectContaining({ mimeType: "image/png" })]);
    expect(await f.db.knowledgeImageObservation.findUniqueOrThrow({ where: { modelRunId: f.context.runId } })).toMatchObject({
      state: "settled", requestHash: f.context.requestHash,
      images: [expect.objectContaining({ source: expect.objectContaining({ attachmentId: f.attachmentId }) })] });
    expect(await f.db.usageEvent.findMany({ where: { modelRunId: f.context.runId } }))
      .toEqual([expect.objectContaining({ visionAnalysis: true, inputTokens: 8, outputTokens: 3 })]);
    // Recovery reuses the settled description without reading pixels or dispatching.
    expect(await service.observeKnowledgeImages(input)).toMatchObject({ kind: "observed" });
    expect(execute).toHaveBeenCalledOnce();

    // A process lost between the claim and settlement leaves only the claim: never sent again.
    const crashed = await createFixture(f.db);
    const crashedDestination = (await crashed.store.destination(crashed.context, crashed.plan))!;
    await crashed.store.dispatch(crashed.context, crashedDestination, json(images));
    expect(await service.observeKnowledgeImages({ ...input, plan: crashed.plan, runId: crashed.context.runId,
      userId: crashed.context.userId, chatId: crashed.context.chatId })).toEqual({ kind: "unknown" });
    expect(execute).toHaveBeenCalledOnce();
  }));

  it("enforces the stored contract and removes the private result with its run", async () => fixture(async f => {
    const destination = (await f.store.destination(f.context, f.plan))!;
    await f.store.dispatch(f.context, destination, json(images));
    // Only the three states exist; the refused write rolls back to its savepoint, not the fixture.
    await f.db.$executeRawUnsafe("SAVEPOINT knowledge_image_state");
    await expect(f.db.$executeRawUnsafe(`UPDATE "KnowledgeImageObservation" SET "state" = 'replayed' WHERE "modelRunId" = $1`, f.context.runId))
      .rejects.toThrow();
    await f.db.$executeRawUnsafe("ROLLBACK TO SAVEPOINT knowledge_image_state");
    // The receipt never becomes run answer usage, which run settlement re-records.
    await f.db.$executeRawUnsafe("SAVEPOINT knowledge_image_receipt");
    await expect(f.db.$executeRawUnsafe(`UPDATE "UsageEvent" SET "visionAnalysis" = false WHERE "knowledgeImageObservationRunId" = $1`,
      f.context.runId)).rejects.toThrow();
    await f.db.$executeRawUnsafe("ROLLBACK TO SAVEPOINT knowledge_image_receipt");
    const receipt = await f.db.usageEvent.findUniqueOrThrow({ where: { knowledgeImageObservationRunId: f.context.runId } });
    // Run deletion cascades through the run and its bindings in either order; accounting stays, detached.
    await f.db.modelRun.delete({ where: { id: f.context.runId } });
    await f.db.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
    expect(await f.db.knowledgeImageObservation.count({ where: { modelRunId: f.context.runId } })).toBe(0);
    expect(await f.db.usageEvent.findUniqueOrThrow({ where: { id: receipt.id } }))
      .toMatchObject({ modelRunId: null, knowledgeImageObservationRunId: null, visionAnalysis: true });
  }));
});
