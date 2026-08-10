import { describe, expect, it } from "vitest";
import {
  decodeAdminMemoryEgressAcknowledgeInput,
  decodeAdminMemoryEgressResponse
} from "./adminMemory";

function response() {
  return {
    memoryEgress: {
      acceptedAt: "2026-08-11T10:00:00.000Z",
      acceptedBy: { displayName: "Administrator", id: "admin-1" },
      acceptedFingerprint: "a".repeat(64),
      acceptedPolicyVersion: "memory-utility-egress-v1",
      consentMode: "ADMIN",
      currentFingerprint: "a".repeat(64),
      currentPolicyVersion: "memory-utility-egress-v1",
      destinations: [
        { destinations: ["Selected per run"], id: "answer_provider", reviewRequired: false, state: "BOUND_PER_RUN" },
        { destinations: ["System / Model"], id: "system_model", reviewRequired: false, state: "AVAILABLE" },
        { destinations: [], id: "embedding", reviewRequired: false, state: "UNAVAILABLE" },
        { destinations: [], id: "remote_reranker", reviewRequired: false, state: "UNAVAILABLE" }
      ],
      reviewRequired: false,
      version: 2,
      waitingJobCount: 0
    }
  };
}

describe("administrator Memory contracts", () => {
  it("decodes the exact bounded four-row projection", () => {
    expect(decodeAdminMemoryEgressResponse(response())).toEqual(response());
  });

  it("rejects extra data, malformed fingerprints, and coercible versions", () => {
    expect(decodeAdminMemoryEgressResponse({
      ...response(),
      privateMemoryText: "must not cross the boundary"
    })).toBeNull();
    expect(decodeAdminMemoryEgressResponse({
      memoryEgress: {
        ...response().memoryEgress,
        currentFingerprint: "not-a-hash"
      }
    })).toBeNull();
    expect(decodeAdminMemoryEgressResponse({
      memoryEgress: {
        ...response().memoryEgress,
        destinations: response().memoryEgress.destinations.map((row, index) =>
          index === 3 ? { ...row, id: "embedding" } : row)
      }
    })).toBeNull();
    expect(decodeAdminMemoryEgressAcknowledgeInput({
      currentFingerprint: "a".repeat(64),
      expectedVersion: "2"
    })).toBeNull();
    expect(decodeAdminMemoryEgressAcknowledgeInput({
      currentFingerprint: "a".repeat(64),
      expectedVersion: 2
    })).toEqual({
      currentFingerprint: "a".repeat(64),
      expectedVersion: 2
    });
  });
});
