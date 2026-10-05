import { createHash } from "node:crypto";
import sharp from "sharp";
import type { PrismaClient } from "@prisma/client";
import { resolveChatAccess } from "../projects/access";
import { extractImageMetadata } from "../uploads/imageMetadata";
import { StaticRasterError, validateStaticRaster, type StaticRasterMetadata } from "../uploads/staticRaster";
import { isStoredObjectTooLargeError, type StorageAdapter } from "../uploads/storage";
import { transformStaticImage, WORKSPACE_IMAGE_LIMITS, WorkspaceImageError, type WorkspaceImageTransform } from "../workspace/imageCapture";
import { VisionAnalysisError } from "./store";

/** Conversation images reach System Vision within the Workspace capture bounds. */
const LIMITS = WORKSPACE_IMAGE_LIMITS;
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export type ConversationImageInput = Readonly<{ imageId: string; transform?: WorkspaceImageTransform }>;

/** Private evidence metadata: the source attachment identity and geometry, and
 * exactly what reached the Vision request. No storage authority or pixels. */
export type ConversationImageDescriptor = Readonly<{
  version: 1;
  id: string;
  byteSize: number;
  checksum: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  frames: 1;
  source: Readonly<{ attachmentId: string; mimeType: string; byteSize: number; checksum: string; width: number; height: number }>;
  transform: WorkspaceImageTransform | null;
}>;

export type ConversationVisionImage = Readonly<{
  descriptor: ConversationImageDescriptor;
  open(signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  dispose(): void;
}>;

export class ConversationImageError extends Error {
  constructor(readonly code: "chat_image_unavailable" | "chat_image_unsupported" | "chat_image_invalid" | "chat_image_limit_exceeded") {
    super(code);
    this.name = "ConversationImageError";
  }
}

/** Only an opaque conversation image handle, never a storage key, URL or name. */
export function conversationImageInput(value: unknown): ConversationImageInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VisionAnalysisError("vision_analysis_input_invalid");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["image_id", "crop", "resize"].includes(key)) || typeof input.image_id !== "string" ||
    !input.image_id || input.image_id.length > 128) throw new VisionAnalysisError("vision_analysis_input_invalid");
  // The shared decoder validates the geometry against the actual dimensions.
  const transform = input.crop !== undefined || input.resize !== undefined ? {
    ...(input.crop !== undefined ? { crop: input.crop as NonNullable<WorkspaceImageTransform["crop"]> } : {}),
    ...(input.resize !== undefined ? { resize: input.resize as NonNullable<WorkspaceImageTransform["resize"]> } : {})
  } : undefined;
  return { imageId: input.image_id, ...(transform ? { transform } : {}) };
}

type ImageRow = Readonly<{ id: string; storageKey: string; byteSize: number; checksum: string | null; mimeType: string }>;
type Decoded = Readonly<{ bytes: Buffer; metadata: StaticRasterMetadata; checksum: string; width: number; height: number }>;

/**
 * Chat images for System Vision under the run's current chat authority: the
 * user's own attachments in a personal chat, the Project's in a Project chat,
 * limited to the references admitted with the run and images this run
 * generated. PNG and JPEG reach Vision as stored; WebP and a static GIF are
 * decoded to PNG; any other format is refused before dispatch.
 */
