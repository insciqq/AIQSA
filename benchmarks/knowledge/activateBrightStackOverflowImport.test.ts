import { describe, expect, it } from "vitest";
import { KNOWLEDGE_BULK_ACTIVATION_MAX_SOURCES } from
  "../../lib/server/knowledge/bulkActivation";
import { parseBrightActivationCli } from "./activateBrightStackOverflowImport";

const environment = Object.freeze({
  AIQSA_BRIGHT_BENCHMARK_ACK: "RETAINED_BRIGHT_KB"
});

describe("BRIGHT retained activation controls", () => {
  it("requires the retained target and exposes explicit resume", () => {
    expect(parseBrightActivationCli([
      "--confirm-target",
      "RETAINED",
      "--batch-size",
      "500",
      "--resume"
    ], environment)).toEqual({ batchSize: 500, inspectOnly: false, resume: true });
    expect(parseBrightActivationCli([
      "--confirm-target",
      "RETAINED",
      "--inspect-only"
    ], environment)).toEqual({
      batchSize: KNOWLEDGE_BULK_ACTIVATION_MAX_SOURCES,
      inspectOnly: true,
      resume: false
    });
  });

  it("rejects missing acknowledgement and out-of-bound batches", () => {
    expect(() => parseBrightActivationCli([
      "--confirm-target",
      "RETAINED"
    ], {})).toThrow("bright_stackoverflow_activation_confirmation_required");
    expect(() => parseBrightActivationCli([
      "--confirm-target",
      "RETAINED",
      "--batch-size",
      String(KNOWLEDGE_BULK_ACTIVATION_MAX_SOURCES + 1)
    ], environment)).toThrow("bright_stackoverflow_activation_batch_size_invalid");
  });
});
