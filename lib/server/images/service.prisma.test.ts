import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { prisma } from "../prisma";
import { createPrismaImageGenerationService } from "./service";
import { createMemoryStorageAdapter } from "../../../tests/support/storage";
import { encryptProviderCredentialSecret } from "../providers/credentialSecrets";
import { imageModelConfiguration } from "../../domain/imageModels";
import { createImageModelRoleResolver } from "../providerRuntime/imageModelRole";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import { createPrismaAttachmentDownloadRepository } from "../uploads/downloadRepository";
import { createSavedFileRepository } from "../uploads/savedFileRepository";
import { createPrismaMessageBranchRepository } from "../messages/prismaRepository";
import { insertAcceptedProviderRunBindings } from "../runs/prismaRepositoryBindings";
import { ProviderAdmissionConflictError } from "../runs/runRepositoryContract";
import { createAdminSystemModelPolicyService } from "../admin/providers/systemModelPolicyService";
import { createUserImageModelService } from "./userImageModels";
import type { AcceptedImageGenerationPlan } from "../providerRuntime/imageModelRole";
import type { ModelToolCall, ToolExecutionContext } from "../tools/types";
import type { ProviderRunRequest } from "../providers/types";

afterAll(() => prisma.$disconnect());
const key = Buffer.alloc(32, 71);
const json = (value: unknown) => value as Prisma.InputJsonValue;

