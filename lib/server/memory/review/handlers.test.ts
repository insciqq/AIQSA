import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession } from "../../auth/requestAuth";
import { createRecordMemoryFeedbackHandler, type MemoryReviewHandlerDeps } from "./handlers";

const body = {
  expectedVersionId: "version-1",
  feedbackType: "INCORRECT",
  requestId: "feedback-request-1"
};

function session(): AuthenticatedSession {
  return {
    expiresAt: new Date("2026-08-11T09:00:00.000Z"),
    id: "session-1",
    user: {
      displayName: "Owner",
      email: "owner@example.test",
      id: "user-1",
      role: "user",
      status: "active"
    },
    userId: "user-1"
  };
}

function deps(overrides: Partial<MemoryReviewHandlerDeps> = {}): MemoryReviewHandlerDeps {
  return {
    mutationRateLimiter: {
      check: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 }))
    },
    resolveAuth: vi.fn(async () => session()),
    service: {
      feedback: vi.fn(async () => ({
        createdAt: "2026-08-11T08:00:00.000Z",
        feedbackId: "feedback-1",
        feedbackType: "INCORRECT" as const,
        retractedFeedbackId: null,
        targetVersionId: "version-1"
      }))
    },
    ...overrides
  };
}

function request(path = "http://localhost/api/me/memories/fact-1/feedback") {
  return new Request(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
}

function context(memoryId = "fact-1") {
  return { params: Promise.resolve({ memoryId }) };
}

function expectPrivate(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  expect(response.headers.get("vary")).toBe("Cookie");
}

describe("Memory review handler", () => {
  it("authenticates, rate-limits, validates, and returns private committed feedback", async () => {
    const dependencies = deps();
    const response = await createRecordMemoryFeedbackHandler(dependencies)(
      request(),
      context()
    );
    expect(response.status).toBe(201);
    expectPrivate(response);
    expect(dependencies.mutationRateLimiter.check).toHaveBeenCalledWith(
      "memory-feedback:user:user-1"
    );
    expect(dependencies.service.feedback).toHaveBeenCalledWith(
      "user-1",
      "fact-1",
      body
    );
  });

  it("does not spend the limiter before authentication and emits private 401", async () => {
    const dependencies = deps({ resolveAuth: vi.fn(async () => null) });
    const response = await createRecordMemoryFeedbackHandler(dependencies)(request(), context());
    expect(response.status).toBe(401);
    expectPrivate(response);
    expect(dependencies.mutationRateLimiter.check).not.toHaveBeenCalled();
  });

  it("fails closed on query smuggling and rate-limit exhaustion", async () => {
    const smuggled = await createRecordMemoryFeedbackHandler(deps())(
      request("http://localhost/api/me/memories/fact-1/feedback?userId=other"),
      context()
    );
    expect(smuggled.status).toBe(400);
    expectPrivate(smuggled);

    const limitedDeps = deps({
      mutationRateLimiter: {
        check: vi.fn(async () => ({ allowed: false, retryAfterSeconds: 17 }))
      }
    });
    const limited = await createRecordMemoryFeedbackHandler(limitedDeps)(request(), context());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("17");
    expectPrivate(limited);
    expect(limitedDeps.service.feedback).not.toHaveBeenCalled();
  });
});
