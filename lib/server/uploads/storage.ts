import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type StoredObjectInput = {
  body: Buffer;
  contentType: string;
  storageKey: string;
};

export type StorageAdapter = {
  deleteObject(storageKey: string): Promise<void>;
  getObject(storageKey: string): Promise<StoredObjectInput>;
  putObject(input: StoredObjectInput): Promise<void>;
};

export function createMemoryStorageAdapter(): StorageAdapter & { objects: Map<string, StoredObjectInput> } {
  const objects = new Map<string, StoredObjectInput>();

  return {
    objects,
    async deleteObject(storageKey) {
      objects.delete(storageKey);
    },
    async getObject(storageKey) {
      const object = objects.get(storageKey);

      if (!object) {
        throw new Error("stored_object_not_found");
      }

      return object;
    },
    async putObject(input) {
      objects.set(input.storageKey, input);
    }
  };
}

export function createFileSystemStorageAdapter(root: string): StorageAdapter {
  return {
    async deleteObject(storageKey) {
      await rm(join(root, storageKey), { force: true });
    },
    async getObject(storageKey) {
      return {
        body: await readFile(join(root, storageKey)),
        contentType: "application/octet-stream",
        storageKey
      };
    },
    async putObject(input) {
      const path = join(root, input.storageKey);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, input.body);
    }
  };
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

async function s3BodyToBuffer(body: unknown): Promise<Buffer> {
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  if (typeof body === "object" && body !== null && "transformToByteArray" in body) {
    const transformer = body as { transformToByteArray(): Promise<Uint8Array> };

    return Buffer.from(await transformer.transformToByteArray());
  }

  if (typeof body === "object" && body !== null && Symbol.asyncIterator in body) {
    return streamToBuffer(body as NodeJS.ReadableStream);
  }

  throw new Error("unsupported_stored_object_body");
}

export function createS3StorageAdapter(env: Record<string, string | undefined> = process.env): StorageAdapter {
  const bucket = env.S3_BUCKET;
  const endpoint = env.S3_ENDPOINT;

  if (!bucket || !endpoint || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
    return createFileSystemStorageAdapter(env.AIQSA_UPLOAD_STORAGE_DIR || ".aiqsa/uploads");
  }

  const client = new S3Client({
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY
    },
    endpoint,
    forcePathStyle: true,
    region: env.S3_REGION || "us-east-1"
  });

  return {
    async deleteObject(storageKey) {
      await client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: storageKey
        })
      );
    },
    async getObject(storageKey) {
      const output = await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: storageKey
        })
      );

      return {
        body: await s3BodyToBuffer(output.Body),
        contentType: output.ContentType ?? "application/octet-stream",
        storageKey
      };
    },
    async putObject(input) {
      await client.send(
        new PutObjectCommand({
          Body: input.body,
          Bucket: bucket,
          ContentType: input.contentType,
          Key: input.storageKey
        })
      );
    }
  };
}