async function fixture(runTest: (fixture: {
  db: PrismaClient; userId: string; runId: string; assistantId: string; modelId: string; credentialVersionId: string;
  request: ProviderRunRequest; storage: ReturnType<typeof createMemoryStorageAdapter>;
  call(ids?: string[]): Promise<{ call: ModelToolCall; context: ToolExecutionContext }>;
  /** Another verified image model on the same key, published with the given parameters. */
  publishImageModel(upstreamModelId: string, paramsJson?: Prisma.InputJsonObject): Promise<string>;
  chooseImageModel(providerModelId: string | null): Promise<void>;
}) => Promise<void>) {
  const rollback = new Error("image_fixture_rollback");
  try { await prisma.$transaction(async (tx) => {
    const db = new Proxy(tx, { get(target, property) {
      return property === "$transaction" ? (operation: (client: Prisma.TransactionClient) => unknown) => operation(tx) : Reflect.get(target, property);
    } }) as unknown as PrismaClient;
    const user = await db.user.create({ data: { id: randomUUID(), displayName: "Image fixture", status: "active" } });
    const connectionConfig = { apiRoot: "https://image-fixture.example/v1", authenticationMode: "bearer", allowPrivateNetwork: false, responseTimeoutMs: 5000 };
    const configuration = imageModelConfiguration("gpt-image-2", { profile: "openai" });
    const connection = await db.providerConnection.create({ data: { id: randomUUID(), displayName: "Image fixture", family: "openai", enabled: true,
      activeConfig: connectionConfig, activeVersion: 1, activatedAt: new Date() } });
    const credential = await db.providerCredential.create({ data: { id: randomUUID(), connectionId: connection.id, label: "Fixture key", enabled: true } });
    const credentialVersionId = randomUUID();
    await db.providerCredentialVersion.create({ data: { id: credentialVersionId, credentialId: credential.id, version: 1,
      secretEnvelope: encryptProviderCredentialSecret({ credentialId: credential.id, valueId: credentialVersionId, key, secret: "synthetic-key" }),
      activatedAt: new Date(), testedAt: new Date(), testEvidence: { authenticationMode: "bearer" } } });
    await db.providerCredential.update({ where: { id: credential.id }, data: { activeVersionId: credentialVersionId, activatedAt: new Date() } });
    await db.providerConnection.update({ where: { id: connection.id }, data: { defaultCredentialId: credential.id } });
    const addImageModel = async (upstreamModelId: string) => {
      const modelConfiguration = imageModelConfiguration(upstreamModelId, { profile: "openai" });
      const created = await db.providerModel.create({ data: { id: randomUUID(), connectionId: connection.id, modelId: upstreamModelId, modelClass: "image",
        provider: "openai", displayName: `Image fixture ${upstreamModelId}`, capabilities: modelConfiguration.capabilities, defaultParams: {},
        activeConfig: modelConfiguration, activeVersion: 1, activatedAt: new Date() } });
      const proof = { adapterKind: modelConfiguration.adapterKind, upstreamModelId, verified: true, probeVersion: 1 };
      await db.providerModelCredentialCheck.create({ data: { connectionId: connection.id, providerModelId: created.id, connectionVersion: 1, modelVersion: 1,
        credentialId: credential.id, credentialVersionId, checkedAt: new Date(), status: "available", evidence: {
          method: "tiny_generation", selectedProviders: [], upstreamModelId, detail: "ok", imageGeneration: proof, imageEditing: proof
        } } });
      return created;
    };
    const model = await addImageModel(configuration.upstreamModelId);
    // The default is a published model and owns the administrator parameters.
    await db.publishedImageModel.create({ data: { providerModelId: model.id, paramsJson: { quality: "low" } } });
    await db.systemModelPolicy.upsert({ where: { id: "installation" }, create: { id: "installation", imageProviderModelId: model.id },
      update: { imageProviderModelId: model.id } });
    const resolved = await createImageModelRoleResolver(db).resolveFor({ kind: "project" });
    if (!resolved.ok) throw new Error("image_fixture_plan_unavailable");
    const plan = resolved.plan;
    const chat = await db.chat.create({ data: { userId: user.id, title: "Image fixture", memoryMode: "EXCLUDED" } });
    const message = await db.message.create({ data: { chatId: chat.id, role: "user", content: { blocks: [{ type: "text", text: "Create an image" }] } } });
    const assistant = await db.message.create({ data: { chatId: chat.id, parentMessageId: message.id, role: "assistant", content: { blocks: [] }, status: "streaming" } });
    await db.chat.update({ where: { id: chat.id }, data: { activeLeafMessageId: assistant.id } });
    const request: ProviderRunRequest = { attachmentIds: [], attachments: [], chatId: chat.id, content: { blocks: [] }, imagePlan: plan, imageReferences: [],
      modelId: "chat", provider: "fake", modelCapabilities: { vision: false, pdf: false, nativePdfInput: false, nativeSearch: false, reasoning: false },
      knowledgePlan: { mode: "none", baseIds: [], sourceIds: [], version: 1 }, searchPlan: { options: [], mode: "all_selected" }, params: {}, prompt: { system: null, developer: null }, toolMode: "auto" };
    const run = await db.modelRun.create({ data: { chatId: chat.id, userId: user.id, userMessageId: message.id, assistantMessageId: assistant.id,
      modelId: "chat", provider: "fake", status: "streaming", normalizedRequest: json(request) } });
    await db.providerRunBinding.create({ data: { modelRunId: run.id, bindingKey: "image", role: "image", connectionId: connection.id, providerModelId: model.id,
      credentialId: credential.id, credentialVersionId, credentialSource: "default", executionSnapshot: json(plan.snapshot) } });
    let ordinal = 0;
    await runTest({ db, userId: user.id, runId: run.id, assistantId: assistant.id, modelId: model.id, credentialVersionId, request, storage: createMemoryStorageAdapter(),
      async call(ids = []) {
        const call: ModelToolCall = { name: "generate_image", id: randomUUID(), arguments: { prompt: "A blue circle", image_ids: ids } };
        const row = await db.modelRunToolCall.create({ data: { modelRunId: run.id, providerCallId: call.id, roundIndex: ordinal, ordinal: ordinal++,
          toolName: call.name, arguments: json(call.arguments), state: "running", startedAt: new Date() } });
        return { call, context: { request, runId: run.id, userId: user.id, persistedToolCallId: row.id } };
      },
      async publishImageModel(upstreamModelId, paramsJson = {}) {
        const published = await addImageModel(upstreamModelId);
        await db.publishedImageModel.create({ data: { providerModelId: published.id, paramsJson } });
        return published.id;
      },
      async chooseImageModel(providerModelId) {
        await db.userSettings.upsert({ where: { userId: user.id }, create: { userId: user.id, imageProviderModelId: providerModelId },
          update: { imageProviderModelId: providerModelId } });
      } });
    await db.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
    throw rollback;
  }, { timeout: 30_000 }); } catch (error) { if (error !== rollback) throw error; }
}

