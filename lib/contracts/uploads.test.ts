import { describe, expect, it } from "vitest";
import { decodeUploadErrorResponse } from "./uploads";

describe("upload wire decoders", () => {
  it("accepts only known safe upload failures", () => {
    expect(decodeUploadErrorResponse({ error: "file_too_large", limit: 26_048_576 })).toEqual({
      error: "file_too_large",
      limit: 26_048_576
    });
    expect(decodeUploadErrorResponse({ error: "upload_busy" })).toEqual({ error: "upload_busy" });
    expect(decodeUploadErrorResponse({ error: "storage_failed", message: "private" })).toBeNull();
    expect(decodeUploadErrorResponse({ error: "file_too_large", limit: -1 })).toBeNull();
  });
});
