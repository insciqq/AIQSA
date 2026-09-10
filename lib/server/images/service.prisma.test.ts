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
import type { ModelToolCall, ToolExecutionContext } from "../tools/types";
import type { ProviderRunRequest } from "../providers/types";

afterAll(() => prisma.$disconnect());
const key = Buffer.alloc(32, 71);
const json = (value: unknown) => value as Prisma.InputJsonValue;

async function fixture(runTest: (fixture: {
  db: PrismaClient; userId: string; runId: string; assistantId: string; modelId: string; credentialVersionId: string;
  request: ProviderRunRequest; storage: ReturnType<typeof createMemoryStorageAdapter>;
  call(ids?: string[]): Promise<{ call: ModelToolCall; context: ToolExecutionContext }>;
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
    const model = await db.providerModel.create({ data: { id: randomUUID(), connectionId: connection.id, modelId: configuration.upstreamModelId, modelClass: "image",
      provider: "openai", displayName: "Image fixture", capabilities: configuration.capabilities, defaultParams: {}, activeConfig: configuration,
      activeVersion: 1, activatedAt: new Date() } });
    const proof = { adapterKind: configuration.adapterKind, upstreamModelId: configuration.upstreamModelId, verified: true, probeVersion: 1 };
    await db.providerModelCredentialCheck.create({ data: { connectionId: connection.id, providerModelId: model.id, connectionVersion: 1, modelVersion: 1,
      credentialId: credential.id, credentialVersionId, checkedAt: new Date(), status: "available", evidence: {
        method: "tiny_generation", selectedProviders: [], upstreamModelId: configuration.upstreamModelId, detail: "ok", imageGeneration: proof, imageEditing: proof
      } } });
    await db.systemModelPolicy.upsert({ where: { id: "installation" }, create: { id: "installation", imageProviderModelId: model.id, imageParamsJson: { quality: "low" } },
      update: { imageProviderModelId: model.id, imageParamsJson: { quality: "low" } } });
    const plan = await createImageModelRoleResolver(db).resolve();
    expect(plan).not.toBeNull();
    const chat = await db.chat.create({ data: { userId: user.id, title: "Image fixture", memoryMode: "EXCLUDED" } });
    const message = await db.message.create({ data: { chatId: chat.id, role: "user", content: { blocks: [{ type: "text", text: "Create an image" }] } } });
    const assistant = await db.message.create({ data: { chatId: chat.id, parentMessageId: message.id, role: "assistant", content: { blocks: [] }, status: "streaming" } });
    await db.chat.update({ where: { id: chat.id }, data: { activeLeafMessageId: assistant.id } });
    const request: ProviderRunRequest = { attachmentIds: [], attachments: [], chatId: chat.id, content: { blocks: [] }, imagePlan: plan!, imageReferences: [],
      modelId: "chat", provider: "fake", modelCapabilities: { vision: false, pdf: false, nativePdfInput: false, nativeSearch: false, reasoning: false },
      knowledgePlan: { mode: "none", baseIds: [], sourceIds: [], version: 1 }, searchPlan: { options: [], mode: "all_selected" }, params: {}, prompt: { system: null, developer: null }, toolMode: "auto" };
    const run = await db.modelRun.create({ data: { chatId: chat.id, userId: user.id, userMessageId: message.id, assistantMessageId: assistant.id,
      modelId: "chat", provider: "fake", status: "streaming", normalizedRequest: json(request) } });
    await db.providerRunBinding.create({ data: { modelRunId: run.id, bindingKey: "image", role: "image", connectionId: connection.id, providerModelId: model.id,
      credentialId: credential.id, credentialVersionId, credentialSource: "default", executionSnapshot: json(plan!.snapshot) } });
    let ordinal = 0;
    await runTest({ db, userId: user.id, runId: run.id, assistantId: assistant.id, modelId: model.id, credentialVersionId, request, storage: createMemoryStorageAdapter(),
      async call(ids = []) {
        const call: ModelToolCall = { name: "generate_image", id: randomUUID(), arguments: { prompt: "A blue circle", image_ids: ids } };
        const row = await db.modelRunToolCall.create({ data: { modelRunId: run.id, providerCallId: call.id, roundIndex: ordinal, ordinal: ordinal++,
          toolName: call.name, arguments: json(call.arguments), state: "running", startedAt: new Date() } });
        return { call, context: { request, runId: run.id, userId: user.id, persistedToolCallId: row.id } };
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
    expect(usage.every((entry) => entry.imageGeneration && entry.estimatedCostMicros === null && entry.totalTokens === 14)).toBe(true);
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
});
