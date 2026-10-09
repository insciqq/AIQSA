import { randomUUID, createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { decodeThreadGeneratedImage, IMAGE_MAX_BYTES, IMAGE_MAX_INPUT_BYTES, IMAGE_MAX_INPUTS, IMAGE_MAX_PROMPT_CHARACTERS, IMAGE_MIME_TYPES, normalizeImageGenerationParameters, type ImageGenerationParameters, type ThreadGeneratedImage } from "../../contracts/imageGeneration";
import { createImageModelRoleResolver, type AcceptedImageGenerationPlan } from "../providerRuntime/imageModelRole";
import { createImageGenerationAdapter, ImageGenerationError, validateImageReference, type ImageGenerationInput, type ImageGenerationUsage } from "../providers/imageGeneration";
import { decryptProviderCredentialSecret } from "../providers/credentialSecrets";
import { getSecretEncryptionKey } from "../secrets/envelope";
import { resolveChatAccess } from "../projects/access";
import { IMAGE_GENERATION_TOOL_NAME } from "../tools/imageGeneration";
import type { ModelToolCall, ToolExecutionContext, ToolExecutionResult } from "../tools/types";
import { isStoredObjectMissingError, isStoredObjectTooLargeError, type StorageAdapter } from "../uploads/storage";
import type { ProviderRunRequest, ProviderAttachment } from "../providers/types";
import { normalizeProviderExecutionSnapshot } from "../providers/runtimeFactory";
import { loadProviderModelCostBasis, providerModelUsageCostMicros, storedTokenUsage } from "../usage";
import { ImageInputError } from "./inputError";
import { logEvent, type EventFields } from "../observability";
import { observedFailureCode } from "../providers/providerObservability";
import { databaseFailureCode, databaseFailureKind } from "../observability/databaseFailure";

const MAX_IMAGE_CALLS_PER_RUN = 4;
const USAGE_WRITE_RETRY_DELAYS_MS = [100, 250] as const;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

type ImageToolContext = Omit<ToolExecutionContext, "request"> & {
  request: Pick<ToolExecutionContext["request"], "chatId" | "imagePlan" | "imageReferences">;
};
type ImageExecutionOptions = {
  /** Atomically authorize the one paid dispatch after input checks. */
  beforeDispatch?: () => Promise<void>;
  beforeSettlement?: (tx: Prisma.TransactionClient) => Promise<void>;
  onResult?: (tx: Prisma.TransactionClient, result: ToolExecutionResult) => Promise<void>;
};

/** Connection loss, pool exhaustion, or an expired, timed-out, conflicting or
 * deadlocked statement: the write did not commit, or its outcome is unknown.
 * An uncoded engine failure (a raw dropped connection) is equally unknown, and
 * the unique tool-call link keeps its repeat idempotent. */
function transientUsageWriteFailure(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientUnknownRequestError || databaseFailureKind(error) !== undefined ||
    ["P1001", "P1002", "P1008", "P1017", "P2024", "P2028"].includes(databaseFailureCode(error));
}

/** Writes the one usage row of a paid dispatch, retrying a transient failure
 * a bounded number of times. Its only unique column is the tool-call link, so
 * a conflict on a repeat proves an earlier ambiguous attempt committed. */
async function writeImageUsage(write: () => Promise<unknown>): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await write();
      return;
    } catch (error) {
      if (attempt > 0 && databaseFailureCode(error) === "P2002") return;
      const delay = USAGE_WRITE_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !transientUsageWriteFailure(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

function databaseFields(error: unknown): Pick<EventFields["image_execution"], "prisma_code" | "db_failure"> {
  const code = databaseFailureCode(error);
  const kind = databaseFailureKind(error);
  return { ...(code === "unknown" ? {} : { prisma_code: code }), ...(kind ? { db_failure: kind } : {}) };
}

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
    resolveFor: resolver.resolveFor,
    async withConversationPixels(request: ProviderRunRequest, userId: string, signal?: AbortSignal): Promise<ProviderRunRequest> {
      const references = request.imageReferences;
      if (!request.modelCapabilities.vision || !references?.length) return request;
      const access = await resolveChatAccess(prisma, { chatId: request.chatId, userId });
      if (!access) throw new Error("image_access_revoked");
      const attached = new Set(request.attachments.map((attachment) => attachment.id));
      const currentImages = request.attachments.filter((attachment) => attachment.kind === "image").length;
      // A fresh image keeps only the newest earlier one for comparison.
      const historyLimit = currentImages > 0 ? 1 : 4;
      const imageLimit = Math.min(historyLimit, Math.max(0, (request.modelCapabilities.imageInputLimits?.imageCount ?? 20) - currentImages));
      const ids = imageLimit ? [...new Set(references.map((reference) => reference.attachmentId))].filter((id) => !attached.has(id)).slice(-imageLimit) : [];
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
      const visible = (attachments: readonly ProviderAttachment[]) => attachments
        .filter((attachment) => attachment.kind === "image" && (attachment.dataUrl || attachment.base64Data)).map((attachment) => attachment.id);
      const withSystem = (attachments: ProviderAttachment[], line: string): ProviderRunRequest => ({ ...request, attachments,
        prompt: { ...request.prompt, system: [request.prompt.system, line].filter(Boolean).join("\n\n") } });
      if (!extra.length) {
        return withSystem([...request.attachments], `Image pixels accompanying the latest user message, in order: ${JSON.stringify(visible(request.attachments))}. Additional images are references from earlier messages, not new uploads. Other image references have no visible pixels in this request.`);
      }
      // Earlier images go first and every image is captioned, so the newest
      // upload is the last image the model sees and is never read as history.
      const earlier = extra.map((attachment): ProviderAttachment => ({ ...attachment, imageProvenance: { role: "earlier_message",
        messageId: references.find((reference) => reference.attachmentId === attachment.id)!.messageId } }));
      const current = request.attachments.map((attachment): ProviderAttachment => attachment.kind === "image"
        ? { ...attachment, imageProvenance: { role: "current_message" } } : attachment);
      return withSystem([...earlier, ...current], `Image pixels in this request, in order. From earlier messages (references, not new uploads): ${JSON.stringify(visible(earlier))}. Accompanying the latest user message: ${JSON.stringify(visible(current))}. A caption before each image names its image_id and source message. Other image references have no visible pixels in this request.`);
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
    async restore(call: ModelToolCall, context: ImageToolContext): Promise<ToolExecutionResult | null> {
      if (!context.persistedToolCallId || !context.runId || !context.userId) return null;
      const attachment = await prisma.attachment.findFirst({ where: {
        imageToolCallId: context.persistedToolCallId, producerModelRunId: context.runId,
        chatId: context.request.chatId, origin: "IMAGE_OUTPUT", status: "ready"
      }, select: { metadata: true } });
      if (!attachment || !await resolveChatAccess(prisma, { chatId: context.request.chatId, userId: context.userId })) return null;
      const image = object(attachment.metadata) ? decodeThreadGeneratedImage(attachment.metadata.image) : null;
      return image ? result(call, image) : null;
    },
    async execute(call: ModelToolCall, context: ImageToolContext, signal?: AbortSignal, execution?: ImageExecutionOptions): Promise<ToolExecutionResult> {
      let stage: EventFields["image_execution"]["stage"] = "input";
      const startedAt = performance.now();
      try {
        const { runId, userId, persistedToolCallId: toolCallId, request } = context;
        const plan = request.imagePlan;
        if (!runId || !userId || !toolCallId || !plan || call.name !== IMAGE_GENERATION_TOOL_NAME) throw new Error("image_tool_unavailable");
        const args = call.arguments;
        if (!object(args) || Object.keys(args).some((key) => !["prompt", "image_ids", "parameters"].includes(key)) ||
          typeof args.prompt !== "string" || !args.prompt.trim() || args.prompt.length > IMAGE_MAX_PROMPT_CHARACTERS || args.prompt.includes("\u0000") ||
          !Array.isArray(args.image_ids) || args.image_ids.length > IMAGE_MAX_INPUTS ||
          !args.image_ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128) ||
          new Set(args.image_ids).size !== args.image_ids.length) throw new ImageInputError("image_input_invalid");
        const ids = args.image_ids as string[];
        stage = "binding";
        const binding = await prisma.providerRunBinding.findFirst({ where: { modelRunId: runId, bindingKey: "image", role: "image",
          connectionId: plan.authority.connectionId, providerModelId: plan.authority.providerModelId,
          credentialId: plan.authority.credentialId, credentialVersionId: plan.authority.credentialVersionId }, select: { executionSnapshot: true } });
        if (!binding) throw new Error("image_binding_unavailable");
        const snapshot = normalizeProviderExecutionSnapshot(binding.executionSnapshot);
        const model = snapshot.model;
        if (model.adapterKind === "fake" || !model.image || !(ids.length ? model.capabilities.imageEditing : model.capabilities.imageGeneration)) {
          throw new Error(ids.length ? "image_editing_unavailable" : "image_generation_unavailable");
        }
        stage = "input";
        let parameters: ImageGenerationParameters;
        try {
          const overrides = normalizeImageGenerationParameters(args.parameters ?? {}, model.image, model.upstreamModelId);
          parameters = normalizeImageGenerationParameters({ ...model.defaultParams, ...plan.parameters, ...overrides }, model.image, model.upstreamModelId);
        } catch { throw new ImageInputError("image_parameters_invalid"); }
        stage = "run";
        const existing = await service.restore(call, context);
        if (existing) return existing;
        const run = await prisma.modelRun.findFirst({ where: { id: runId, userId, chatId: request.chatId },
          select: { assistantMessageId: true, status: true } });
        if (!run?.assistantMessageId || !["streaming", "in_progress"].includes(run.status)) throw new Error("image_run_inactive");
        const access = await resolveChatAccess(prisma, { chatId: request.chatId, userId, requireMutable: true, minimumProjectRole: "CONTRIBUTOR" });
        if (!access) throw new Error("image_access_revoked");
        const tool = await prisma.modelRunToolCall.findFirst({ where: { id: toolCallId, modelRunId: runId,
          state: execution?.beforeDispatch ? "pending" : "running", toolName: call.name } });
        if (!tool) throw new Error("image_tool_not_claimed");
        if (await prisma.modelRunToolCall.count({ where: { modelRunId: runId, toolName: call.name, startedAt: { not: null } } }) > MAX_IMAGE_CALLS_PER_RUN) {
          throw new Error("image_tool_budget_exhausted");
        }
        stage = "references";
        const admitted = new Set(request.imageReferences?.map((reference) => reference.attachmentId) ?? []);
        const rows = ids.length ? await prisma.attachment.findMany({ where: {
          id: { in: ids }, status: "ready", savedAt: null,
          ...(access.kind === "project" ? { projectId: access.project.projectId } : { userId }),
          OR: [{ id: { in: [...admitted] } }, { origin: "IMAGE_OUTPUT", producerModelRunId: runId, chatId: request.chatId }]
        } }) : [];
        for (const id of ids) {
          if (!rows.some((row) => row.id === id)) throw new ImageInputError("image_reference_not_found", id);
        }
        if (rows.reduce((sum, row) => sum + row.byteSize, 0) > IMAGE_MAX_INPUT_BYTES) throw new ImageInputError("image_input_invalid");
        const images: ImageGenerationInput[] = [];
        for (const id of ids) {
          const row = rows.find((entry) => entry.id === id)!;
          stage = "reference_validation";
          if (row.kind !== "image" || !(IMAGE_MIME_TYPES as readonly string[]).includes(row.mimeType) || row.byteSize > IMAGE_MAX_BYTES) {
            throw new ImageInputError("image_reference_unsupported", id);
          }
          stage = "reference_read";
          let stored: Awaited<ReturnType<StorageAdapter["getObject"]>>;
          // Nothing has been sent yet, so a lost or unreadable reference is a
          // correctable refusal for the model, never a failed paid dispatch.
          try { stored = await storage.getObject(row.storageKey, { maxBytes: IMAGE_MAX_BYTES, signal }); }
          catch (error) {
            signal?.throwIfAborted();
            throw new ImageInputError(isStoredObjectMissingError(error) ? "image_reference_not_found"
              : isStoredObjectTooLargeError(error) ? "image_reference_invalid" : "image_reference_unavailable", id);
          }
          if (stored.body.byteLength !== row.byteSize || row.checksum && hash(stored.body) !== row.checksum) throw new ImageInputError("image_reference_invalid", id);
          stage = "reference_validation";
          try { await validateImageReference(stored.body, row.mimeType); }
          catch (error) {
            if (error instanceof ImageInputError) throw new ImageInputError(error.code, id);
            throw error;
          }
          images.push({ bytes: stored.body, mimeType: row.mimeType as ImageGenerationInput["mimeType"] });
        }
        stage = "authorization";
        if (!await service.authorize(plan)) throw new Error("image_provider_revoked");
        const adapter = createImageGenerationAdapter({ connection: snapshot.connection, model,
          observationIdentity: { adapterKind: model.adapterKind, connectionId: snapshot.connectionId,
            providerFamily: snapshot.providerFamily, providerModelId: snapshot.providerModelId },
          ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}), secret: async () => {
            const credential = await prisma.providerCredentialVersion.findFirst({ where: {
              id: plan.authority.credentialVersionId, credentialId: plan.authority.credentialId, revokedAt: null
            }, select: { id: true, credentialId: true, secretEnvelope: true } });
            if (!credential?.secretEnvelope || !await service.authorize(plan)) throw new Error("image_provider_revoked");
            return decryptProviderCredentialSecret({ credentialId: credential.credentialId, valueId: credential.id,
              envelope: credential.secretEnvelope, key: (options.encryptionKey ?? getSecretEncryptionKey)() });
          } });
        signal?.throwIfAborted();
        stage = "dispatch_claim";
        await execution?.beforeDispatch?.();
        signal?.throwIfAborted();
        // Image usage rows are immutable once written. A receipt for this tool
        // call proves an earlier paid dispatch, so a lost upload is never
        // regenerated.
        if (await prisma.usageEvent.findUnique({ where: { imageToolCallId: toolCallId }, select: { id: true } })) throw new Error("image_dispatch_claimed");
        // Read before dispatch, so only the usage write follows the paid call.
        stage = "usage";
        const costBasis = await loadProviderModelCostBasis(prisma, plan.authority.providerModelId);
        // Provider-reported accounting is recorded before any storage work, so
        // publication failure, access loss or a stale claim cannot lose it.
        // Nothing is estimated from pixels: the reported cost, else the model's
        // token prices on the reported tokens. The tool call's unique link keeps
        // it to one row, also proving the paid dispatch to any retry. The row
        // keeps the completeness its reported tokens prove.
        const recordUsage = (usage: ImageGenerationUsage) => writeImageUsage(() => {
          const tokens = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens };
          return prisma.usageEvent.create({ data: {
            imageGeneration: true, imageToolCallId: toolCallId, purpose: "image_generation",
            modelRunId: runId, userId, chatId: request.chatId,
            projectId: access.project?.projectId, provider: snapshot.providerFamily,
            providerModelId: plan.authority.providerModelId, modelId: model.upstreamModelId,
            ...storedTokenUsage(tokens),
            estimatedCostMicros: providerModelUsageCostMicros({ basis: costBasis, reportedCostUsd: usage.costUsd ?? null,
              usage: tokens }) } });
        });
        let generated: Awaited<ReturnType<typeof adapter.generate>>;
        try {
          stage = "provider";
          generated = await adapter.generate({ prompt: args.prompt, images, parameters, signal });
        } catch (error) {
          // A completed response whose image was rejected was still paid for;
          // the provider failure stays the reported outcome, and a usage row
          // still unwritten after the retries is reported, not swallowed.
          if (error instanceof ImageGenerationError && error.usage) {
            await recordUsage(error.usage).catch((usageError: unknown) => logEvent("image_execution", {
              stage: "usage", code: "image_usage_unrecorded", duration_ms: performance.now() - startedAt,
              error: usageError, ...databaseFields(usageError) }));
          }
          throw error;
        }
        stage = "usage";
        await recordUsage(generated.usage);
        const attachmentId = randomUUID();
        const token = randomUUID();
        const storageKey = `generated-images/${attachmentId}`;
        const image: ThreadGeneratedImage = { attachmentId, byteSize: generated.bytes.byteLength,
          fileName: `image-${attachmentId.slice(0, 8)}.${generated.mimeType.split("/")[1]}`, mimeType: generated.mimeType,
          width: generated.width, height: generated.height, sourceAttachmentIds: ids };
        stage = "storage";
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
          stage = "publication";
          await prisma.$transaction(async (tx) => {
            // Already received pixels retain the ordinary image publication rules
            // after Stop; usage is already settled. This grants no new execution.
            await execution?.beforeSettlement?.(tx);
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
            await tx.attachmentDeletionJob.delete({ where: { storageKey } });
            await execution?.onResult?.(tx, result(call, image));
          });
        } catch (error) {
          await prisma.attachmentDeletionJob.updateMany({ where: { storageKey, claimToken: token }, data: { claimToken: null, claimedAt: null } }).catch(() => undefined);
          throw error;
        }
        return result(call, image);
      } catch (error) {
        const code = observedFailureCode(error);
        // A refused input the model can correct, or a stop, warns; anything else is an image generation failure.
        const outcome = signal?.aborted === true ? "cancelled" : error instanceof ImageInputError ? "refused" : "failed";
        logEvent("image_execution", { stage, outcome, code: code === "unknown" ? "tool_call_failed" : code,
          duration_ms: performance.now() - startedAt, error, ...databaseFields(error),
          ...(error instanceof ImageGenerationError && error.finishReason ? { finish_reason: error.finishReason } : {}) });
        throw error;
      }
    }
  };
  return service;
}

export type ImageGenerationService = ReturnType<typeof createPrismaImageGenerationService>;
