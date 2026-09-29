import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetBucketEncryptionCommand,
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { StorageMigrationError } from "./marker";

export type ObjectHead = Readonly<{ byteSize: number; contentType: string; encrypted: boolean }>;
export type ListedObject = Readonly<{ byteSize: number; key: string }>;
export type ObjectRead = ObjectHead & Readonly<{ body: Readable }>;
export type BucketSettings = Readonly<{
  encryption: boolean;
  objectLock: boolean;
  policy: boolean;
  versioning: boolean;
}>;

/** The bucket operations the storage guard and the copier need. */
export type MigrationBucket = Readonly<{
  abortMultipartUploads(): Promise<number>;
  completeMultipart(key: string, uploadId: string, parts: readonly Readonly<{ etag: string; partNumber: number }>[]): Promise<void>;
  createBucket(): Promise<void>;
  createMultipart(key: string, contentType: string): Promise<string>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
  exists(): Promise<boolean>;
  head(key: string): Promise<ObjectHead | null>;
  listPage(token: string | undefined, limit: number): Promise<Readonly<{ next: string | undefined; objects: ListedObject[] }>>;
  put(key: string, body: Readable | Uint8Array, byteSize: number, contentType: string, signal: AbortSignal): Promise<void>;
  read(key: string, range?: Readonly<{ end: number; start: number }>): Promise<ObjectRead>;
  readSmall(key: string, maxBytes: number): Promise<Buffer | null>;
  settings(): Promise<BucketSettings>;
  uploadPart(key: string, uploadId: string, partNumber: number, body: Readable, byteSize: number, signal: AbortSignal): Promise<string>;
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

function head(output: { ContentLength?: number; ContentType?: string; ServerSideEncryption?: string; SSECustomerAlgorithm?: string }): ObjectHead {
  const byteSize = output.ContentLength;
  if (!Number.isSafeInteger(byteSize) || Number(byteSize) < 0) {
    throw new StorageMigrationError("storage_object_metadata_invalid");
  }
  return {
    byteSize: Number(byteSize),
    contentType: output.ContentType ?? "",
    encrypted: Boolean(output.ServerSideEncryption || output.SSECustomerAlgorithm)
  };
}

export function createMigrationS3Client(
  input: Readonly<{ accessKeyId: string; endpoint: string; region: string; secretAccessKey: string }>
): S3Client {
  return new S3Client({
    credentials: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey },
    endpoint: input.endpoint,
    forcePathStyle: true,
    region: input.region,
    // Integrity is proven by SHA-256 of the transferred bytes.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED"
  });
}

export function createS3MigrationBucket(client: S3Client, bucket: string): MigrationBucket {
  return {
    async abortMultipartUploads() {
      let aborted = 0;
      let keyMarker: string | undefined;
      let uploadIdMarker: string | undefined;
      for (;;) {
        const page = await client.send(new ListMultipartUploadsCommand({
          Bucket: bucket, KeyMarker: keyMarker, MaxUploads: 1_000, UploadIdMarker: uploadIdMarker
        }));
        for (const upload of page.Uploads ?? []) {
          if (!upload.Key || !upload.UploadId) continue;
          await this.abortMultipart(upload.Key, upload.UploadId);
          aborted += 1;
        }
        if (!page.IsTruncated || (!page.NextKeyMarker && !page.NextUploadIdMarker)) return aborted;
        keyMarker = page.NextKeyMarker;
        uploadIdMarker = page.NextUploadIdMarker;
      }
    },
    async abortMultipart(key, uploadId) {
      try {
        await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
      } catch (error) {
        if (!missing(error, "NoSuchUpload", "404")) throw error;
      }
    },
    async completeMultipart(key, uploadId, parts) {
      await client.send(new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        MultipartUpload: { Parts: parts.map(({ etag, partNumber }) => ({ ETag: etag, PartNumber: partNumber })) },
        UploadId: uploadId
      }));
    },
    async createBucket() {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      } catch (error) {
        if (!missing(error, "BucketAlreadyOwnedByYou")) throw error;
      }
    },
    async createMultipart(key, contentType) {
      const created = await client.send(new CreateMultipartUploadCommand({
        Bucket: bucket, ContentType: contentType, Key: key
      }));
      if (!created.UploadId) throw new StorageMigrationError("storage_multipart_upload_id_missing");
      return created.UploadId;
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
    async head(key) {
      try {
        return head(await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })));
      } catch (error) {
        if (missing(error, "NotFound", "NoSuchKey", "404")) return null;
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
    async read(key, range) {
      const output = await client.send(new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: range ? `bytes=${range.start}-${range.end}` : undefined
      }));
      return { ...head(output), body: bodyStream(output.Body) };
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
    },
    async settings() {
      const versioning = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
      let encryption = false;
      try {
        const config = await client.send(new GetBucketEncryptionCommand({ Bucket: bucket }));
        encryption = (config.ServerSideEncryptionConfiguration?.Rules ?? []).length > 0;
      } catch (error) {
        if (!missing(error, "ServerSideEncryptionConfigurationNotFoundError", "404")) throw error;
      }
      let objectLock = false;
      try {
        const config = await client.send(new GetObjectLockConfigurationCommand({ Bucket: bucket }));
        objectLock = config.ObjectLockConfiguration?.ObjectLockEnabled === "Enabled";
      } catch (error) {
        if (!missing(error, "ObjectLockConfigurationNotFoundError", "404")) throw error;
      }
      let policy = false;
      try {
        const config = await client.send(new GetBucketPolicyCommand({ Bucket: bucket }));
        policy = Boolean(config.Policy?.trim());
      } catch (error) {
        if (!missing(error, "NoSuchBucketPolicy", "404")) throw error;
      }
      return {
        encryption,
        objectLock,
        policy,
        versioning: versioning.Status === "Enabled" || versioning.Status === "Suspended"
      };
    },
    async uploadPart(key, uploadId, partNumber, body, byteSize, signal) {
      const part = await client.send(new UploadPartCommand({
        Body: body, Bucket: bucket, ContentLength: byteSize, Key: key, PartNumber: partNumber, UploadId: uploadId
      }), { abortSignal: signal });
      if (!part.ETag) throw new StorageMigrationError("storage_multipart_etag_missing");
      return part.ETag;
    }
  };
}
