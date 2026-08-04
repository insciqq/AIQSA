import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_ATTACHMENT_MAX_COUNT,
  DEFAULT_RUN_ATTACHMENT_MAX_ENCODED_BYTES,
  DEFAULT_RUN_ATTACHMENT_MAX_MATERIALIZED_BYTES,
  DEFAULT_RUN_ATTACHMENT_READ_CONCURRENCY,
  getRunAttachmentLimits,
  RUN_ATTACHMENT_MAX_COUNT_CEILING,
  RUN_ATTACHMENT_MAX_ENCODED_BYTES_CEILING,
  RUN_ATTACHMENT_MAX_MATERIALIZED_BYTES_CEILING,
  RUN_ATTACHMENT_READ_CONCURRENCY_CEILING,
  toCatalogAttachmentLimits
} from "./attachmentLimits";

describe("run attachment limit configuration", () => {
  it("uses the documented defaults", () => {
    expect(getRunAttachmentLimits({})).toEqual({
      maxCount: DEFAULT_RUN_ATTACHMENT_MAX_COUNT,
      maxEncodedBytes: DEFAULT_RUN_ATTACHMENT_MAX_ENCODED_BYTES,
      maxMaterializedBytes: DEFAULT_RUN_ATTACHMENT_MAX_MATERIALIZED_BYTES,
      readConcurrency: DEFAULT_RUN_ATTACHMENT_READ_CONCURRENCY
    });
  });

  it("accepts positive whole values through each hard ceiling", () => {
    expect(
      getRunAttachmentLimits({
        AIQSA_RUN_ATTACHMENT_MAX_COUNT: String(RUN_ATTACHMENT_MAX_COUNT_CEILING),
        AIQSA_RUN_ATTACHMENT_MAX_ENCODED_BYTES: String(
          RUN_ATTACHMENT_MAX_ENCODED_BYTES_CEILING
        ),
        AIQSA_RUN_ATTACHMENT_MAX_MATERIALIZED_BYTES: String(
          RUN_ATTACHMENT_MAX_MATERIALIZED_BYTES_CEILING
        ),
        AIQSA_RUN_ATTACHMENT_READ_CONCURRENCY: String(
          RUN_ATTACHMENT_READ_CONCURRENCY_CEILING
        )
      })
    ).toEqual({
      maxCount: RUN_ATTACHMENT_MAX_COUNT_CEILING,
      maxEncodedBytes: RUN_ATTACHMENT_MAX_ENCODED_BYTES_CEILING,
      maxMaterializedBytes: RUN_ATTACHMENT_MAX_MATERIALIZED_BYTES_CEILING,
      readConcurrency: RUN_ATTACHMENT_READ_CONCURRENCY_CEILING
    });
  });

  it.each(["", "0", "-1", "1.5", " 2", "2 ", "1e2", "NaN", "Infinity"])(
    "falls back for invalid value %j",
    (value) => {
      expect(
        getRunAttachmentLimits({
          AIQSA_RUN_ATTACHMENT_MAX_COUNT: value,
          AIQSA_RUN_ATTACHMENT_MAX_ENCODED_BYTES: value,
          AIQSA_RUN_ATTACHMENT_MAX_MATERIALIZED_BYTES: value,
          AIQSA_RUN_ATTACHMENT_READ_CONCURRENCY: value
        })
      ).toEqual({
        maxCount: DEFAULT_RUN_ATTACHMENT_MAX_COUNT,
        maxEncodedBytes: DEFAULT_RUN_ATTACHMENT_MAX_ENCODED_BYTES,
        maxMaterializedBytes: DEFAULT_RUN_ATTACHMENT_MAX_MATERIALIZED_BYTES,
        readConcurrency: DEFAULT_RUN_ATTACHMENT_READ_CONCURRENCY
      });
    }
  );

  it("falls back independently when a value exceeds its hard ceiling", () => {
    expect(
      getRunAttachmentLimits({
        AIQSA_RUN_ATTACHMENT_MAX_COUNT: String(RUN_ATTACHMENT_MAX_COUNT_CEILING + 1),
        AIQSA_RUN_ATTACHMENT_MAX_ENCODED_BYTES: String(
          RUN_ATTACHMENT_MAX_ENCODED_BYTES_CEILING + 1
        ),
        AIQSA_RUN_ATTACHMENT_MAX_MATERIALIZED_BYTES: String(
          RUN_ATTACHMENT_MAX_MATERIALIZED_BYTES_CEILING + 1
        ),
        AIQSA_RUN_ATTACHMENT_READ_CONCURRENCY: String(
          RUN_ATTACHMENT_READ_CONCURRENCY_CEILING + 1
        )
      })
    ).toEqual({
      maxCount: DEFAULT_RUN_ATTACHMENT_MAX_COUNT,
      maxEncodedBytes: DEFAULT_RUN_ATTACHMENT_MAX_ENCODED_BYTES,
      maxMaterializedBytes: DEFAULT_RUN_ATTACHMENT_MAX_MATERIALIZED_BYTES,
      readConcurrency: DEFAULT_RUN_ATTACHMENT_READ_CONCURRENCY
    });
  });

  it("keeps read concurrency out of the client projection", () => {
    expect(
      toCatalogAttachmentLimits({
        maxCount: 7,
        maxEncodedBytes: 11,
        maxMaterializedBytes: 9,
        readConcurrency: 3
      })
    ).toEqual({
      maxCount: 7,
      maxEncodedBytes: 11,
      maxMaterializedBytes: 9
    });
  });
});
