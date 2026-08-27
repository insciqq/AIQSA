import { describe, expect, it } from "vitest";
import {
  adminKnowledgeAnswerPolicyFixture,
  adminKnowledgeOperationsFixture,
  adminKnowledgeProfileFixture
} from "@/tests/support/knowledgeProfile";
import { decodeAdminKnowledgeResponse } from "./adminKnowledge";

const response = {
  knowledge: {
    answerPolicy: adminKnowledgeAnswerPolicyFixture(),
    ingestionLimits: {
      maxChunksPerDocument: 10_000,
      maxFileBytes: 25_000_000,
      maxNormalizedChars: 5_000_000,
      maxPages: 2_000
    },
    operations: adminKnowledgeOperationsFixture(),
    profile: adminKnowledgeProfileFixture(),
    retrieval: {
      candidateLimit: 40,
      resultLimit: 16
    }
  }
};

describe("administrator Knowledge contract", () => {
  it("accepts fixed retrieval facts and a content-free installation profile", () => {
    expect(decodeAdminKnowledgeResponse(response)).toEqual(response);
  });

  it("rejects a missing, out-of-range, or drifted ingestion parallelism", () => {
    const answerPolicy = response.knowledge.answerPolicy;
    const withPolicy = (overrides: Record<string, unknown>) => ({
      knowledge: { ...response.knowledge, answerPolicy: { ...answerPolicy, ...overrides } }
    });
    expect(decodeAdminKnowledgeResponse(withPolicy({ ingestionParallelism: undefined }))).toBeNull();
    expect(decodeAdminKnowledgeResponse(withPolicy({ ingestionParallelism: 0 }))).toBeNull();
    expect(decodeAdminKnowledgeResponse(withPolicy({ ingestionParallelism: 17 }))).toBeNull();
    expect(decodeAdminKnowledgeResponse(withPolicy({ ingestionParallelism: 2.5 }))).toBeNull();
    expect(decodeAdminKnowledgeResponse(withPolicy({ parallelismMaximum: 32 }))).toBeNull();
    expect(decodeAdminKnowledgeResponse(withPolicy({ parallelismMinimum: 0 }))).toBeNull();
    expect(decodeAdminKnowledgeResponse(withPolicy({ ingestionParallelism: 16 })))
      .toEqual(withPolicy({ ingestionParallelism: 16 }));
  });

  it("rejects retrieval drift and malformed profile or operations state", () => {
    expect(decodeAdminKnowledgeResponse({
      knowledge: {
        ...response.knowledge,
        retrieval: { ...response.knowledge.retrieval, candidateLimit: 39 }
      }
    })).toBeNull();
    expect(decodeAdminKnowledgeResponse({
      knowledge: {
        ...response.knowledge,
        retrieval: { ...response.knowledge.retrieval, scoreThreshold: 0 }
      }
    })).toBeNull();
    expect(decodeAdminKnowledgeResponse({
      knowledge: { ...response.knowledge, privateBases: [{ name: "secret" }] }
    })).toEqual(response);
    expect(decodeAdminKnowledgeResponse({
      knowledge: {
        ...response.knowledge,
        profile: {
          ...response.knowledge.profile,
          health: { checkedAt: null, code: null, state: "ready" }
        }
      }
    })).toBeNull();
    expect(decodeAdminKnowledgeResponse({
      knowledge: {
        ...response.knowledge,
        operations: {
          ...response.knowledge.operations,
          alerts: [{ code: "private_filename", severity: "critical" }]
        }
      }
    })).toBeNull();
    expect(decodeAdminKnowledgeResponse({
      knowledge: {
        ...response.knowledge,
        operations: {
          ...response.knowledge.operations,
          retrieval: {
            ...response.knowledge.operations.retrieval,
            degradedOperations24h: 2,
            operations24h: 1
          }
        }
      }
    })).toBeNull();
  });
});
