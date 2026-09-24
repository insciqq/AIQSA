import { createHash } from "node:crypto";
import sharp from "sharp";
import { isSafeWorkspaceRelativePath } from "@/lib/domain/workspace";
import { readStreamWithAbort } from "../http/byteStream";
import { StaticRasterError, validateStaticRaster } from "../uploads/staticRaster";

export const WORKSPACE_IMAGE_LIMITS = Object.freeze({
  maxImages: 8, maxBytes: 24 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024,
  maxPixels: 16_777_216, maxDimension: 16_384, timeoutMs: 30_000
});

/** Server-owned immutable capture reference. Paths alone never implement this interface. */
export type WorkspaceImageSource = Readonly<{
  captureId: string;
  relativePath: string;
  byteSize: number;
  checksum: string;
  assertAccess(): Promise<void>;
  open(signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}>;

export type WorkspaceImageTransform = Readonly<{
  crop?: Readonly<{ left: number; top: number; width: number; height: number }>;
  /** Fit inside this box without enlargement, preserving the aspect ratio. */
  resize?: Readonly<{ width: number; height: number }>;
}>;

/** Private evidence metadata; it contains neither storage authority nor provider payload. */
export type WorkspaceImageDescriptor = Readonly<{
  version: 1;
  id: string;
  byteSize: number;
  checksum: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  frames: 1;
  source: Readonly<{ captureId: string; relativePath: string; byteSize: number; checksum: string; width: number; height: number }>;
  transform: WorkspaceImageTransform | null;
}>;

export type WorkspaceCapturedImage = Readonly<{
  descriptor: WorkspaceImageDescriptor;
  /** Reauthorizes before exposing bounded private bytes. Consumers own their wire format. */
  open(signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  dispose(): void;
}>;

export class WorkspaceImageError extends Error {
  constructor(readonly code: "workspace_image_invalid" | "workspace_image_unsupported" | "workspace_image_limit_exceeded" |
    "workspace_image_unavailable" | "workspace_image_cancelled") {
    super(code);
    this.name = "WorkspaceImageError";
  }
}

const invalid = () => new WorkspaceImageError("workspace_image_invalid");
const limit = () => new WorkspaceImageError("workspace_image_limit_exceeded");
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const integer = (value: unknown, minimum: number) => Number.isSafeInteger(value) && Number(value) >= minimum;

function transformation(value: WorkspaceImageTransform | undefined, width: number, height: number): WorkspaceImageTransform | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "crop" && key !== "resize")) throw invalid();
  const result: { crop?: WorkspaceImageTransform["crop"]; resize?: WorkspaceImageTransform["resize"] } = {};
  if (value.crop !== undefined) {
    const crop = value.crop;
    if (!crop || Object.keys(crop).some(key => !["left", "top", "width", "height"].includes(key)) ||
      !integer(crop.left, 0) || !integer(crop.top, 0) || !integer(crop.width, 1) || !integer(crop.height, 1) ||
      crop.left + crop.width > width || crop.top + crop.height > height) throw invalid();
    result.crop = Object.freeze({ left: crop.left, top: crop.top, width: crop.width, height: crop.height });
  }
  if (value.resize !== undefined) {
    const resize = value.resize;
    if (!resize || Object.keys(resize).some(key => key !== "width" && key !== "height") ||
      !integer(resize.width, 1) || !integer(resize.height, 1) || Math.max(resize.width, resize.height) > WORKSPACE_IMAGE_LIMITS.maxDimension ||
      resize.width * resize.height > WORKSPACE_IMAGE_LIMITS.maxPixels) throw invalid();
    result.resize = Object.freeze({ width: resize.width, height: resize.height });
  }
  if (!result.crop && !result.resize) throw invalid();
  return Object.freeze(result);
}

