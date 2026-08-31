import { describe, expect, it } from "vitest";
import {
  selectedQualificationEmbeddingDeployment,
  type QualificationEmbeddingCandidate
} from "./probeEmbeddingContract";

function candidate(
  id: string,
  overrides: Partial<QualificationEmbeddingCandidate> = {}
): QualificationEmbeddingCandidate {
  return {
    activeConfig: { embedding: { targetDimension: 1_536 } },
    activeVersion: 1,
    connection: { enabled: true, family: "openrouter" },
    enabled: true,
    id,
    modelClass: "embedding",
    modelId: "qwen/qwen3-embedding-8b",
    ...overrides
  };
}

describe("LongMemEval embedding probe authority", () => {
  it("uses the governed deployment when catalog rows share an upstream model", () => {
    const legacy = candidate("legacy-deployment");
    const governed = candidate("governed-deployment");

    expect(selectedQualificationEmbeddingDeployment(
      [legacy, governed],
      governed.id
    )).toBe(governed);
  });

  it("fails closed when the governed deployment is absent or unavailable", () => {
    expect(() => selectedQualificationEmbeddingDeployment(
      [candidate("another-deployment")],
      "missing-deployment"
    )).toThrowError("embedding_batch_probe_model_invalid");
    expect(() => selectedQualificationEmbeddingDeployment(
      [candidate("governed-deployment", { enabled: false })],
      "governed-deployment"
    )).toThrowError("embedding_batch_probe_model_invalid");
  });
});
