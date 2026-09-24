import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { lockRunSettlementScope } from "../runs/prismaRepositoryShared";
import { prisma } from "../prisma";
import { createVisionAnalysisStore } from "./store";
import type { AvailableVisionAnalysisPlan } from "../providerRuntime/visionAnalysis";
import type { ToolExecutionResult } from "../tools/types";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import { persistCompletedAnswerUsage } from "../runs/prismaRepositoryAnswer";
import { DEFAULT_AGENT_POLICY } from "@/lib/contracts/agentPolicy";
import { agentLimits } from "../agents/config";
import { agentTokenHash, createAgentRunStore } from "../agents/store";
import { createAgentBuiltinDispatcher } from "../agents/builtinTools";
import type { NormalizedRunRequest } from "../providers/types";
import type { createWorkspaceSelectedCaptures } from "../workspace/selectedCapture";
import type { createAcceptedProviderRequestExecutor } from "../providerRuntime/acceptedRequestExecutor";
import { createVisionAnalysisService } from "./service";
import { hashCanonicalMcpValue } from "../mcp/definitions";

afterAll(() => prisma.$disconnect());
const json = (value: unknown) => value as Prisma.InputJsonValue;
async function createFixture(db: PrismaClient) {
  const user = await db.user.create({ data: { id: randomUUID(), displayName: "Synthetic Vision owner", status: "active" } });
  const connectionConfig = { apiRoot: "https://vision-fixture.example.test/v1", authenticationMode: "bearer" as const, allowPrivateNetwork: false, responseTimeoutMs: 5000 };
  const connection = await db.providerConnection.create({ data: { id: randomUUID(), displayName: "Synthetic Vision", family: "openai_compatible", enabled: true, activeVersion: 1, activatedAt: new Date(), activeConfig: connectionConfig } });
  const credential = await db.providerCredential.create({ data: { id: randomUUID(), connectionId: connection.id, label: "Synthetic", enabled: true } });
  const version = await db.providerCredentialVersion.create({ data: { id: randomUUID(), credentialId: credential.id, version: 1, secretEnvelope: "synthetic-not-dispatched", testEvidence: {}, testedAt: new Date(), activatedAt: new Date() } });
  const modelConfig = { adapterKind: "openai_responses_compatible" as const, modelClass: "answer" as const, upstreamModelId: "vision", answerSelectable: true, defaultParams: {},
    capabilities: { vision: true, nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, streaming: true } };
  const model = await db.providerModel.create({ data: { id: randomUUID(), connectionId: connection.id, provider: "openai_compatible", modelId: "vision", modelClass: "answer", displayName: "Vision",
    activeConfig: modelConfig, activeVersion: 1, activatedAt: new Date(), capabilities: modelConfig.capabilities, defaultParams: {}, inputTokenPriceMicros: 1, outputTokenPriceMicros: 2 } });
  const plan: AvailableVisionAnalysisPlan = { version: 1, available: true, policyVersion: 1, reasoningEffort: null, verifiedVisionInput: true,
    authority: { connectionId: connection.id, providerModelId: model.id, credentialId: credential.id, credentialVersionId: version.id, modelVersion: 1, connectionVersion: 1 },
    snapshot: { version: 1, connectionId: connection.id, providerModelId: model.id, credentialId: credential.id, credentialVersionId: version.id,
      connectionDisplayName: "Synthetic Vision", modelDisplayName: "Vision", providerFamily: "openai_compatible", connection: connectionConfig, model: modelConfig } };
  const chat = await db.chat.create({ data: { id: randomUUID(), userId: user.id, title: "Synthetic Vision", memoryMode: "EXCLUDED" } });
  const message = await db.message.create({ data: { id: randomUUID(), chatId: chat.id, role: "user", content: {} } });
  const run = await db.modelRun.create({ data: { id: randomUUID(), chatId: chat.id, userId: user.id, userMessageId: message.id, provider: "fake", modelId: "text-only",
    status: "streaming", normalizedRequest: {} } });
  await db.providerRunBinding.create({ data: { id: randomUUID(), modelRunId: run.id, bindingKey: "vision_analysis", role: "vision_analysis", credentialSource: "default",
    connectionId: connection.id, providerModelId: model.id, credentialId: credential.id, credentialVersionId: version.id, executionSnapshot: json(plan.snapshot) } });
  const call = { id: randomUUID(), name: "analyze_image", arguments: {} };
  const tool = await db.modelRunToolCall.create({ data: { id: randomUUID(), modelRunId: run.id, providerCallId: call.id, toolName: call.name, arguments: {}, roundIndex: 0, ordinal: 0, state: "running" } });
  const context = { call, runId: run.id, userId: user.id, chatId: chat.id, toolCallId: tool.id, requestHash: "a".repeat(64) };
  const result: ToolExecutionResult = { callId: call.id, name: call.name, status: "complete", content: [{ type: "json", value: { analysis: "Red square", provenance: "System Vision Model" } }] };
  return { db, context, plan, result, store: createVisionAnalysisStore(db) };
}
type Fixture = Awaited<ReturnType<typeof createFixture>>;
async function fixture(check: (f: Fixture) => Promise<void>) {
  const rollback = new Error("vision_fixture_rollback");
  try { await prisma.$transaction(async tx => {
    const db = new Proxy(tx, { get(target, property) { return property === "$transaction"
      ? (operation: (client: Prisma.TransactionClient) => unknown) => operation(tx) : Reflect.get(target, property); } }) as unknown as PrismaClient;
    await check(await createFixture(db));
    await db.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
    throw rollback;
  }, { timeout: 30_000 }); } catch (error) { if (error !== rollback) throw error; }
}
async function committedFixture(check: (f: Fixture) => Promise<void>) {
  const created = await prisma.$transaction(tx => createFixture(tx as unknown as PrismaClient));
  const f = { ...created, db: prisma, store: createVisionAnalysisStore(prisma) };
  let checkFailed = false;
  let checkFailure: unknown;
  try { await check(f); }
  catch (error) { checkFailed = true; checkFailure = error; }
  try {
    // Only this synthetic aggregate; no global reset or persistent provider mutation.
    await prisma.$transaction(async tx => {
      // Session→chat and binding→session are RESTRICT. Delete this exact
      // run first (cascading its Agent/Workspace bindings), then its session.
      await tx.modelRun.deleteMany({ where: { id: f.context.runId, userId: f.context.userId, chatId: f.context.chatId } });
      await tx.workspaceSession.deleteMany({ where: { chatId: f.context.chatId } });
      await tx.chat.deleteMany({ where: { id: f.context.chatId } });
      await tx.usageEvent.deleteMany({ where: { userId: f.context.userId } });
      await tx.providerModel.delete({ where: { id: f.plan.authority.providerModelId } });
      await tx.providerCredentialVersion.delete({ where: { id: f.plan.authority.credentialVersionId } });
      await tx.providerCredential.delete({ where: { id: f.plan.authority.credentialId } });
      await tx.providerConnection.delete({ where: { id: f.plan.authority.connectionId } });
      await tx.user.delete({ where: { id: f.context.userId } });
    });
  } catch (cleanupFailure) {
    if (checkFailed) throw new AggregateError([checkFailure, cleanupFailure], "vision_fixture_check_and_cleanup_failed", { cause: checkFailure });
    throw cleanupFailure;
  }
  if (checkFailed) throw checkFailure;
}

