import { randomUUID, createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { decodeThreadGeneratedImage, IMAGE_MAX_BYTES, IMAGE_MAX_INPUT_BYTES, IMAGE_MAX_INPUTS, IMAGE_MAX_PROMPT_CHARACTERS, normalizeImageGenerationParameters, type ThreadGeneratedImage } from "../../contracts/imageGeneration";
import { createImageModelRoleResolver, type AcceptedImageGenerationPlan } from "../providerRuntime/imageModelRole";
import { createImageGenerationAdapter, type ImageGenerationInput } from "../providers/imageGeneration";
import { decryptProviderCredentialSecret } from "../providers/credentialSecrets";
import { getSecretEncryptionKey } from "../secrets/envelope";
import { resolveChatAccess } from "../projects/access";
import { IMAGE_GENERATION_TOOL_NAME } from "../tools/imageGeneration";
import type { ModelToolCall, ToolExecutionContext, ToolExecutionResult } from "../tools/types";
import type { StorageAdapter } from "../uploads/storage";
import type { ProviderRunRequest, ProviderAttachment } from "../providers/types";
import { normalizeProviderExecutionSnapshot } from "../providers/runtimeFactory";

const MAX_IMAGE_CALLS_PER_RUN = 4;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function result(call: ModelToolCall, image: ThreadGeneratedImage): ToolExecutionResult {
  return { callId: call.id, name: call.name, status: "complete", content: [{ type: "json", value: {
    image_id: image.attachmentId, width: image.width, height: image.height,
    source_image_ids: image.sourceAttachmentIds, displayed_in_chat: true
  } }], artifacts: [{ type: "artifact", data: { artifactType: "image", payload: image } }] };
}

/** One durable tool call owns one paid dispatch and at most one immutable image. */
export function createPrismaImageGenerationService(prisma: PrismaClient, storage: StorageAdapter, options: {
  encryptionKey?: () => Buffer;
  fetchFn?: typeof fetch;
} = {}) {
  const resolver = createImageModelRoleResolver(prisma);
  const service = {
    resolve: resolver.resolve,
    async withConversationPixels(request: ProviderRunRequest, userId: string, signal?: AbortSignal): Promise<ProviderRunRequest> {
      if (!request.modelCapabilities.vision || !request.imageReferences?.length) return request;
      const access = await resolveChatAccess(prisma, { chatId: request.chatId, userId });
      if (!access) throw new Error("image_access_revoked");
      const attached = new Set(request.attachments.map((attachment) => attachment.id));
      const imageLimit = Math.min(4, Math.max(0, (request.modelCapabilities.imageInputLimits?.imageCount ?? 20) - request.attachments.filter((attachment) => attachment.kind === "image").length));
      const ids = imageLimit ? [...new Set(request.imageReferences.map((reference) => reference.attachmentId))].filter((id) => !attached.has(id)).slice(-imageLimit) : [];
      const rows = await prisma.attachment.findMany({ where: { id: { in: ids }, kind: "image", status: "ready", savedAt: null,
        ...(access.kind === "project" ? { projectId: access.project.projectId } : { userId }) } });
      let remaining = Math.min(IMAGE_MAX_BYTES, request.modelCapabilities.imageInputLimits?.payloadBytes ?? Infinity) - request.attachments.reduce((sum, attachment) => sum + (attachment.base64Data || attachment.dataUrl ? attachment.byteSize : 0), 0);
      const extra: ProviderAttachment[] = [];
      for (const id of [...ids].reverse()) {
        const row = rows.find((entry) => entry.id === id);
        if (!row || row.byteSize > remaining || row.byteSize > (request.modelCapabilities.imageInputLimits?.imageBytes ?? IMAGE_MAX_BYTES)) continue;
        const stored = await storage.getObject(row.storageKey, { maxBytes: Math.min(row.byteSize, IMAGE_MAX_BYTES), signal });
        if (stored.body.byteLength !== row.byteSize || row.checksum && hash(stored.body) !== row.checksum) throw new Error("image_reference_invalid");
        const encoded = stored.body.toString("base64");
        extra.unshift({ id, kind: "image", status: "ready", byteSize: row.byteSize, fileName: row.fileName,
          mimeType: row.mimeType, metadata: {}, extractedText: null, base64Data: encoded, dataUrl: `data:${row.mimeType};base64,${encoded}` });
        remaining -= row.byteSize;
      }
      const attachments = [...request.attachments, ...extra];
      const visibleIds = attachments.filter((attachment) => attachment.kind === "image" && (attachment.dataUrl || attachment.base64Data)).map((attachment) => attachment.id);
      return { ...request, attachments, prompt: { ...request.prompt,
        system: [request.prompt.system, `Image pixels accompanying the latest user message, in order: ${JSON.stringify(visibleIds)}. Additional images are references from earlier messages, not new uploads. Other image references have no visible pixels in this request.`].filter(Boolean).join("\n\n") } };
    },
    async authorize(plan: AcceptedImageGenerationPlan): Promise<boolean> {
      try {
        const [model, credential] = await Promise.all([
          prisma.providerModel.findFirst({ where: { id: plan.authority.providerModelId, connectionId: plan.authority.connectionId, enabled: true, connection: { enabled: true } }, select: { id: true } }),
          prisma.providerCredentialVersion.findFirst({ where: { id: plan.authority.credentialVersionId, credentialId: plan.authority.credentialId,
            revokedAt: null, credential: { enabled: true, connectionId: plan.authority.connectionId } }, select: { id: true } })
        ]);
        return Boolean(model && credential);
      } catch { return false; }
    },
    async restore(call: ModelToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult | null> {
      if (!context.persistedToolCallId || !context.runId || !context.userId) return null;
      const attachment = await prisma.attachment.findFirst({ where: {
        imageToolCallId: context.persistedToolCallId, producerModelRunId: context.runId,
        chatId: context.request.chatId, origin: "IMAGE_OUTPUT", status: "ready"
      }, select: { metadata: true } });
      if (!attachment || !await resolveChatAccess(prisma, { chatId: context.request.chatId, userId: context.userId })) return null;
      const image = object(attachment.metadata) ? decodeThreadGeneratedImage(attachment.metadata.image) : null;
      return image ? result(call, image) : null;
    },
    async execute(call: ModelToolCall, context: ToolExecutionContext, signal?: AbortSignal): Promise<ToolExecutionResult> {
      const { runId, userId, persistedToolCallId: toolCallId, request } = context;
      const plan = request.imagePlan;
      if (!runId || !userId || !toolCallId || !plan || call.name !== IMAGE_GENERATION_TOOL_NAME) throw new Error("image_tool_unavailable");
      const args = call.arguments;
      if (!object(args) || Object.keys(args).some((key) => !["prompt", "image_ids", "parameters"].includes(key)) ||
        typeof args.prompt !== "string" || !args.prompt.trim() || args.prompt.length > IMAGE_MAX_PROMPT_CHARACTERS ||
        !Array.isArray(args.image_ids) || args.image_ids.length > IMAGE_MAX_INPUTS ||
        !args.image_ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128) ||
        new Set(args.image_ids).size !== args.image_ids.length) throw new Error("image_input_invalid");
      const ids = args.image_ids as string[];
      const binding = await prisma.providerRunBinding.findFirst({ where: { modelRunId: runId, bindingKey: "image", role: "image",
        connectionId: plan.authority.connectionId, providerModelId: plan.authority.providerModelId,
        credentialId: plan.authority.credentialId, credentialVersionId: plan.authority.credentialVersionId }, select: { executionSnapshot: true } });
      if (!binding) throw new Error("image_binding_unavailable");
      const snapshot = normalizeProviderExecutionSnapshot(binding.executionSnapshot);
      const model = snapshot.model;
      if (model.adapterKind === "fake" || !model.image || !(ids.length ? model.capabilities.imageEditing : model.capabilities.imageGeneration)) {
        throw new Error(ids.length ? "image_editing_unavailable" : "image_generation_unavailable");
      }
      const overrides = normalizeImageGenerationParameters(args.parameters ?? {}, model.image, model.upstreamModelId);
      const parameters = normalizeImageGenerationParameters({ ...plan.parameters, ...overrides }, model.image, model.upstreamModelId);
      const existing = await service.restore(call, context);
      if (existing) return existing;
      const run = await prisma.modelRun.findFirst({ where: { id: runId, userId, chatId: request.chatId },
        select: { assistantMessageId: true, status: true } });
      if (!run?.assistantMessageId || !["streaming", "in_progress"].includes(run.status)) throw new Error("image_run_inactive");
      const access = await resolveChatAccess(prisma, { chatId: request.chatId, userId, requireMutable: true, minimumProjectRole: "CONTRIBUTOR" });
      if (!access) throw new Error("image_access_revoked");
      const tool = await prisma.modelRunToolCall.findFirst({ where: { id: toolCallId, modelRunId: runId, state: "running", toolName: call.name } });
      if (!tool) throw new Error("image_tool_not_claimed");
      if (await prisma.modelRunToolCall.count({ where: { modelRunId: runId, toolName: call.name, startedAt: { not: null } } }) > MAX_IMAGE_CALLS_PER_RUN) {
        throw new Error("image_tool_budget_exhausted");
      }
      const admitted = new Set(request.imageReferences?.map((reference) => reference.attachmentId) ?? []);
      const rows = ids.length ? await prisma.attachment.findMany({ where: {
        id: { in: ids }, status: "ready", savedAt: null,
        ...(access.kind === "project" ? { projectId: access.project.projectId } : { userId }),
        OR: [{ id: { in: [...admitted] } }, { origin: "IMAGE_OUTPUT", producerModelRunId: runId, chatId: request.chatId }]
      } }) : [];
      if (rows.length !== ids.length || rows.reduce((sum, row) => sum + row.byteSize, 0) > IMAGE_MAX_INPUT_BYTES) throw new Error("image_reference_unavailable");
      const images: ImageGenerationInput[] = [];
      for (const id of ids) {
        const row = rows.find((entry) => entry.id === id)!;
        const stored = await storage.getObject(row.storageKey, { maxBytes: IMAGE_MAX_BYTES, signal });
        if (stored.body.byteLength !== row.byteSize || row.checksum && hash(stored.body) !== row.checksum) throw new Error("image_reference_invalid");
        images.push({ bytes: stored.body, mimeType: row.mimeType as ImageGenerationInput["mimeType"] });
      }
      if (!await service.authorize(plan)) throw new Error("image_provider_revoked");
      const adapter = createImageGenerationAdapter({ connection: snapshot.connection, model,
        ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}), secret: async () => {
          const credential = await prisma.providerCredentialVersion.findFirst({ where: {
            id: plan.authority.credentialVersionId, credentialId: plan.authority.credentialId, revokedAt: null
          }, select: { id: true, credentialId: true, secretEnvelope: true } });
          if (!credential?.secretEnvelope || !await service.authorize(plan)) throw new Error("image_provider_revoked");
          return decryptProviderCredentialSecret({ credentialId: credential.credentialId, valueId: credential.id,
            envelope: credential.secretEnvelope, key: (options.encryptionKey ?? getSecretEncryptionKey)() });
        } });
      const generated = await adapter.generate({ prompt: args.prompt, images, parameters, signal });
      const attachmentId = randomUUID();
      const token = randomUUID();
      const storageKey = `generated-images/${attachmentId}`;
      const image: ThreadGeneratedImage = { attachmentId, byteSize: generated.bytes.byteLength,
        fileName: `image-${attachmentId.slice(0, 8)}.${generated.mimeType.split("/")[1]}`, mimeType: generated.mimeType,
        width: generated.width, height: generated.height, sourceAttachmentIds: ids };
      await prisma.attachmentDeletionJob.create({ data: { storageKey, claimToken: token, claimedAt: new Date() } });
      try {
        // A bounded upload finishes before its cleanup lease expires. Late writes
        // retain the cleanup obligation rather than publishing an unowned object.
        const uploadSignal = AbortSignal.timeout(60_000);
        if (storage.putObjectStream) {
          await storage.putObjectStream({ storageKey, contentType: generated.mimeType, byteSize: image.byteSize,
            checksum: hash(generated.bytes), signal: uploadSignal, body: new ReadableStream({ start(controller) {
              controller.enqueue(generated.bytes); controller.close();
            } }) });
        } else await storage.putObject({ storageKey, contentType: generated.mimeType, body: Buffer.from(generated.bytes) });
        await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "ModelRun" WHERE "id" = ${runId} FOR UPDATE`;
          const jobs = await tx.$queryRaw<Array<{ claimToken: string | null }>>`SELECT "claimToken" FROM "AttachmentDeletionJob" WHERE "storageKey" = ${storageKey} FOR UPDATE`;
          if (jobs[0]?.claimToken !== token) throw new Error("image_publication_stale");
          const currentAccess = await resolveChatAccess(tx, { chatId: request.chatId, userId, requireMutable: true, minimumProjectRole: "CONTRIBUTOR" });
          if (!currentAccess || currentAccess.kind !== access.kind || currentAccess.project?.projectId !== access.project?.projectId) throw new Error("image_access_revoked");
          const uploader = access.kind === "project" ? await tx.user.findUnique({ where: { id: userId }, select: { displayName: true } }) : null;
          await tx.attachment.create({ data: {
            id: attachmentId, imageToolCallId: toolCallId, producerModelRunId: runId, chatId: request.chatId,
            messageId: run.assistantMessageId, origin: "IMAGE_OUTPUT", status: "ready", kind: "image",
            fileName: image.fileName, mimeType: image.mimeType, byteSize: image.byteSize, storageKey, checksum: hash(generated.bytes),
            ...(access.kind === "project" ? { projectId: access.project.projectId, uploaderUserId: userId, uploaderDisplayName: uploader?.displayName } : { userId }),
            metadata: { image, providerModelId: plan.authority.providerModelId, modelId: model.upstreamModelId, parameters } as Prisma.InputJsonValue
          } });
          const micros = generated.usage.costUsd === null ? null : Math.round(generated.usage.costUsd * 1_000_000);
          await tx.usageEvent.create({ data: { imageGeneration: true, imageToolCallId: toolCallId, modelRunId: runId, userId, chatId: request.chatId,
            projectId: access.project?.projectId, provider: snapshot.providerFamily,
            providerModelId: plan.authority.providerModelId, modelId: model.upstreamModelId,
            inputTokens: generated.usage.inputTokens, outputTokens: generated.usage.outputTokens, totalTokens: generated.usage.totalTokens,
            estimatedCostMicros: micros !== null && micros <= 2_147_483_647 ? micros : null } });
          await tx.attachmentDeletionJob.delete({ where: { storageKey } });
        });
      } catch (error) {
        await prisma.attachmentDeletionJob.updateMany({ where: { storageKey, claimToken: token }, data: { claimToken: null, claimedAt: null } }).catch(() => undefined);
        throw error;
      }
      return result(call, image);
    }
  };
  return service;
}

export type ImageGenerationService = ReturnType<typeof createPrismaImageGenerationService>;