async function imageResponse() {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "blue" } }).png().toBuffer();
  return Response.json({ data: [{ b64_json: png.toString("base64") }], usage: { input_tokens: 3, output_tokens: 11, total_tokens: 14 } });
}

describe("durable conversational images", () => {
  it("stores every version, restores without another dispatch and retains images after synthesis fails", async () => fixture(async (f) => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(imageResponse);
    const service = createPrismaImageGenerationService(f.db, f.storage, { encryptionKey: () => key, fetchFn });
    const first = await f.call();
    const generated = await service.execute(first.call, first.context);
    const attachment = await f.db.attachment.findUniqueOrThrow({ where: { imageToolCallId: first.context.persistedToolCallId } });
    expect(attachment).toMatchObject({ origin: "IMAGE_OUTPUT", messageId: f.assistantId, producerModelRunId: f.runId });
    expect(await service.execute(first.call, first.context)).toEqual(generated);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const second = await f.call([attachment.id]);
    await service.execute(second.call, second.context);
    expect(fetchFn.mock.calls[1]![0]).toBe("https://image-fixture.example/v1/images/edits");
    const multipart = fetchFn.mock.calls[1]![1]!.body as FormData;
    expect((multipart.get("image[]") as Blob).size).toBe(attachment.byteSize);
    expect(await f.db.attachment.count({ where: { producerModelRunId: f.runId } })).toBe(2);
    expect(await f.db.attachmentDeletionJob.count({ where: { storageKey: attachment.storageKey } })).toBe(0);
    const usage = await f.db.usageEvent.findMany({ where: { modelRunId: f.runId } });
    expect(usage).toHaveLength(2);
    expect(usage.every((entry) => entry.imageGeneration && entry.purpose === "image_generation" &&
      entry.estimatedCostMicros === null && entry.totalTokens === 14)).toBe(true);
    expect(await createPrismaRunRepository(f.db).loadRunUsageAttributions({ runId: f.runId, userId: f.userId })).toEqual([]);
    await f.db.modelRun.update({ where: { id: f.runId }, data: { status: "error" } });
    await f.db.message.update({ where: { id: f.assistantId }, data: { status: "error" } });
    const messages = await createPrismaRunRepository(f.db).loadConversationContextForLeaf(f.request.chatId, f.userId, f.assistantId);
    expect(JSON.stringify(messages)).toContain(attachment.id);
    expect(await service.restore(first.call, first.context)).toEqual(generated);
    expect(await createPrismaAttachmentDownloadRepository(f.db).resolve({ attachmentId: attachment.id, userId: randomUUID() })).toBeNull();
    const saved = await createSavedFileRepository(f.db).copy({ attachmentId: attachment.id, save: true, userId: f.userId });
    expect(saved).toMatchObject({ origin: "USER_UPLOAD", imageToolCallId: null, producerModelRunId: null, storageKey: attachment.storageKey });
    const branch = await createPrismaMessageBranchRepository(f.db).createChatBranchFromMessage({ sourceMessageId: f.assistantId, userId: f.userId });
    expect(branch).not.toBeNull();
    const cloned = await f.db.attachment.findMany({ where: { chatId: branch!.id } });
    expect(cloned).toHaveLength(2);
    expect(cloned.every((row) => row.origin === "USER_UPLOAD" && !row.imageToolCallId)).toBe(true);
    expect(cloned.map((row) => row.storageKey)).toContain(attachment.storageKey);
    const branchContext = await createPrismaRunRepository(f.db).loadConversationContextForLeaf(branch!.id, f.userId, branch!.activeLeafMessageId!);
    expect(JSON.stringify(branchContext)).toContain(cloned[0]!.id);
    expect(JSON.stringify(branchContext)).not.toContain(attachment.id);
    await createPrismaMessageBranchRepository(f.db).deleteMessageSubtree({ messageId: f.assistantId, userId: f.userId });
    expect(await f.db.modelRun.count({ where: { id: f.runId } })).toBe(0);
    expect(await f.db.attachment.findUnique({ where: { id: attachment.id } })).toMatchObject({
      origin: "USER_UPLOAD", imageToolCallId: null, producerModelRunId: null, messageId: null
    });
    expect(await f.db.attachment.findUnique({ where: { id: saved!.id } })).toMatchObject({ storageKey: attachment.storageKey });
    expect(await f.db.usageEvent.findMany({ where: { id: { in: usage.map((entry) => entry.id) } } }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ imageGeneration: true, imageToolCallId: null, modelRunId: null })]));
  }));
  it("freezes settings, blocks unrelated references and checks revocation before provider I/O", async () => fixture(async (f) => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(imageResponse);
    const service = createPrismaImageGenerationService(f.db, f.storage, { encryptionKey: () => key, fetchFn });
    const unrelated = await f.call([randomUUID()]);
    await expect(service.execute(unrelated.call, unrelated.context)).rejects.toThrow("image_reference_unavailable");
    expect(fetchFn).not.toHaveBeenCalled();
    await f.db.providerModel.update({ where: { id: f.modelId }, data: { activeVersion: 2, defaultParams: { quality: "high" } } });
    const admitted = await f.call();
    await service.execute(admitted.call, admitted.context);
    expect(JSON.parse(String(fetchFn.mock.calls[0]![1]!.body)).quality).toBe("low");
    await f.db.providerCredentialVersion.update({ where: { id: f.credentialVersionId }, data: { revokedAt: new Date() } });
    const revoked = await f.call();
    await expect(service.execute(revoked.call, revoked.context)).rejects.toThrow("image_provider_revoked");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  }));
  it("prices an image reported without a cost from the model's stored image prices", async () => fixture(async (f) => {
    await f.db.providerModel.update({ where: { id: f.modelId },
      data: { inputTokenPriceUsdPerMillion: 5, outputTokenPriceUsdPerMillion: 40 } });
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(imageResponse);
    const service = createPrismaImageGenerationService(f.db, f.storage, { encryptionKey: () => key, fetchFn });
    const { call, context } = await f.call();
    await service.execute(call, context);
    // 3 input tokens at $5 and 11 output tokens at $40 per million.
    expect(await f.db.usageEvent.findUniqueOrThrow({ where: { imageToolCallId: context.persistedToolCallId! } }))
      .toMatchObject({ purpose: "image_generation", providerModelId: f.modelId, estimatedCostMicros: 455 });
  }));
  it("retains a received image when Stop settles the run before publication finishes", async () => fixture(async (f) => {
    const call = await f.call();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => {
      const response = await imageResponse();
      await f.db.modelRun.update({ where: { id: f.runId }, data: { status: "cancelled" } });
      await f.db.message.update({ where: { id: f.assistantId }, data: { status: "cancelled" } });
      await f.db.modelRunToolCall.update({ where: { id: call.context.persistedToolCallId }, data: { state: "cancelled" } });
      return response;
    });
    const service = createPrismaImageGenerationService(f.db, f.storage, { encryptionKey: () => key, fetchFn });
    const received = await service.execute(call.call, call.context);
    expect(await service.restore(call.call, call.context)).toEqual(received);
    expect(await f.db.usageEvent.count({ where: { modelRunId: f.runId, imageGeneration: true } })).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  }));
  it("settles provider usage before storage and never re-dispatches a lost upload", async () => fixture(async (f) => {
    const { call, context } = await f.call();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(imageResponse);
    const put = vi.fn<NonNullable<typeof f.storage.putObjectStream>>(async () => { throw new Error("storage_unavailable"); });
    const failing = createPrismaImageGenerationService(f.db, { ...f.storage, putObjectStream: put }, { encryptionKey: () => key, fetchFn });
    await expect(failing.execute(call, context)).rejects.toThrow("storage_unavailable");
    const where = { imageToolCallId: context.persistedToolCallId! };
    expect(await f.db.usageEvent.findMany({ where })).toEqual([expect.objectContaining({ imageGeneration: true, modelRunId: f.runId,
      purpose: "image_generation", inputTokens: 3, outputTokens: 11, totalTokens: 14, estimatedCostMicros: null })]);
    expect(await f.db.attachment.count({ where })).toBe(0);
    const { storageKey } = put.mock.calls[0]![0];
    expect(f.storage.objects.has(storageKey)).toBe(false);
    expect(await f.db.attachmentDeletionJob.findUnique({ where: { storageKey } })).toMatchObject({ claimToken: null, claimedAt: null });
    const healthy = createPrismaImageGenerationService(f.db, f.storage, { encryptionKey: () => key, fetchFn });
    await expect(healthy.execute(call, context)).rejects.toThrow("image_dispatch_claimed");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await f.db.usageEvent.count({ where })).toBe(1);
    expect(await f.db.attachment.count({ where })).toBe(0);
  }));
  it("retains settled usage without publishing when access is lost after dispatch", async () => fixture(async (f) => {
    const { call, context } = await f.call();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => {
      const response = await imageResponse();
      const chat = await f.db.chat.findUniqueOrThrow({ where: { id: f.request.chatId }, select: { memorySourceRevision: true } });
      const deletion = await f.db.memoryDeletionOutbox.create({ data: { userId: f.userId, operation: "SOURCE_PURGE",
        targetType: "CHAT@memory-chat-delete-v1", targetId: f.request.chatId, memoryGeneration: 0,
        admissionAuthorizationId: randomUUID(), admittedChatSourceRevision: chat.memorySourceRevision, alsoForgetOriginMemories: false } });
      await f.db.chat.update({ where: { id: f.request.chatId }, data: { archived: true, memoryMode: "EXCLUDED",
        permanentDeletionAt: new Date(), permanentDeletionOperationId: deletion.id } });
      return response;
    });
    const service = createPrismaImageGenerationService(f.db, f.storage, { encryptionKey: () => key, fetchFn });
    await expect(service.execute(call, context)).rejects.toThrow("image_access_revoked");
    const where = { imageToolCallId: context.persistedToolCallId! };
    expect(await f.db.usageEvent.findMany({ where })).toEqual([expect.objectContaining({ inputTokens: 3, outputTokens: 11, totalTokens: 14 })]);
    expect(await f.db.attachment.count({ where })).toBe(0);
    const [storageKey] = [...f.storage.objects.keys()].filter((entry) => entry.startsWith("generated-images/"));
    expect(await f.db.attachmentDeletionJob.findUnique({ where: { storageKey: storageKey! } })).toMatchObject({ claimToken: null });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  }));
  it("binds personal runs to the user's published choice and Project runs to the administrator default", async () => fixture(async (f) => {
    const chosen = await f.publishImageModel("gpt-image-1", { quality: "high" });
    await f.chooseImageModel(chosen);
    const resolver = createImageModelRoleResolver(f.db);
    const personal = await resolver.resolveFor({ kind: "personal", userId: f.userId });
    const project = await resolver.resolveFor({ kind: "project" });
    expect(personal).toMatchObject({ ok: true, providerModelId: chosen, source: "personal", plan: { parameters: { quality: "high" } } });
    expect(project).toMatchObject({ ok: true, providerModelId: f.modelId, source: "organization", plan: { parameters: { quality: "low" } } });
    if (!personal.ok || !project.ok) throw new Error("fixture_plans_unavailable");
    const admit = async (imagePlan: AcceptedImageGenerationPlan, imageScope: "personal" | "project") => {
      await f.db.providerRunBinding.deleteMany({ where: { modelRunId: f.runId, bindingKey: "image" } });
      await insertAcceptedProviderRunBindings(f.db as unknown as Prisma.TransactionClient, {
        imagePlan, imageScope, nativeBackgroundRequested: false, plan: undefined, runId: f.runId, userId: f.userId
      });
      return f.db.providerRunBinding.findFirstOrThrow({ where: { modelRunId: f.runId, bindingKey: "image" } });
    };
    // A Project member who chose another model personally is admitted on the
    // default, as every tool-capable message, text-only ones included, is.
    expect(await admit(project.plan, "project")).toMatchObject({ providerModelId: f.modelId });
    await expect(admit(personal.plan, "project")).rejects.toBeInstanceOf(ProviderAdmissionConflictError);
    expect(await admit(personal.plan, "personal")).toMatchObject({ providerModelId: chosen });
    await expect(admit(project.plan, "personal")).rejects.toBeInstanceOf(ProviderAdmissionConflictError);
    // A later Studio change affects only future admissions; the accepted binding stays.
    await admit(personal.plan, "personal");
    await f.chooseImageModel(null);
    expect(await f.db.providerRunBinding.findFirstOrThrow({ where: { modelRunId: f.runId, bindingKey: "image" } }))
      .toMatchObject({ providerModelId: chosen });
    await expect(admit(personal.plan, "personal")).rejects.toBeInstanceOf(ProviderAdmissionConflictError);
    expect(await admit(project.plan, "personal")).toMatchObject({ providerModelId: f.modelId });
    // Changed administrator parameters fence a plan resolved before the change.
    await f.db.publishedImageModel.update({ where: { providerModelId: f.modelId }, data: { paramsJson: { quality: "medium" } } });
    await expect(admit(project.plan, "project")).rejects.toBeInstanceOf(ProviderAdmissionConflictError);
  }));

  it("withdraws a model and clears the role in one save each, returning users to the default and keeping accepted bindings", async () => fixture(async (f) => {
    const admin = await f.db.user.create({ data: { id: randomUUID(), displayName: "Image administrator", role: "admin", status: "active" } });
    const service = createAdminSystemModelPolicyService(f.db);
    const version = async () => (await f.db.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } })).version;
    const chosen = await f.publishImageModel("gpt-image-1");
    await f.chooseImageModel(chosen);
    const both = [{ providerModelId: f.modelId, parameters: { quality: "low" } }, { providerModelId: chosen, parameters: {} }];
    await expect(service.update({ expectedVersion: await version(), userId: admin.id, imageProviderModelId: f.modelId,
      imageModels: [{ providerModelId: chosen, parameters: {} }] })).rejects.toMatchObject({ code: "system_model_policy_image_models_invalid" });
    await expect(service.update({ expectedVersion: await version(), userId: admin.id, imageProviderModelId: f.modelId,
      imageModels: [...both, { providerModelId: randomUUID(), parameters: {} }] })).rejects.toMatchObject({ code: "system_model_policy_target_unavailable" });
    expect(await f.db.publishedImageModel.count({ where: { providerModelId: { in: [f.modelId, chosen] } } })).toBe(2);

    const before = await version();
    await service.update({ expectedVersion: before, userId: admin.id, imageProviderModelId: f.modelId, imageModels: both.slice(0, 1) });
    expect(await version()).toBe(before + 1);
    expect(await f.db.userSettings.findUniqueOrThrow({ where: { userId: f.userId } })).toMatchObject({ imageProviderModelId: null });
    expect(await f.db.publishedImageModel.findMany({ where: { providerModelId: { in: [f.modelId, chosen] } } }))
      .toEqual([expect.objectContaining({ providerModelId: f.modelId, paramsJson: { quality: "low" } })]);
    expect((await createUserImageModelService(f.db).read(f.userId)).effective).toEqual({ id: f.modelId, source: "organization" });

    await service.update({ expectedVersion: await version(), userId: admin.id, imageProviderModelId: f.modelId, imageModels: both });
    await f.chooseImageModel(chosen);
    await service.update({ expectedVersion: await version(), userId: admin.id, imageProviderModelId: null, imageModels: [] });
    expect(await f.db.publishedImageModel.count()).toBe(0);
    expect(await f.db.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } })).toMatchObject({ imageProviderModelId: null });
    expect(await f.db.userSettings.count({ where: { imageProviderModelId: { not: null } } })).toBe(0);
    expect(await f.db.providerRunBinding.count({ where: { modelRunId: f.runId, bindingKey: "image", providerModelId: f.modelId } })).toBe(1);
    expect(await createImageModelRoleResolver(f.db).resolveFor({ kind: "personal", userId: f.userId }))
      .toEqual({ ok: false, reason: "not_configured", providerModelId: null, source: "organization" });
  }));

  it("keeps a published model that lost its provider, names the reason and never substitutes it", async () => fixture(async (f) => {
    const chosen = await f.publishImageModel("gpt-image-1");
    await f.chooseImageModel(chosen);
    await f.db.providerModel.update({ where: { id: chosen }, data: { enabled: false } });
    const resolver = createImageModelRoleResolver(f.db);
    expect(await resolver.resolveFor({ kind: "personal", userId: f.userId }))
      .toEqual({ ok: false, reason: "model_unavailable", providerModelId: chosen, source: "personal" });
    expect(await resolver.resolveFor({ kind: "project" })).toMatchObject({ ok: true, providerModelId: f.modelId });
    expect(await f.db.userSettings.findUniqueOrThrow({ where: { userId: f.userId } })).toMatchObject({ imageProviderModelId: chosen });
    expect((await createUserImageModelService(f.db).read(f.userId)).models.find((model) => model.id === chosen))
      .toMatchObject({ unavailableReason: "model_unavailable", generation: false, editing: false });
    await f.db.providerModelCredentialCheck.updateMany({ where: { providerModelId: f.modelId }, data: { status: "unavailable" } });
    expect(await resolver.resolveFor({ kind: "project" })).toMatchObject({ ok: false, reason: "verification_required", providerModelId: f.modelId });
    await f.db.providerCredentialVersion.update({ where: { id: f.credentialVersionId }, data: { revokedAt: new Date() } });
    expect(await resolver.resolveFor({ kind: "project" })).toMatchObject({ ok: false, reason: "credential_unavailable", providerModelId: f.modelId });
    await expect(createUserImageModelService(f.db).select(f.userId, randomUUID())).rejects.toMatchObject({ code: "image_model_not_published" });
  }));

  it("keeps image generation off for everyone after a previous release clears the default without withdrawing", async () => fixture(async (f) => {
    const chosen = await f.publishImageModel("gpt-image-1");
    await f.chooseImageModel(chosen);
    const resolver = createImageModelRoleResolver(f.db);
    const before = await resolver.resolveFor({ kind: "personal", userId: f.userId });
    if (!before.ok) throw new Error("fixture_plan_unavailable");
    // The previous release's role clear: only the default is nulled; publications and choices stay.
    await f.db.systemModelPolicy.update({ where: { id: "installation" }, data: { imageProviderModelId: null } });
    const off = { ok: false, reason: "not_configured", providerModelId: null, source: "organization" };
    expect(await resolver.resolveFor({ kind: "personal", userId: f.userId })).toEqual(off);
    expect(await resolver.resolveFor({ kind: "project" })).toEqual(off);
    const users = createUserImageModelService(f.db);
    expect(await users.read(f.userId)).toEqual({ models: [], organizationDefaultId: null, selectedId: null, effective: null });
    await expect(users.select(f.userId, chosen)).rejects.toMatchObject({ code: "image_model_not_published" });
    // A plan resolved before the clear is fenced at admission; nothing generates on it.
    await f.db.providerRunBinding.deleteMany({ where: { modelRunId: f.runId, bindingKey: "image" } });
    await expect(insertAcceptedProviderRunBindings(f.db as unknown as Prisma.TransactionClient, {
      imagePlan: before.plan, imageScope: "personal", nativeBackgroundRequested: false, plan: undefined, runId: f.runId, userId: f.userId
    })).rejects.toBeInstanceOf(ProviderAdmissionConflictError);
    // The administrator withdraws the leftovers by clearing the role, which also resets the choice.
    const admin = await f.db.user.create({ data: { id: randomUUID(), displayName: "Image administrator", role: "admin", status: "active" } });
    const { version } = await f.db.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
    await createAdminSystemModelPolicyService(f.db).update({ expectedVersion: version, userId: admin.id, imageProviderModelId: null, imageModels: [] });
    expect(await f.db.publishedImageModel.count()).toBe(0);
    expect(await f.db.userSettings.findUniqueOrThrow({ where: { userId: f.userId } })).toMatchObject({ imageProviderModelId: null });
  }));

  it("never estimates usage when the provider call fails", async () => fixture(async (f) => {
    const { call, context } = await f.call();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ error: { message: "synthetic failure" } }, { status: 500 }));
    const service = createPrismaImageGenerationService(f.db, f.storage, { encryptionKey: () => key, fetchFn });
    await expect(service.execute(call, context)).rejects.toThrow("image_provider_http_error");
    const where = { imageToolCallId: context.persistedToolCallId! };
    expect(await f.db.usageEvent.count({ where })).toBe(0);
    expect(await f.db.attachment.count({ where })).toBe(0);
  }));

  it("accounts a completed response whose image is rejected once and never re-dispatches it", async () => fixture(async (f) => {
    const { call, context } = await f.call();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ data: [],
      usage: { input_tokens: 3, output_tokens: 11, total_tokens: 14, cost: 0.04 } }));
    const service = createPrismaImageGenerationService(f.db, f.storage, { encryptionKey: () => key, fetchFn });
    await expect(service.execute(call, context)).rejects.toThrow("image_output_missing");
    const where = { imageToolCallId: context.persistedToolCallId! };
    expect(await f.db.usageEvent.findMany({ where })).toEqual([expect.objectContaining({ imageGeneration: true, modelRunId: f.runId,
      purpose: "image_generation", inputTokens: 3, outputTokens: 11, totalTokens: 14, estimatedCostMicros: 40_000,
      usageCompleteness: "COMPLETE" })]);
    await expect(service.execute(call, context)).rejects.toThrow("image_dispatch_claimed");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await f.db.attachment.count({ where })).toBe(0);
  }));

  it("keeps the completeness an image's reported tokens prove", async () => fixture(async (f) => {
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "blue" } }).png().toBuffer();
    for (const [usage, usageCompleteness] of [
      [{ input_tokens: 3, output_tokens: 11, total_tokens: 14 }, "COMPLETE"],
      [{ input_tokens: 3, output_tokens: 11 }, "PARTIAL"],
      [{ cost: 0.04 }, "UNAVAILABLE"]
    ] as const) {
      const { call, context } = await f.call();
      const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () =>
        Response.json({ data: [{ b64_json: png.toString("base64") }], usage }));
      await createPrismaImageGenerationService(f.db, f.storage, { encryptionKey: () => key, fetchFn }).execute(call, context);
      expect(await f.db.usageEvent.findUniqueOrThrow({ where: { imageToolCallId: context.persistedToolCallId! } }))
        .toMatchObject({ purpose: "image_generation", usageCompleteness });
    }
  }));
});
