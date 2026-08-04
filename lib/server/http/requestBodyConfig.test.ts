import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTH_REQUEST_BODY_MAX_BYTES,
  DEFAULT_JSON_REQUEST_BODY_MAX_BYTES,
  DEFAULT_UPLOAD_MAX_CONCURRENCY,
  DEFAULT_UPLOAD_MULTIPART_OVERHEAD_BYTES,
  getRequestBodyConfig
} from "./requestBodyConfig";
import { DEFAULT_UPLOAD_MAX_BYTES } from "../uploads/validation";

describe("request body configuration", () => {
  it("uses documented defaults", () => {
    expect(getRequestBodyConfig({}, 25_000_000)).toEqual({
      authMaxBytes: DEFAULT_AUTH_REQUEST_BODY_MAX_BYTES,
      jsonMaxBytes: DEFAULT_JSON_REQUEST_BODY_MAX_BYTES,
      uploadMaxConcurrency: DEFAULT_UPLOAD_MAX_CONCURRENCY,
      uploadMultipartMaxBytes: 25_000_000 + DEFAULT_UPLOAD_MULTIPART_OVERHEAD_BYTES,
      uploadMultipartOverheadBytes: DEFAULT_UPLOAD_MULTIPART_OVERHEAD_BYTES
    });
  });

  it("accepts safe positive integers and falls back for unsafe values", () => {
    expect(
      getRequestBodyConfig(
        {
          AIQSA_AUTH_REQUEST_BODY_MAX_BYTES: "32768",
          AIQSA_JSON_REQUEST_BODY_MAX_BYTES: "2097152",
          AIQSA_UPLOAD_MAX_CONCURRENCY: "8",
          AIQSA_UPLOAD_MULTIPART_OVERHEAD_BYTES: "2097152"
        },
        10_000_000
      )
    ).toMatchObject({
      authMaxBytes: 32_768,
      jsonMaxBytes: 2_097_152,
      uploadMaxConcurrency: 8,
      uploadMultipartMaxBytes: 12_097_152,
      uploadMultipartOverheadBytes: 2_097_152
    });

    expect(
      getRequestBodyConfig({
        AIQSA_AUTH_REQUEST_BODY_MAX_BYTES: "0",
        AIQSA_JSON_REQUEST_BODY_MAX_BYTES: "1.5",
        AIQSA_UPLOAD_MAX_CONCURRENCY: "1000",
        AIQSA_UPLOAD_MULTIPART_OVERHEAD_BYTES: "invalid"
      })
    ).toMatchObject({
      authMaxBytes: DEFAULT_AUTH_REQUEST_BODY_MAX_BYTES,
      jsonMaxBytes: DEFAULT_JSON_REQUEST_BODY_MAX_BYTES,
      uploadMaxConcurrency: DEFAULT_UPLOAD_MAX_CONCURRENCY,
      uploadMultipartOverheadBytes: DEFAULT_UPLOAD_MULTIPART_OVERHEAD_BYTES
    });

    expect(getRequestBodyConfig({}, 2_000_000_000)).toMatchObject({
      uploadMultipartMaxBytes:
        DEFAULT_UPLOAD_MAX_BYTES + DEFAULT_UPLOAD_MULTIPART_OVERHEAD_BYTES
    });
  });
});
