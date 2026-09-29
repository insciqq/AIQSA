import { Readable } from "node:stream";
import type { BucketSettings, MigrationBucket } from "@/lib/server/storageMigration/s3Bucket";

export type MemoryObject = { bytes: Buffer; contentType: string; encrypted?: boolean };

export type MemoryMigrationBucket = MigrationBucket & {
  calls: string[];
  exists_: boolean;
  /** Test hook invoked before each object write; throw to inject a failure. */
  beforePut?: (key: string) => void;
  /** Test hook that replaces bytes after a write, modelling corruption. */
  corrupt?: (key: string, bytes: Buffer) => Buffer;
  objects: Map<string, MemoryObject>;
  settings_: BucketSettings;
  uploads: Map<string, { contentType: string; key: string; parts: Map<number, Buffer> }>;
};

async function collect(body: Readable | Uint8Array): Promise<Buffer> {
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

export function createMemoryMigrationBucket(
  objects: Record<string, MemoryObject> = {},
  exists = true
): MemoryMigrationBucket {
  let nextUpload = 0;
  const bucket: MemoryMigrationBucket = {
    calls: [],
    exists_: exists,
    objects: new Map(Object.entries(objects)),
    settings_: { encryption: false, objectLock: false, policy: false, versioning: false },
    uploads: new Map(),
    async abortMultipartUploads() {
      const count = bucket.uploads.size;
      bucket.uploads.clear();
      return count;
    },
    async abortMultipart(_key, uploadId) {
      bucket.calls.push("abortMultipart");
      bucket.uploads.delete(uploadId);
    },
    async completeMultipart(key, uploadId, parts) {
      const upload = bucket.uploads.get(uploadId);
      if (!upload || upload.key !== key) throw Object.assign(new Error("NoSuchUpload"), { name: "NoSuchUpload" });
      const bytes = Buffer.concat(parts.map(({ partNumber }) => upload.parts.get(partNumber)!));
      bucket.objects.set(key, { bytes: bucket.corrupt?.(key, bytes) ?? bytes, contentType: upload.contentType });
      bucket.uploads.delete(uploadId);
    },
    async createBucket() {
      bucket.calls.push("createBucket");
      bucket.exists_ = true;
    },
    async createMultipart(key, contentType) {
      bucket.calls.push("createMultipart");
      const id = `upload-${nextUpload += 1}`;
      bucket.uploads.set(id, { contentType, key, parts: new Map() });
      return id;
    },
    async exists() {
      return bucket.exists_;
    },
    async head(key) {
      const object = bucket.objects.get(key);
      return object
        ? { byteSize: object.bytes.byteLength, contentType: object.contentType, encrypted: object.encrypted ?? false }
        : null;
    },
    async listPage(token, limit) {
      if (!bucket.exists_) throw Object.assign(new Error("NoSuchBucket"), { name: "NoSuchBucket" });
      const keys = [...bucket.objects.keys()].sort().filter((key) => token === undefined || key > token);
      const page = keys.slice(0, limit);
      return {
        next: keys.length > limit ? page[page.length - 1] : undefined,
        objects: page.map((key) => ({ byteSize: bucket.objects.get(key)!.bytes.byteLength, key }))
      };
    },
    async put(key, body, byteSize, contentType) {
      bucket.calls.push("put");
      bucket.beforePut?.(key);
      const bytes = await collect(body);
      if (bytes.byteLength !== byteSize) throw new Error("size_mismatch");
      bucket.objects.set(key, { bytes: bucket.corrupt?.(key, bytes) ?? bytes, contentType });
    },
    async read(key, range) {
      const object = bucket.objects.get(key);
      if (!object) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
      const bytes = range ? object.bytes.subarray(range.start, range.end + 1) : object.bytes;
      return {
        body: Readable.from(bytes.byteLength > 0 ? [bytes] : []),
        byteSize: bytes.byteLength,
        contentType: object.contentType,
        encrypted: object.encrypted ?? false
      };
    },
    async readSmall(key, maxBytes) {
      const object = bucket.objects.get(key);
      if (!object) return null;
      if (object.bytes.byteLength > maxBytes) throw new Error("too_large");
      return object.bytes;
    },
    async settings() {
      return bucket.settings_;
    },
    async uploadPart(key, uploadId, partNumber, body, byteSize) {
      bucket.calls.push("uploadPart");
      const upload = bucket.uploads.get(uploadId);
      if (!upload || upload.key !== key) throw new Error("NoSuchUpload");
      const bytes = await collect(body);
      if (bytes.byteLength !== byteSize) throw new Error("size_mismatch");
      upload.parts.set(partNumber, bytes);
      return `"etag-${partNumber}"`;
    }
  };
  return bucket;
}
