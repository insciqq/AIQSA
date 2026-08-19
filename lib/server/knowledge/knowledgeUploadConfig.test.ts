import { describe, expect, it } from "vitest";
import {
  DEFAULT_KNOWLEDGE_UPLOAD_MAX_BATCH_FILES,
  DEFAULT_KNOWLEDGE_UPLOAD_SESSION_SECONDS,
  getKnowledgeUploadConfig,
  KNOWLEDGE_UPLOAD_MULTIPART_PART_BYTES
} from "./knowledgeUploadConfig";

describe("Knowledge upload configuration", () => {
  it("keeps a production-safe 100-file default and fixed bounded sessions", () => {
    expect(getKnowledgeUploadConfig({})).toEqual({
      maxBatchFiles: DEFAULT_KNOWLEDGE_UPLOAD_MAX_BATCH_FILES,
      multipartPartBytes: KNOWLEDGE_UPLOAD_MULTIPART_PART_BYTES,
      sessionSeconds: DEFAULT_KNOWLEDGE_UPLOAD_SESSION_SECONDS
    });
    expect(DEFAULT_KNOWLEDGE_UPLOAD_MAX_BATCH_FILES).toBeGreaterThanOrEqual(100);
    expect(DEFAULT_KNOWLEDGE_UPLOAD_SESSION_SECONDS).toBeLessThanOrEqual(3_600);
  });

  it("accepts a bounded installation batch policy and rejects malformed values", () => {
    expect(getKnowledgeUploadConfig({ AIQSA_KNOWLEDGE_MAX_BATCH_FILES: "250" }).maxBatchFiles)
      .toBe(250);
    for (const value of ["0", "501", "1.5", "lots", "-1"]) {
      expect(getKnowledgeUploadConfig({ AIQSA_KNOWLEDGE_MAX_BATCH_FILES: value }).maxBatchFiles)
        .toBe(DEFAULT_KNOWLEDGE_UPLOAD_MAX_BATCH_FILES);
    }
  });
});
