import { describe, expect, it } from "vitest";
import { createS3StorageAdapter } from "./storage";

describe("direct multipart part URLs", () => {
  it("sign only the public host and carry no SDK checksum of an empty body", async () => {
    const storage = createS3StorageAdapter({
      S3_ACCESS_KEY_ID: "access",
      S3_BUCKET: "aiqsa-uploads",
      S3_ENDPOINT: "http://minio:9000",
      S3_PUBLIC_ENDPOINT: "https://objects.example.test",
      S3_REGION: "us-east-1",
      S3_SECRET_ACCESS_KEY: "secret"
    });
    const url = new URL(await storage.directMultipartUpload!.presignMultipartPart({
      expiresInSeconds: 900,
      partNumber: 2,
      storageKey: "knowledge/objects/part-test",
      uploadId: "upload-1"
    }));

    expect(url.origin).toBe("https://objects.example.test");
    expect(url.pathname).toBe("/aiqsa-uploads/knowledge/objects/part-test");
    expect(url.searchParams.get("partNumber")).toBe("2");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect([...url.searchParams.keys()].filter((key) => /checksum/iu.test(key))).toEqual([]);
  });
});