const inputs = [{ version: 1, checksum: "b".repeat(64), source: { captureId: "synthetic", relativePath: "project/image.png" } }];
describe("durable auxiliary Vision accounting", () => {
  it("dispatches native System Vision through the real Agent claim and hooks, then restores without another charge", async () => committedFixture(async f => {
    // The ordinary fixture already has a running call. Native delivery must
    // create its own hash-only pending call through the real Agent store.
    await f.db.modelRunToolCall.delete({ where: { id: f.context.toolCallId } });
    const session = await f.db.workspaceSession.create({ data: {
      chatId: f.context.chatId, sandboxName: `native-vision-${randomUUID()}`, imageRef: "aiqsa-workspace:0.1.28",
      internetEnabled: false, policyRevision: 1, state: "RUNNING", runtimeSandboxId: "synthetic-capture-runtime",
      operationOwner: `run:${f.context.runId}`, version: 1, expiresAt: new Date(Date.now() + 600000)
    } });
    const outputDirectory = `/workspace/output/${f.context.runId}`;
    await f.db.workspaceRunBinding.create({ data: { modelRunId: f.context.runId, workspaceSessionId: session.id,
      imageRef: session.imageRef, internetEnabled: false, policyRevision: 1, runtimeVersion: "0.6.16", mcpVersion: "0.6.16",
      toolCatalogHash: "a".repeat(64), toolDefinitions: [{ originalName: "sandbox_exec_start",
        namespacedName: "workspace__sandbox_exec_start", description: "Synthetic native runner", inputSchema: { type: "object" } }], outputDirectory } });
    const configuration = { ...agentLimits({ ...DEFAULT_AGENT_POLICY, limitsEnabled: true }, { AIQSA_AGENT_GATEWAY_URL: "http://agent.invalid" }),
      compatibilityHash: "a".repeat(64), mcpMode: "off" as const };
    await f.db.agentRunBinding.create({ data: { modelRunId: f.context.runId, configuration,
      compatibilityHash: configuration.compatibilityHash } });
    const owner = createAgentRunStore(f.db, { runId: f.context.runId, userId: f.context.userId, configuration });
    const grant = await owner.arm(null);
    const agent = createAgentRunStore(f.db, { runId: f.context.runId, userId: f.context.userId,
      configuration, tokenHash: agentTokenHash(grant.token) });
    const call = { id: randomUUID(), name: "analyze_image", arguments: {
      images: [{ path: "/workspace/project/image.png" }], question: "What color is the square?"
    } };
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#ff0000" } }).png().toBuffer();
    const captureId = "c".repeat(32);
    const captures = {
      create: vi.fn(async () => ({ id: captureId })),
      imageSource: vi.fn(async () => ({ captureId, relativePath: "project/image.png", byteSize: bytes.length,
        checksum: createHash("sha256").update(bytes).digest("hex"), assertAccess: async () => {},
        open: async () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) })),
      release: vi.fn(async () => {})
    };
    const execute = vi.fn<ReturnType<typeof createAcceptedProviderRequestExecutor>>().mockImplementation(async () => {
      // A provider may run only after the actual Agent pending→running hook
      // and auxiliary dispatch/accounting have committed on PostgreSQL.
      const tool = await f.db.modelRunToolCall.findFirstOrThrow({ where: { modelRunId: f.context.runId, providerCallId: call.id } });
      expect(tool).toMatchObject({ state: "running", arguments: { argumentHash: hashCanonicalMcpValue(call.arguments) } });
      expect(await f.db.visionAnalysisAttempt.findUnique({ where: { toolCallId: tool.id } })).toMatchObject({ state: "dispatched" });
      expect(await f.db.usageEvent.findUnique({ where: { visionAnalysisAttemptId: tool.id } }))
        .toMatchObject({ visionAnalysis: true, inputTokens: null });
      return { finalText: "A red square.", finalProviderResponsePreview: {}, usage: { inputTokens: 7, outputTokens: 2 } };
    });
    const beforeDispatch = vi.spyOn(agent, "startBuiltinVision");
    const dispatchAttempt = vi.spyOn(f.store, "dispatch");
    const service = createVisionAnalysisService(f.db, captures as unknown as ReturnType<typeof createWorkspaceSelectedCaptures>, { execute, store: f.store });
    const request = { chatId: f.context.chatId, agent: configuration, visionAnalysis: f.plan,
      workspace: { outputDirectory }, toolMode: "auto" } as unknown as NormalizedRunRequest;
    const dispatch = createAgentBuiltinDispatcher({ request, runId: f.context.runId, userId: f.context.userId, store: agent, vision: service });
    const signal = AbortSignal.timeout(15000);
    const result = await dispatch(call, signal);
    expect(beforeDispatch).toHaveBeenCalledOnce();
    await expect(beforeDispatch.mock.results[0]!.value).resolves.toBeUndefined();
    expect(dispatchAttempt).toHaveBeenCalledOnce();
    await expect(dispatchAttempt.mock.results[0]!.value).resolves.toEqual({ result: null });
    expect(result).toMatchObject({ callId: call.id, name: "analyze_image", status: "complete" });
    expect(JSON.stringify(result)).toContain("A red square.");
    expect(execute).toHaveBeenCalledOnce();
    const tool = await f.db.modelRunToolCall.findFirstOrThrow({ where: { modelRunId: f.context.runId, providerCallId: call.id } });
    expect(tool.state).toBe("complete");
    expect(await f.db.visionAnalysisAttempt.findMany({ where: { modelRunId: f.context.runId } }))
      .toEqual([expect.objectContaining({ toolCallId: tool.id, state: "settled", requestHash: hashCanonicalMcpValue(call.arguments) })]);
    expect(await f.db.usageEvent.findMany({ where: { modelRunId: f.context.runId } }))
      .toEqual([expect.objectContaining({ visionAnalysis: true, providerModelId: f.plan.authority.providerModelId,
        inputTokens: 7, outputTokens: 2, totalTokens: 9, usageCompleteness: "COMPLETE" })]);
    expect(await dispatch(call, signal)).toEqual(result);
    expect(execute).toHaveBeenCalledOnce();
    expect(captures.create).toHaveBeenCalledOnce();
    expect(captures.release).toHaveBeenCalledOnce();
    expect(await f.db.agentRunBinding.findUnique({ where: { modelRunId: f.context.runId } }))
      .toMatchObject({ toolCalls: 1, modelCalls: 0 });
  }));

  it("rolls back failed local publication, settles the same receipt once, and detaches accounting on chat deletion", async () => committedFixture(async f => {
    await f.store.dispatch(f.context, f.plan, inputs);
    const usage = { inputTokens: 7, outputTokens: 2 };
    await expect(f.store.settle(f.context, f.result, usage, false, {
      onResult: async () => { throw new Error("synthetic local publication failure"); }
    })).rejects.toThrow("synthetic local publication failure");
    expect(await f.db.visionAnalysisAttempt.findUnique({ where: { toolCallId: f.context.toolCallId } }))
      .toMatchObject({ state: "dispatched", result: null });
    const receipt = await f.db.usageEvent.findUniqueOrThrow({ where: { visionAnalysisAttemptId: f.context.toolCallId } });
    expect(receipt).toMatchObject({ inputTokens: null, outputTokens: null });
    await expect(f.db.usageEvent.update({ where: { id: receipt.id }, data: { visionAnalysis: false } })).rejects.toThrow();
    expect(await f.store.settle(f.context, f.result, usage, false)).toEqual(f.result);
    expect(await f.db.usageEvent.count({ where: { modelRunId: f.context.runId } })).toBe(1);
    const settledReceipt = await f.db.usageEvent.findUniqueOrThrow({ where: { id: receipt.id } });
    await f.db.$transaction(async tx => {
      await lockRunSettlementScope(tx, f.context.runId);
      await persistCompletedAnswerUsage(tx, { ...f.context, assistantMessageId: "unused-by-accounting",
        finalText: "Synthetic answer", provider: "fake", modelId: "text-only", estimatedCostMicros: null,
        usage: { inputTokens: 11, outputTokens: 3 } }, null);
    });
    expect(await f.db.usageEvent.findUnique({ where: { id: receipt.id } })).toEqual(settledReceipt);
    expect(await f.db.usageEvent.findMany({ where: { modelRunId: f.context.runId, visionAnalysis: false } }))
      .toEqual([expect.objectContaining({ provider: "fake", modelId: "text-only", inputTokens: 11, outputTokens: 3 })]);
    await f.db.chat.delete({ where: { id: f.context.chatId } });
    expect(await f.db.usageEvent.findUnique({ where: { id: receipt.id } })).toMatchObject({
      visionAnalysis: true, visionAnalysisAttemptId: null, modelRunId: null, chatId: f.context.chatId, inputTokens: 7, outputTokens: 2
    });
  }));

  it("suppresses a late success after owner access is revoked while retaining received usage", async () => fixture(async f => {
    await f.store.dispatch(f.context, f.plan, inputs);
    await f.db.user.update({ where: { id: f.context.userId }, data: { status: "disabled" } });
    const onResult = vi.fn(async () => undefined);
    expect(JSON.stringify(await f.store.settle(f.context, f.result, { inputTokens: 6, outputTokens: 1 }, false, { onResult })))
      .toContain("vision_analysis_cancelled");
    expect(onResult).not.toHaveBeenCalled();
    expect(await f.db.usageEvent.findUnique({ where: { visionAnalysisAttemptId: f.context.toolCallId } }))
      .toMatchObject({ inputTokens: 6, outputTokens: 1 });
    await expect(f.store.restore(f.context)).rejects.toMatchObject({ code: "vision_analysis_access_denied" });
  }));

  it("arbitrates concurrent dispatch and settlement through independent transactions", async () => committedFixture(async f => {
    const claims = await Promise.all([f.store.dispatch(f.context, f.plan, inputs), f.store.dispatch(f.context, f.plan, inputs)]);
    expect(claims.filter(claim => claim.result === null)).toHaveLength(1);
    expect(JSON.stringify(claims.find(claim => claim.result)?.result)).toContain("vision_analysis_outcome_unknown");
    const onResult = vi.fn(async () => undefined);
    await Promise.all([
      f.store.settle(f.context, f.result, { inputTokens: 3, outputTokens: 2 }, false, { onResult }),
      f.store.settle(f.context, f.result, { inputTokens: 30, outputTokens: 20 }, false, { onResult })
    ]);
    expect(onResult).toHaveBeenCalledOnce();
    expect(await f.db.visionAnalysisAttempt.count({ where: { modelRunId: f.context.runId } })).toBe(1);
    const receipts = await f.db.usageEvent.findMany({ where: { modelRunId: f.context.runId } });
    expect(receipts).toHaveLength(1);
    expect([[3, 2], [30, 20]]).toContainEqual([receipts[0]!.inputTokens, receipts[0]!.outputTokens]);
    expect(await f.store.restore(f.context)).toEqual(f.result);
  }));

  it("lets Stop win a settlement race while retaining received Vision usage", async () => committedFixture(async f => {
    await f.store.dispatch(f.context, f.plan, inputs);
    let locked!: () => void, release!: () => void;
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const stopping = f.db.$transaction(async tx => {
      await lockRunSettlementScope(tx, f.context.runId);
      await tx.modelRun.update({ where: { id: f.context.runId }, data: { status: "cancelled" } });
      locked();
      await released;
    });
    await acquired;
    const onResult = vi.fn(async () => undefined);
    const settlement = f.store.settle(f.context, f.result, { inputTokens: 4, outputTokens: 1 }, false, { onResult });
    release();
    const [, result] = await Promise.all([stopping, settlement]);
    expect(JSON.stringify(result)).toContain("vision_analysis_cancelled");
    expect(onResult).not.toHaveBeenCalled();
    expect(await f.db.usageEvent.findUnique({ where: { visionAnalysisAttemptId: f.context.toolCallId } })).toMatchObject({ inputTokens: 4, outputTokens: 1 });
    await expect(f.store.dispatch(f.context, f.plan, inputs)).rejects.toThrow("vision_analysis_cancelled");
  }));

  it("claims once, preserves unknown receipt, restores a settled result and attributes usage only to Vision", async () => fixture(async f => {
    expect(await f.store.dispatch(f.context, f.plan, inputs)).toEqual({ result: null });
    expect(JSON.stringify((await f.store.dispatch(f.context, f.plan, inputs)).result)).toContain("vision_analysis_outcome_unknown");
    const unknown = await f.db.usageEvent.findUniqueOrThrow({ where: { visionAnalysisAttemptId: f.context.toolCallId } });
    expect(unknown).toMatchObject({ visionAnalysis: true, providerModelId: f.plan.authority.providerModelId, inputTokens: null, usageCompleteness: "UNAVAILABLE" });
    expect(await f.store.settle(f.context, f.result, { inputTokens: 3, outputTokens: 2 }, false)).toEqual(f.result);
    expect(await f.store.settle(f.context, f.result, { inputTokens: 30, outputTokens: 20 }, false)).toEqual(f.result);
    expect(await f.store.restore(f.context)).toEqual(f.result);
    expect(await f.db.usageEvent.count({ where: { modelRunId: f.context.runId } })).toBe(1);
    expect(await f.db.usageEvent.findUnique({ where: { id: unknown.id } })).toMatchObject({ inputTokens: 3, outputTokens: 2, totalTokens: 5, usageCompleteness: "COMPLETE", estimatedCostMicros: 7 });
    expect(await createPrismaRunRepository(f.db).loadRunUsageAttributions({ runId: f.context.runId, userId: f.context.userId })).toEqual([]);
  }));
  it("settles received usage after Stop without publishing success or permitting another dispatch", async () => fixture(async f => {
    await f.store.dispatch(f.context, f.plan, inputs);
    await f.db.modelRun.update({ where: { id: f.context.runId }, data: { status: "cancelled" } });
    expect(JSON.stringify(await f.store.settle(f.context, f.result, { inputTokens: 4, outputTokens: 1 }, false))).toContain("vision_analysis_cancelled");
    expect(await f.db.usageEvent.findUnique({ where: { visionAnalysisAttemptId: f.context.toolCallId } })).toMatchObject({ inputTokens: 4, outputTokens: 1 });
    await expect(f.store.dispatch(f.context, f.plan, inputs)).rejects.toThrow("vision_analysis_cancelled");
  }));
  it("rejects exact credential revoke and changed call identity before a new dispatch", async () => fixture(async f => {
    await f.db.providerCredentialVersion.update({ where: { id: f.plan.authority.credentialVersionId }, data: { revokedAt: new Date() } });
    await expect(f.store.dispatch(f.context, f.plan, inputs)).rejects.toThrow("vision_model_unavailable");
    expect(await f.db.usageEvent.count({ where: { modelRunId: f.context.runId } })).toBe(0);
  }));
  it("does not retarget a pinned role when the administrator changes policy", async () => fixture(async f => {
    await f.db.systemModelPolicy.upsert({ where: { id: "installation" }, create: { id: "installation", visionProviderModelId: null, visionReasoningEffort: null }, update: { visionProviderModelId: null, visionReasoningEffort: null, version: { increment: 1 } } });
    await f.store.dispatch(f.context, f.plan, inputs);
    await expect(f.store.restore({ ...f.context, requestHash: "c".repeat(64) })).rejects.toThrow("vision_analysis_input_invalid");
    expect(await f.db.usageEvent.findUnique({ where: { visionAnalysisAttemptId: f.context.toolCallId } })).toMatchObject({ providerModelId: f.plan.authority.providerModelId });
  }));
});
