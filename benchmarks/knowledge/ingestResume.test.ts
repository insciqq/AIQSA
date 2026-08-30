import { describe, expect, it } from "vitest";
import { knowledgeBenchmarkUploadRecoveryDisposition } from "./ingestResume";

describe("public Knowledge benchmark upload recovery", () => {
  it("retries an expired or failed admission before a Source exists", () => {
    expect(knowledgeBenchmarkUploadRecoveryDisposition({ sourceId: null }))
      .toBe("retry");
  });

  it("waits for a migrated Source and accepts only current ready evidence", () => {
    expect(knowledgeBenchmarkUploadRecoveryDisposition({
      sourceId: "source-1"
    })).toBe("wait");
    expect(knowledgeBenchmarkUploadRecoveryDisposition({
      sourceId: "source-1",
      sourceState: "processing"
    })).toBe("wait");
    expect(knowledgeBenchmarkUploadRecoveryDisposition({
      sourceId: "source-1",
      sourceState: "ready"
    })).toBe("recover");
  });

  it("fails closed when the current Source still needs attention", () => {
    expect(knowledgeBenchmarkUploadRecoveryDisposition({
      sourceId: "source-1",
      sourceState: "needs_attention"
    })).toBe("fail");
  });
});
