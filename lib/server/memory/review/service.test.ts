import { describe, expect, it, vi } from "vitest";
import { MemoryPersistenceError } from "../persistence/errors";
import { createMemoryReviewService, MemoryReviewServiceError } from "./service";

const input = {
  comment: "Wrong inference",
  expectedVersionId: "version-1",
  feedbackType: "INCORRECT" as const,
  requestId: "feedback-request-1"
};

describe("Memory review service", () => {
  it("returns a bounded append-only feedback receipt and forwards internal authority", async () => {
    const record = vi.fn(async () => ({
      createdAt: "2026-08-11T08:00:00.000Z",
      feedbackId: "feedback-1",
      feedbackType: "INCORRECT" as const,
      retractedFeedbackId: null,
      targetVersionId: "version-1"
    }));
    const service = createMemoryReviewService({ record });
    const authorization = {
      action: "EDIT" as const,
      authorizationId: "authorization-1",
      authorizedPayloadHash: "a".repeat(64),
      expectedTargetVersionId: "version-1",
      requestId: "authorization-request-1",
      targetFactId: "fact-1"
    };

    await expect(service.feedback("user-1", "fact-1", input, { authorization }))
      .resolves.toMatchObject({ feedbackId: "feedback-1" });
    expect(record).toHaveBeenCalledWith("user-1", "fact-1", input, authorization);
  });

  it("maps stale, idempotency, and authorization failures without leaking persistence details", async () => {
    for (const [persistenceCode, publicCode] of [
      ["memory_fact_version_stale", "memory_version_stale"],
      ["memory_idempotency_conflict", "memory_intent_confirmation_required"],
      ["memory_mutation_authorization_invalid", "memory_intent_confirmation_required"]
    ] as const) {
      const service = createMemoryReviewService({
        record: vi.fn(async () => {
          throw new MemoryPersistenceError(persistenceCode);
        })
      });
      await expect(service.feedback("user-1", "fact-1", input)).rejects.toEqual(
        expect.objectContaining<Partial<MemoryReviewServiceError>>({ code: publicCode })
      );
    }
  });

  it("fails closed when a repository returns a non-contract response", async () => {
    const service = createMemoryReviewService({
      record: vi.fn(async () => ({ feedbackId: "private-only" } as never))
    });
    await expect(service.feedback("user-1", "fact-1", input)).rejects.toEqual(
      expect.objectContaining<Partial<MemoryReviewServiceError>>({
        code: "memory_action_failed"
      })
    );
  });
});
