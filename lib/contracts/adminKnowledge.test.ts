import { describe, expect, it } from "vitest";
import {
  adminKnowledgeOperationsFixture,
  adminKnowledgeProfileFixture
} from "@/tests/support/knowledgeProfile";
import { decodeAdminKnowledgeResponse } from "./adminKnowledge";

const response = {
  knowledge: {
    ingestionLimits: {
      maxChunksPerDocument: 10_000,
      maxFileBytes: 25_000_000,
      maxNormalizedChars: 5_000_000,
      maxPages: 2_000
    },
    operations: adminKnowledgeOperationsFixture(),
    policy: {
      candidateLimit: 40,
      resultLimit: 8,
      scoreThreshold: 0.01,
      updatedAt: "2026-08-09T00:00:00.000Z",
      updatedBy: { displayName: "Administrator", id: "admin-1" },
      version: 2
    },
    profile: adminKnowledgeProfileFixture(),
    retrievalBounds: {
      candidateLimit: { max: 100, min: 1 },
      resultLimit: { max: 8, min: 1 },
      scoreThreshold: { max: 1, min: 0 }
    }
  }
};

describe("administrator Knowledge contract", () => {
  it("accepts bounded policy and a content-free installation profile", () => {
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
        profile: {
          ...response.knowledge.profile,
          egress: {
            ...response.knowledge.profile.egress,
            roles: response.knowledge.profile.egress.roles.map((role) =>
              role.operation === "query_planning" ? { ...role, mode: "external" } : role)
          }
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
