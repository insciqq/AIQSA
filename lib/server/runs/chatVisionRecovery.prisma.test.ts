import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import type { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import { prisma } from "../prisma";
import { hashCanonicalMcpValue } from "../mcp/definitions";
import type { createAcceptedProviderRequestExecutor } from "../providerRuntime/acceptedRequestExecutor";
import type { AvailableVisionAnalysisPlan } from "../providerRuntime/visionAnalysis";
import type { NormalizedRunRequest, ProviderAdapter, ProviderRunRequest } from "../providers/types";
import type { ToolExecutionContext } from "../tools/types";
import { createConversationImageSource } from "../vision/conversationImages";
import { createVisionAnalysisService } from "../vision/service";
import { createVisionAnalysisStore } from "../vision/store";
import type { createWorkspaceSelectedCaptures } from "../workspace/selectedCapture";
import { createMemoryStorageAdapter } from "../../../tests/support/storage";
import { conversationContextPolicy } from "./contextCompactionContract";
import { createPrismaRunRepository } from "./prismaRepository";
import { refreshProviderRunIfNeeded, type RunRecoveryDeps } from "./runRecovery";
import { INITIAL_PROVIDER_CONTINUATION } from "./toolLoopPersistence";

afterAll(() => prisma.$disconnect());
const json = (value: unknown) => value as Prisma.InputJsonValue;

/**
 * A non-Workspace run of an answer model without vision, accepted with chat
 * System Vision, whose executor was lost inside its analyze_image batch. The
 * real recovery entry point resumes it against the real run repository.
 */
async function withChatVisionRun(check: (f: Awaited<ReturnType<typeof createChatVisionRun>>) => Promise<void>) {
  const f = await createChatVisionRun();
  let checkFailure: unknown;
  let checkFailed = false;
  try { await check(f); } catch (error) { checkFailed = true; checkFailure = error; }
  try {
    // Only this synthetic aggregate; no global reset or persistent provider mutation.
    await prisma.$transaction(async tx => {
      await tx.modelRun.deleteMany({ where: { id: f.runId, userId: f.userId, chatId: f.chatId } });
      await tx.chat.deleteMany({ where: { id: f.chatId, userId: f.userId } });
      await tx.usageEvent.deleteMany({ where: { userId: f.userId } });
      await tx.providerModel.deleteMany({ where: { id: f.plan.authority.providerModelId } });
      await tx.providerCredentialVersion.deleteMany({ where: { id: f.plan.authority.credentialVersionId } });
      await tx.providerCredential.deleteMany({ where: { id: f.plan.authority.credentialId } });
      await tx.providerConnection.deleteMany({ where: { id: f.plan.authority.connectionId } });
      await tx.user.deleteMany({ where: { id: f.userId } });
    });
  } catch (cleanupFailure) {
    if (checkFailed) throw new AggregateError([checkFailure, cleanupFailure], "chat_vision_fixture_check_and_cleanup_failed", { cause: checkFailure });
    throw cleanupFailure;
  }
  if (checkFailed) throw checkFailure;
}

async function createChatVisionRun() {
  const userId = randomUUID();
  await prisma.user.create({ data: { id: userId, displayName: "Synthetic chat Vision owner", status: "active" } });
  const connectionConfig = { apiRoot: "https://chat-vision-fixture.example.test/v1", authenticationMode: "bearer" as const, allowPrivateNetwork: false, responseTimeoutMs: 5000 };
  const connection = await prisma.providerConnection.create({ data: { id: randomUUID(), displayName: "Synthetic chat Vision", family: "openai_compatible",
    enabled: true, activeVersion: 1, activatedAt: new Date(), activeConfig: connectionConfig } });
  const credential = await prisma.providerCredential.create({ data: { id: randomUUID(), connectionId: connection.id, label: "Synthetic", enabled: true } });
  const version = await prisma.providerCredentialVersion.create({ data: { id: randomUUID(), credentialId: credential.id, version: 1,
    secretEnvelope: "synthetic-not-dispatched", testEvidence: {}, testedAt: new Date(), activatedAt: new Date() } });
  const modelConfig = { adapterKind: "openai_responses_compatible" as const, modelClass: "answer" as const, upstreamModelId: "chat-vision-analyst",
    answerSelectable: true, defaultParams: {}, capabilities: { vision: true, nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, streaming: true } };
  const model = await prisma.providerModel.create({ data: { id: randomUUID(), connectionId: connection.id, provider: "openai_compatible",
    modelId: modelConfig.upstreamModelId, modelClass: "answer", displayName: "Synthetic analyst", activeConfig: modelConfig, activeVersion: 1,
    activatedAt: new Date(), capabilities: modelConfig.capabilities, defaultParams: {}, inputTokenPriceUsdPerMillion: 1, outputTokenPriceUsdPerMillion: 2 } });
  const plan: AvailableVisionAnalysisPlan = { version: 1, available: true, policyVersion: 1, reasoningEffort: null, verifiedVisionInput: true,
    authority: { connectionId: connection.id, providerModelId: model.id, credentialId: credential.id, credentialVersionId: version.id, modelVersion: 1, connectionVersion: 1 },
    snapshot: { version: 1, connectionId: connection.id, providerModelId: model.id, credentialId: credential.id, credentialVersionId: version.id,
      connectionDisplayName: "Synthetic chat Vision", modelDisplayName: "Synthetic analyst", providerFamily: "openai_compatible",
      connection: connectionConfig, model: modelConfig } };

  const storage = createMemoryStorageAdapter();
  const webp = await sharp({ create: { width: 4, height: 3, channels: 3, background: "#d42020" } }).webp({ lossless: true }).toBuffer();
  const attachmentId = randomUUID();
  const storageKey = `synthetic-chat-vision-recovery/${attachmentId}`;
  await storage.putObject({ storageKey, contentType: "image/webp", body: webp });
  const chat = await prisma.chat.create({ data: { id: randomUUID(), userId, title: "Synthetic chat Vision recovery", memoryMode: "EXCLUDED" } });
  const prior = await prisma.message.create({ data: { id: randomUUID(), chatId: chat.id, role: "user",
    content: { blocks: [{ type: "text", text: "Here is the photo." }, { type: "image", attachmentId }] } } });
  await prisma.attachment.create({ data: { id: attachmentId, userId, chatId: chat.id, messageId: prior.id, kind: "image", mimeType: "image/webp",
    fileName: "square.webp", storageKey, checksum: createHash("sha256").update(webp).digest("hex"), byteSize: webp.byteLength, status: "ready", metadata: {} } });
  const question = await prisma.message.create({ data: { id: randomUUID(), chatId: chat.id, parentMessageId: prior.id, role: "user",
    content: { blocks: [{ type: "text", text: "What color is the square?" }] } } });
  const answer = await prisma.message.create({ data: { id: randomUUID(), chatId: chat.id, parentMessageId: question.id, role: "assistant",
    content: { blocks: [] }, status: "streaming" } });
  await prisma.chat.update({ where: { id: chat.id }, data: { activeLeafMessageId: answer.id } });
  const normalizedRequest: NormalizedRunRequest = {
    attachmentIds: [], chatId: chat.id, content: { blocks: [{ type: "text", text: "What color is the square?" }] },
    context: { messages: [], mode: "branch_path" }, contextCompactionPolicy: conversationContextPolicy({ leafMessageId: null, messages: [] }),
    imageReferences: [{ attachmentId, messageId: prior.id, fileName: "square.webp", origin: "upload" }],
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, streaming: true, toolCalling: true, vision: false },
    modelId: "chat-vision-text-model", params: {}, prompt: { developer: null, system: "Synthetic chat System Vision recovery." },
    provider: "openai", searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto", visionAnalysis: plan
  };
  const runId = randomUUID();
  await prisma.modelRun.create({ data: { id: runId, chatId: chat.id, userId, userMessageId: question.id, assistantMessageId: answer.id,
    provider: "openai", modelId: "chat-vision-text-model", status: "streaming", normalizedRequest: json(normalizedRequest) } });
  // Admission froze exactly this Vision binding for the run.
  await prisma.providerRunBinding.create({ data: { id: randomUUID(), modelRunId: runId, bindingKey: "vision_analysis", role: "vision_analysis",
    credentialSource: "default", connectionId: connection.id, providerModelId: model.id, credentialId: credential.id,
    credentialVersionId: version.id, executionSnapshot: json(plan.snapshot) } });

  const repository = createPrismaRunRepository(prisma);
  const callId = `call_${randomUUID()}`;
  const callArguments = { images: [{ image_id: attachmentId }], question: "What color is the square?" };
  await expect(repository.beginToolLoopProviderRound({ providerContinuation: INITIAL_PROVIDER_CONTINUATION, roundIndex: 1, runId, userId }))
    .resolves.toBe("started");
  const batch = await repository.persistToolLoopCallBatch({
    calls: [{ arguments: callArguments, ordinal: 0, providerCallId: callId, toolName: "analyze_image" }],
    providerContinuation: { providerResponseId: "response-chat-vision-1", providerToolMessages: [{
      type: "function_call", call_id: callId, name: "analyze_image", arguments: JSON.stringify(callArguments) }] },
    roundIndex: 1, runId, userId
  });
  if (batch.kind !== "persisted") throw new Error(`chat_vision_batch_${batch.kind}`);
  const toolCallId = batch.calls[0]!.id;

  const visionExecute = vi.fn<ReturnType<typeof createAcceptedProviderRequestExecutor>>().mockResolvedValue({
    finalText: "A red square.", finalProviderResponsePreview: {}, usage: { inputTokens: 7, outputTokens: 2 } });
  const store = createVisionAnalysisStore(prisma);
  const vision = createVisionAnalysisService(prisma, {} as unknown as ReturnType<typeof createWorkspaceSelectedCaptures>,
    { execute: visionExecute, store, conversationImages: createConversationImageSource(prisma, storage) });
  const answerRequests: ProviderRunRequest[] = [];
  const adapter: ProviderAdapter = {
    buildRequestPreview: () => ({}),
    async *stream(request) {
      answerRequests.push(request);
      return { finalText: "The square is red.", finalProviderResponsePreview: {}, providerResponseId: "response-chat-vision-2",
        usage: { inputTokens: 11, outputTokens: 4 } };
    }
  };
  const deps: RunRecoveryDeps = {
    providers: { openai: adapter },
    registry: { has: () => false, ids: () => [], register: () => ({ release() {}, signal: new AbortController().signal }) },
    repository,
    vision
  };
  const call = { id: callId, name: "analyze_image", arguments: callArguments };
  const executorContext: ToolExecutionContext = { persistedToolCallId: toolCallId, runId, userId,
    request: { ...normalizedRequest, attachments: [] } };
  return { answerId: answer.id, answerRequests, attachmentId, call, chatId: chat.id, deps, executorContext, plan, repository, runId,
    store, toolCallId, userId, vision, visionExecute };
}

