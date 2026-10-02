import { Readable } from "node:stream";
import type { MigrationBucket } from "@/lib/server/storageMigration/s3Bucket";

export type MemoryObject = { bytes: Buffer; contentType: string };

export type MemoryMigrationBucket = MigrationBucket & {
  calls: string[];
  exists_: boolean;
  objects: Map<string, MemoryObject>;
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
  const bucket: MemoryMigrationBucket = {
    calls: [],
    exists_: exists,
    objects: new Map(Object.entries(objects)),
    async createBucket() {
      bucket.calls.push("createBucket");
      bucket.exists_ = true;
    },
    async exists() {
      return bucket.exists_;
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
      const bytes = await collect(body);
      if (bytes.byteLength !== byteSize) throw new Error("size_mismatch");
      bucket.objects.set(key, { bytes, contentType });
    },
    async readSmall(key, maxBytes) {
      const object = bucket.objects.get(key);
      if (!object) return null;
      if (object.bytes.byteLength > maxBytes) throw new Error("too_large");
      return object.bytes;
    }
  };
  return bucket;
}
