import { describe, expect, it, vi } from "vitest";
import {
  acknowledgeAdminMemoryEgress,
  getAdminMemoryEgress
} from "./adminMemoryApi";

function payload() {
  return {
    memoryEgress: {
      acceptedAt: null,
      acceptedBy: null,
      acceptedFingerprint: null,
      acceptedPolicyVersion: null,
      consentMode: "ADMIN",
      currentFingerprint: "a".repeat(64),
      currentPolicyVersion: "memory-utility-egress-v1",
      destinations: [
        { destinations: ["Selected per run"], id: "answer_provider", reviewRequired: false, state: "BOUND_PER_RUN" },
        { destinations: ["System / Model"], id: "system_model", reviewRequired: true, state: "AVAILABLE" },
        { destinations: [], id: "embedding", reviewRequired: false, state: "UNAVAILABLE" },
        { destinations: [], id: "remote_reranker", reviewRequired: false, state: "UNAVAILABLE" }
      ],
      reviewRequired: true,
      version: 1,
      waitingJobCount: 2
    }
  };
}

describe("administrator Memory API client", () => {
  it("decodes reads and sends one exact acknowledgment", async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json(payload()));
    await expect(getAdminMemoryEgress(fetcher)).resolves.toMatchObject({ ok: true });
    await expect(acknowledgeAdminMemoryEgress({
      currentFingerprint: "a".repeat(64),
      expectedVersion: 1
    }, fetcher)).resolves.toMatchObject({ ok: true });

    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/admin/memory");
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({
        currentFingerprint: "a".repeat(64),
        expectedVersion: 1
      }),
      method: "PATCH"
    });
  });

  it("rejects malformed success responses before state mutation", async () => {
    const malformed = payload();
    malformed.memoryEgress.destinations = [];
    await expect(getAdminMemoryEgress(vi.fn().mockResolvedValue(
      Response.json(malformed)
    ))).resolves.toEqual({
      error: "memory_admin_egress_response_invalid",
      ok: false
    });
  });
});