export function createConversationImageSource(db: PrismaClient, storage: Pick<StorageAdapter, "getObject">) {
  async function load(input: Readonly<{ runId: string; userId: string; chatId: string; admittedImageIds: readonly string[] }>,
    imageIds: readonly string[]): Promise<ImageRow[]> {
    const access = await resolveChatAccess(db, { chatId: input.chatId, userId: input.userId });
    if (!access) throw new VisionAnalysisError("vision_analysis_access_denied");
    return db.attachment.findMany({ where: { id: { in: [...imageIds] }, kind: "image", status: "ready", savedAt: null,
      ...(access.kind === "project" ? { projectId: access.project.projectId } : { userId: input.userId }),
      OR: [{ id: { in: [...input.admittedImageIds] } }, { origin: "IMAGE_OUTPUT", producerModelRunId: input.runId, chatId: input.chatId }]
    }, select: { id: true, storageKey: true, byteSize: true, checksum: true, mimeType: true } });
  }

  async function png(bytes: Buffer, checksum: string, signal: AbortSignal): Promise<Decoded> {
    let output: Buffer;
    try {
      output = await sharp(bytes, { limitInputPixels: LIMITS.maxPixels, failOn: "warning" }).timeout({ seconds: 8 }).png().toBuffer();
    } catch {
      signal.throwIfAborted();
      throw new ConversationImageError("chat_image_invalid");
    }
    const metadata = await validateStaticRaster(output, { ...LIMITS, mimeTypes: ["image/png"] }, { signal });
    return { bytes: output, metadata, checksum, width: metadata.width, height: metadata.height };
  }

  async function decode(row: ImageRow, signal: AbortSignal): Promise<Decoded> {
    let body: Buffer;
    try {
      body = Buffer.from((await storage.getObject(row.storageKey, { maxBytes: row.byteSize, signal })).body);
    } catch (error) {
      signal.throwIfAborted();
      throw new ConversationImageError(isStoredObjectTooLargeError(error) ? "chat_image_invalid" : "chat_image_unavailable");
    }
    const checksum = digest(body);
    if (body.byteLength !== row.byteSize || row.checksum && checksum !== row.checksum) throw new ConversationImageError("chat_image_invalid");
    if (body.subarray(0, 4).toString("ascii") === "GIF8") {
      if (row.mimeType !== "image/gif") throw new ConversationImageError("chat_image_invalid");
      let gif: ReturnType<typeof extractImageMetadata>;
      try { gif = extractImageMetadata(body, "image/gif"); } catch { throw new ConversationImageError("chat_image_invalid"); }
      // Upload admission refuses animated GIFs; one that reaches here is refused too.
      if (gif.animated) throw new ConversationImageError("chat_image_unsupported");
      if (gif.width * gif.height > LIMITS.maxPixels || Math.max(gif.width, gif.height) > LIMITS.maxDimension) {
        throw new ConversationImageError("chat_image_limit_exceeded");
      }
      return png(body, checksum, signal);
    }
    const metadata = await validateStaticRaster(body, { ...LIMITS, mimeTypes: ["image/png", "image/jpeg", "image/webp"] },
      { declaredMime: row.mimeType, signal });
    return metadata.mimeType === "image/webp" ? png(body, checksum, signal)
      : { bytes: body, metadata, checksum, width: metadata.width, height: metadata.height };
  }

  return {
    /** Reads, validates and converts the requested images in the given order;
     * `assertAccess` rechecks the same authority right before dispatch. */
    async prepare(input: Readonly<{ runId: string; userId: string; chatId: string; admittedImageIds: readonly string[];
      images: readonly ConversationImageInput[] }>, signal: AbortSignal): Promise<Readonly<{
      images: readonly ConversationVisionImage[]; assertAccess(): Promise<void>;
    }>> {
      if (!input.images.length || input.images.length > LIMITS.maxImages) throw new ConversationImageError("chat_image_limit_exceeded");
      const imageIds = [...new Set(input.images.map(image => image.imageId))];
      const rows = await load(input, imageIds);
      if (rows.length !== imageIds.length) throw new ConversationImageError("chat_image_unavailable");
      let sourceBytes = 0;
      for (const row of rows) {
        if (!Number.isSafeInteger(row.byteSize) || row.byteSize < 1 || row.byteSize > LIMITS.maxBytes) {
          throw new ConversationImageError("chat_image_limit_exceeded");
        }
        sourceBytes += row.byteSize;
      }
      if (sourceBytes > LIMITS.maxTotalBytes) throw new ConversationImageError("chat_image_limit_exceeded");
      const result: ConversationVisionImage[] = [];
      try {
        const decoded = new Map<string, Decoded>();
        let outputBytes = 0;
        for (const image of input.images) {
          const row = rows.find(candidate => candidate.id === image.imageId)!;
          const source = decoded.get(row.id) ?? await decode(row, signal);
          decoded.set(row.id, source);
          const { output, dimensions, transform } = await transformStaticImage(source.bytes, source.metadata, image.transform, signal);
          outputBytes += output.byteLength;
          if (outputBytes > LIMITS.maxTotalBytes) throw new ConversationImageError("chat_image_limit_exceeded");
          signal.throwIfAborted();
          const descriptor: ConversationImageDescriptor = Object.freeze({
            version: 1, id: digest(JSON.stringify(["conversation-image-v1", row.id, source.checksum, transform])),
            byteSize: output.byteLength, checksum: digest(output), mimeType: dimensions.mimeType as "image/png" | "image/jpeg",
            width: dimensions.width, height: dimensions.height, frames: 1,
            source: Object.freeze({ attachmentId: row.id, mimeType: row.mimeType, byteSize: row.byteSize,
              checksum: source.checksum, width: source.width, height: source.height }), transform
          });
          let retained: Buffer | null = output;
          result.push({ descriptor, dispose() { retained = null; }, async open(readSignal) {
            readSignal?.throwIfAborted();
            const bytes = retained;
            if (!bytes) throw new ConversationImageError("chat_image_unavailable");
            return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(bytes)); controller.close(); } });
          } });
        }
      } catch (error) {
        for (const image of result) image.dispose();
        signal.throwIfAborted();
        if (error instanceof StaticRasterError) throw new ConversationImageError(error.code === "raster_unsupported" ? "chat_image_unsupported"
          : error.code === "raster_limit_exceeded" ? "chat_image_limit_exceeded" : "chat_image_invalid");
        if (error instanceof WorkspaceImageError) throw new ConversationImageError("chat_image_invalid");
        throw error;
      }
      return { images: result, async assertAccess() {
        if ((await load(input, imageIds)).length !== imageIds.length) throw new ConversationImageError("chat_image_unavailable");
      } };
    }
  };
}

export type ConversationImageSource = ReturnType<typeof createConversationImageSource>;