async function settledRun(runId: string) {
  return prisma.modelRun.findUniqueOrThrow({ where: { id: runId }, select: { status: true,
    toolCalls: { select: { id: true, state: true, result: true } }, assistantMessage: { select: { content: true, status: true } } } });
}

describe("chat System Vision recovery after executor loss", () => {
  it("resumes a pending analysis once through the frozen Vision binding and completes the answer", async () => withChatVisionRun(async f => {
    await refreshProviderRunIfNeeded(f.deps, f.runId, f.userId);

    expect(f.visionExecute).toHaveBeenCalledOnce();
    expect(f.visionExecute.mock.calls[0]![0]).toEqual(f.plan.snapshot);
    expect(f.visionExecute.mock.calls[0]![1].attachments).toEqual([expect.objectContaining({ mimeType: "image/png" })]);
    const run = await settledRun(f.runId);
    expect(run.status).toBe("complete");
    expect(run.toolCalls).toEqual([expect.objectContaining({ id: f.toolCallId, state: "complete" })]);
    expect(JSON.stringify(run.toolCalls[0]!.result)).toContain("A red square.");
    expect(textFromContentBlocks(run.assistantMessage!.content as { blocks: unknown[] })).toBe("The square is red.");
    expect(await prisma.visionAnalysisAttempt.findMany({ where: { modelRunId: f.runId } })).toEqual([expect.objectContaining({
      toolCallId: f.toolCallId, state: "settled", requestHash: hashCanonicalMcpValue(f.call.arguments),
      images: [expect.objectContaining({ mimeType: "image/png", source: expect.objectContaining({ attachmentId: f.attachmentId, mimeType: "image/webp" }) })]
    })]);
    expect(await prisma.usageEvent.findMany({ where: { modelRunId: f.runId, visionAnalysis: true } }))
      .toEqual([expect.objectContaining({ providerModelId: f.plan.authority.providerModelId, inputTokens: 7, outputTokens: 2 })]);
    expect(f.answerRequests).toHaveLength(1);
    expect(f.answerRequests[0]!.workspace).toBeUndefined();
    expect(f.answerRequests[0]!.tools?.find(tool => tool.name === "analyze_image")).toMatchObject({ capability: "vision" });
    expect(JSON.stringify(f.answerRequests[0]!.providerToolMessages)).toContain("A red square.");
  }));

  it("reuses a settled analysis without another Vision dispatch", async () => withChatVisionRun(async f => {
    // The lost executor claimed the call and settled the paid analysis, but not the call.
    await expect(f.repository.claimToolLoopCall({ callId: f.toolCallId, runId: f.runId, userId: f.userId }))
      .resolves.toMatchObject({ kind: "claimed" });
    const settled = await f.vision.execute(f.call, f.executorContext);
    expect(settled.status).toBe("complete");
    expect(f.visionExecute).toHaveBeenCalledOnce();

    await refreshProviderRunIfNeeded(f.deps, f.runId, f.userId);

    expect(f.visionExecute).toHaveBeenCalledOnce();
    const run = await settledRun(f.runId);
    expect(run.status).toBe("complete");
    expect(run.toolCalls).toEqual([expect.objectContaining({ state: "complete" })]);
    expect(JSON.stringify(run.toolCalls[0]!.result)).toContain("A red square.");
    expect(await prisma.visionAnalysisAttempt.count({ where: { modelRunId: f.runId } })).toBe(1);
    expect(await prisma.usageEvent.count({ where: { modelRunId: f.runId, visionAnalysis: true } })).toBe(1);
    expect(JSON.stringify(f.answerRequests[0]!.providerToolMessages)).toContain("A red square.");
  }));

  it("never repeats an analysis whose provider outcome is unknown", async () => withChatVisionRun(async f => {
    // The lost executor dispatched the paid analysis; its outcome was never settled.
    await expect(f.repository.claimToolLoopCall({ callId: f.toolCallId, runId: f.runId, userId: f.userId }))
      .resolves.toMatchObject({ kind: "claimed" });
    await expect(f.store.dispatch({ runId: f.runId, userId: f.userId, chatId: f.chatId, toolCallId: f.toolCallId, call: f.call,
      requestHash: hashCanonicalMcpValue(f.call.arguments) }, f.plan, [{ version: 1, source: { attachmentId: f.attachmentId } }]))
      .resolves.toEqual({ result: null });

    await refreshProviderRunIfNeeded(f.deps, f.runId, f.userId);

    expect(f.visionExecute).not.toHaveBeenCalled();
    const run = await settledRun(f.runId);
    expect(run.toolCalls).toEqual([expect.objectContaining({ state: "error" })]);
    expect(JSON.stringify(run.toolCalls[0]!.result)).toContain("vision_analysis_outcome_unknown");
    expect(await prisma.visionAnalysisAttempt.findMany({ where: { modelRunId: f.runId } }))
      .toEqual([expect.objectContaining({ state: "dispatched" })]);
    expect(await prisma.usageEvent.findMany({ where: { modelRunId: f.runId, visionAnalysis: true } }))
      .toEqual([expect.objectContaining({ inputTokens: null, usageCompleteness: "UNAVAILABLE" })]);
    expect(run.status).toBe("complete");
    expect(JSON.stringify(f.answerRequests[0]!.providerToolMessages)).toContain("vision_analysis_outcome_unknown");
  }));
});