async function readSource(source: WorkspaceImageSource, signal: AbortSignal): Promise<Buffer> {
  await readStreamWithAbort(() => source.assertAccess(), signal);
  signal.throwIfAborted();
  const reader = (await source.open(signal)).getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await readStreamWithAbort(() => reader.read(), signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > source.byteSize) throw invalid();
      // Own each chunk; runtime/storage adapters may reuse their input buffer.
      chunks.push(Buffer.from(next.value));
    }
    if (total !== source.byteSize) throw invalid();
    const bytes = Buffer.concat(chunks, total);
    if (digest(bytes) !== source.checksum) throw invalid();
    return bytes;
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Validate and transform serially under batch bounds, independently of model capability. */
export async function prepareWorkspaceImages(inputs: readonly Readonly<{
  source: WorkspaceImageSource;
  transform?: WorkspaceImageTransform;
}>[], signal?: AbortSignal): Promise<readonly WorkspaceCapturedImage[]> {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > WORKSPACE_IMAGE_LIMITS.maxImages) throw limit();
  let sourceBytes = 0;
  for (const { source } of inputs) {
    if (!source || !/^[a-f0-9]{32}$/u.test(source.captureId) || !isSafeWorkspaceRelativePath(source.relativePath) ||
      !/^(inbox|project|output)\//u.test(source.relativePath) || !/^[a-f0-9]{64}$/u.test(source.checksum)) throw invalid();
    if (!integer(source.byteSize, 1) || source.byteSize > WORKSPACE_IMAGE_LIMITS.maxBytes) throw limit();
    sourceBytes += source.byteSize;
  }
  if (sourceBytes > WORKSPACE_IMAGE_LIMITS.maxTotalBytes) throw limit();
  const boundedSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(WORKSPACE_IMAGE_LIMITS.timeoutMs)]);
  const result: WorkspaceCapturedImage[] = [];
  let outputBytes = 0;
  try {
    for (const input of inputs) {
      const source = input.source;
      const bytes = await readSource(source, boundedSignal);
      const metadata = await validateStaticRaster(bytes, { ...WORKSPACE_IMAGE_LIMITS, mimeTypes: ["image/png", "image/jpeg"] }, { signal: boundedSignal });
      const transform = transformation(input.transform, metadata.width, metadata.height);
      let output = bytes;
      let dimensions = metadata;
      if (transform) {
        try {
          let pipeline = sharp(bytes, { limitInputPixels: WORKSPACE_IMAGE_LIMITS.maxPixels, failOn: "warning" }).timeout({ seconds: 8 });
          if (transform.crop) pipeline = pipeline.extract(transform.crop);
          if (transform.resize) pipeline = pipeline.resize({ ...transform.resize, fit: "inside", withoutEnlargement: true });
          output = await pipeline.png().toBuffer();
        } catch { throw invalid(); }
        dimensions = await validateStaticRaster(output, { ...WORKSPACE_IMAGE_LIMITS, mimeTypes: ["image/png"] }, { signal: boundedSignal });
      }
      outputBytes += output.byteLength;
      if (outputBytes > WORKSPACE_IMAGE_LIMITS.maxTotalBytes) throw limit();
      await readStreamWithAbort(() => source.assertAccess(), boundedSignal);
      boundedSignal.throwIfAborted();
      const descriptor: WorkspaceImageDescriptor = Object.freeze({
        version: 1, id: digest(JSON.stringify(["workspace-image-v1", source.captureId, source.relativePath, source.checksum, transform])),
        byteSize: output.byteLength, checksum: digest(output), mimeType: dimensions.mimeType as "image/png" | "image/jpeg",
        width: dimensions.width, height: dimensions.height, frames: 1,
        source: Object.freeze({ captureId: source.captureId, relativePath: source.relativePath, byteSize: source.byteSize,
          checksum: source.checksum, width: metadata.width, height: metadata.height }), transform
      });
      let retained: Buffer | null = output;
      result.push({ descriptor, dispose() { retained = null; }, async open(readSignal) {
        readSignal?.throwIfAborted();
        await source.assertAccess();
        if (!retained) throw new WorkspaceImageError("workspace_image_unavailable");
        let offset = 0;
        return new ReadableStream<Uint8Array>({ async pull(controller) {
          try {
            readSignal?.throwIfAborted();
            signal?.throwIfAborted();
            await source.assertAccess();
            readSignal?.throwIfAborted();
            signal?.throwIfAborted();
            if (!retained) throw new WorkspaceImageError("workspace_image_unavailable");
            if (offset === retained.length) { controller.close(); return; }
            const end = Math.min(offset + 64 * 1024, retained.length);
            controller.enqueue(new Uint8Array(retained.subarray(offset, end)));
            offset = end;
          } catch (error) { controller.error(error); }
        } }, { highWaterMark: 0 });
      } });
    }
    return result;
  } catch (error) {
    for (const image of result) image.dispose();
    if (boundedSignal.aborted) throw new WorkspaceImageError("workspace_image_cancelled");
    if (error instanceof StaticRasterError) throw new WorkspaceImageError(error.code === "raster_unsupported" ? "workspace_image_unsupported"
      : error.code === "raster_limit_exceeded" ? "workspace_image_limit_exceeded" : "workspace_image_invalid");
    throw error;
  }
}
