import { describe, expect, it } from "vitest";
import { assertBrightSnapshotCli } from "./snapshotBrightStackOverflowImport";

describe("BRIGHT retained snapshot controls", () => {
  it("requires the exact retained-target acknowledgement", () => {
    expect(() => assertBrightSnapshotCli([
      "--confirm-target",
      "RETAINED"
    ], {
      AIQSA_BRIGHT_BENCHMARK_ACK: "RETAINED_BRIGHT_KB"
    })).not.toThrow();
    expect(() => assertBrightSnapshotCli([
      "--confirm-target",
      "RETAINED"
    ], {})).toThrow("bright_stackoverflow_snapshot_confirmation_required");
  });
});
