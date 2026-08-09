import { describe, expect, it } from "vitest";
import { decodeAdminKnowledgeResponse } from "./adminKnowledge";

const response = {
  knowledge: {
    ingestionLimits: {
      maxChunksPerDocument: 10_000,
      maxFileBytes: 25_000_000,
      maxNormalizedChars: 5_000_000,
      maxPages: 2_000
    },
    policy: {
      candidateLimit: 40,
      resultLimit: 8,
      scoreThreshold: 0.01,
      updatedAt: "2026-08-09T00:00:00.000Z",
      updatedBy: { displayName: "Administrator", id: "admin-1" },
      version: 2
    },
    retrievalBounds: {
      candidateLimit: { max: 100, min: 1 },
      resultLimit: { max: 8, min: 1 },
      scoreThreshold: { max: 1, min: 0 }
    }
  }
};

describe("administrator Knowledge contract", () => {
  it("accepts bounded policy and privacy-neutral installation limits", () => {
    expect(decodeAdminKnowledgeResponse(response)).toEqual(response);
  });

  it("rejects malformed or internally inconsistent policy", () => {
    expect(decodeAdminKnowledgeResponse({
      knowledge: {
        ...response.knowledge,
        policy: { ...response.knowledge.policy, candidateLimit: 2, resultLimit: 3 }
      }
    })).toBeNull();
    expect(decodeAdminKnowledgeResponse({
      knowledge: { ...response.knowledge, privateBases: [{ name: "secret" }] }
    })).toEqual(response);
  });
});
