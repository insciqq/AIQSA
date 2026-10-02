import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { StorageMigrationError } from "./marker";

export type ListedObject = Readonly<{ byteSize: number; key: string }>;

/** The bucket operations the storage guard and its status command need. */
export type MigrationBucket = Readonly<{
  createBucket(): Promise<void>;
  exists(): Promise<boolean>;
  listPage(token: string | undefined, limit: number): Promise<Readonly<{ next: string | undefined; objects: ListedObject[] }>>;
  put(key: string, body: Readable | Uint8Array, byteSize: number, contentType: string, signal: AbortSignal): Promise<void>;
  readSmall(key: string, maxBytes: number): Promise<Buffer | null>;
}>;

type SdkError = { $metadata?: { httpStatusCode?: number }; Code?: string; name?: string };

function sdkError(error: unknown): SdkError {
  return typeof error === "object" && error !== null ? error as SdkError : {};
}

function missing(error: unknown, ...names: string[]): boolean {
  const record = sdkError(error);
  return names.includes(record.name ?? "") || names.includes(record.Code ?? "") ||
    (names.includes("404") && record.$metadata?.httpStatusCode === 404);
}

const SAFE_ERROR_NAMES = new Set([
  "AccessDenied", "InvalidAccessKeyId", "NoSuchBucket", "NoSuchKey", "NoSuchUpload",
  "SignatureDoesNotMatch", "SlowDown", "ServiceUnavailable", "InternalError", "EntityTooLarge",
  "RequestTimeout", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EPIPE", "AbortError"
]);

/** A content-free code for a storage, filesystem or database failure. */
export function storageFailureCode(error: unknown): string {
  if (error instanceof StorageMigrationError) return error.code;
  const record = sdkError(error) as SdkError & { code?: unknown };
  for (const candidate of [record.name, record.Code, record.code]) {
    if (typeof candidate === "string" && SAFE_ERROR_NAMES.has(candidate)) return candidate;
  }
  if (typeof record.code === "string" && /^(?:E[A-Z]{2,15}|P\d{4})$/u.test(record.code)) return record.code;
  // Owned guards throw snake_case codes as messages; nothing else is echoed.
  if (error instanceof Error && /^(?:knowledge|storage)_[a-z0-9_]{2,60}$/u.test(error.message)) return error.message;
  const status = record.$metadata?.httpStatusCode;
  return Number.isSafeInteger(status) ? `http_${status}` : "storage_request_failed";
}

function bodyStream(body: unknown): Readable {
  if (body instanceof Readable) return body;
  if (typeof body === "object" && body !== null && "transformToWebStream" in body) {
    const web = (body as { transformToWebStream(): ReadableStream<Uint8Array> }).transformToWebStream();
    return Readable.fromWeb(web as import("node:stream/web").ReadableStream<Uint8Array>);
  }
  throw new StorageMigrationError("storage_object_body_unsupported");
}

export function createMigrationS3Client(
  input: Readonly<{ accessKeyId: string; endpoint: string; region: string; secretAccessKey: string }>
): S3Client {
  return new S3Client({
    credentials: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey },
    endpoint: input.endpoint,
    forcePathStyle: true,
    region: input.region,
    // The guard moves only the small marker; SDK checksums stay opt-in.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED"
  });
}

export function createS3MigrationBucket(client: S3Client, bucket: string): MigrationBucket {
  return {
    async createBucket() {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      } catch (error) {
        if (!missing(error, "BucketAlreadyOwnedByYou")) throw error;
      }
    },
    async exists() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
        return true;
      } catch (error) {
        if (missing(error, "NotFound", "NoSuchBucket", "404")) return false;
        throw error;
      }
    },
    async listPage(token, limit) {
      const page = await client.send(new ListObjectsV2Command({
        Bucket: bucket, ContinuationToken: token, MaxKeys: limit
      }));
      const objects: ListedObject[] = [];
      for (const item of page.Contents ?? []) {
        if (typeof item.Key !== "string" || !Number.isSafeInteger(item.Size) || Number(item.Size) < 0) {
          throw new StorageMigrationError("storage_listing_invalid");
        }
        objects.push({ byteSize: Number(item.Size), key: item.Key });
      }
      if (page.IsTruncated && !page.NextContinuationToken) throw new StorageMigrationError("storage_listing_invalid");
      return { next: page.IsTruncated ? page.NextContinuationToken : undefined, objects };
    },
    async put(key, body, byteSize, contentType, signal) {
      await client.send(new PutObjectCommand({
        Body: body, Bucket: bucket, ContentLength: byteSize, ContentType: contentType, Key: key
      }), { abortSignal: signal });
    },
    async readSmall(key, maxBytes) {
      let output;
      try {
        output = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      } catch (error) {
        if (missing(error, "NoSuchKey", "NoSuchBucket", "NotFound", "404")) return null;
        throw error;
      }
      const stream = bodyStream(output.Body);
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of stream) {
        total += (chunk as Buffer).byteLength;
        if (total > maxBytes) {
          stream.destroy();
          throw new StorageMigrationError("storage_marker_invalid");
        }
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks, total);
    }
  };
}
