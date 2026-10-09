// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestAuth } from "@/tests/support/auth";
import {
  ANSWER_PROBLEM_REPORT_RATE_LIMIT,
  answerProblemReportRateLimitKey,
  createAnswerProblemReportHandlers
} from "./handlers";
import type { AnswerProblemReportRepository, AnswerProblemReportTarget } from "./repository";

const PRIVATE_COMMENT = "PRIVATE-COMMENT-7f3a it invented a court case";
const auth = createTestAuth({ user: { id: "user-1" } });
const inactive = createTestAuth({ token: "inactive-token", user: { id: "user-2", status: "disabled" } });
const resolveAuth = async (request: Request) => await auth.resolveAuth(request) ?? inactive.resolveAuth(request);
const target: AnswerProblemReportTarget = { chatId: "chat-1", messageId: "answer-1", runId: "run-1" };
const updatedAt = new Date("2026-10-09T12:00:00.000Z");
const params = { chatId: "chat-1", messageId: "answer-1" };
const path = "/api/chats/chat-1/messages/answer-1/problem-report";

const repository = {
  readOwn: vi.fn<AnswerProblemReportRepository["readOwn"]>(),
  resolveAnswer: vi.fn<AnswerProblemReportRepository["resolveAnswer"]>(),
  save: vi.fn<AnswerProblemReportRepository["save"]>()
};
const rateLimiter = { check: vi.fn() };
const handlers = createAnswerProblemReportHandlers({
  now: () => updatedAt, rateLimiter, repository: () => repository, resolveAuth
});

function request(method: "GET" | "PUT", body?: unknown, cookie: string | null = auth.cookie): Request {
  return new Request(`http://app.local${path}`, {
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    headers: { "content-type": "application/json", ...(cookie ? { cookie: cookie.split(";")[0]! } : {}) },
    method
  });
}

const written: string[] = [];
const lines = () => [...written];

beforeEach(() => {
  for (const mock of [repository.readOwn, repository.resolveAnswer, repository.save, rateLimiter.check]) mock.mockReset();
  repository.resolveAnswer.mockResolvedValue(target);
  rateLimiter.check.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  written.length = 0;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("answer problem report route", () => {
  it("creates the user's report and records a content-free event without the comment", async () => {
    repository.save.mockResolvedValue({ outcome: "created", report: { comment: PRIVATE_COMMENT, reason: "wrong_or_made_up", updatedAt } });
    const response = await handlers.PUT(request("PUT", { comment: `  ${PRIVATE_COMMENT}\r\n`, reason: "wrong_or_made_up" }), { params });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ outcome: "created",
      report: { comment: PRIVATE_COMMENT, reason: "wrong_or_made_up", updatedAt: updatedAt.toISOString() } });
    expect(repository.resolveAnswer).toHaveBeenCalledWith({ chatId: "chat-1", messageId: "answer-1", now: updatedAt, userId: "user-1" });
    expect(repository.save).toHaveBeenCalledWith({ comment: PRIVATE_COMMENT, reason: "wrong_or_made_up", target, userId: "user-1" });
    expect(rateLimiter.check).toHaveBeenCalledWith(answerProblemReportRateLimitKey("user-1"),
      { maxAttempts: ANSWER_PROBLEM_REPORT_RATE_LIMIT });
    const events = lines().map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.event === "answer_problem_report");
    expect(events).toEqual([expect.objectContaining({ level: "info", outcome: "created", reason: "wrong_or_made_up" })]);
    expect(lines().join("\n")).not.toContain("PRIVATE-COMMENT");
    expect(lines().join("\n")).not.toContain("answer-1");
  });

  it("updates an existing report and stores an empty comment as none", async () => {
    repository.save.mockResolvedValue({ outcome: "updated", report: { comment: null, reason: "too_slow", updatedAt } });
    const response = await handlers.PUT(request("PUT", { comment: " \n\t ", reason: "too_slow" }), { params });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "updated", report: { comment: null, reason: "too_slow" } });
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ comment: null, reason: "too_slow" }));
    expect(lines().some((line) => line.includes("\"outcome\":\"updated\""))).toBe(true);
  });

  it("reads the user's own report to prefill Update, or none", async () => {
    repository.readOwn.mockResolvedValueOnce({ comment: "Kept", reason: "other", updatedAt }).mockResolvedValueOnce(null);
    const first = await handlers.GET(request("GET"), { params });
    expect(await first.json()).toEqual({ report: { comment: "Kept", reason: "other", updatedAt: updatedAt.toISOString() } });
    expect(repository.readOwn).toHaveBeenCalledWith(target, "user-1");
    expect(await (await handlers.GET(request("GET"), { params })).json()).toEqual({ report: null });
    expect(rateLimiter.check).not.toHaveBeenCalled();
  });

  it("answers an invisible, unknown or unsettled answer with one privacy-neutral 404", async () => {
    repository.resolveAnswer.mockResolvedValue(null);
    const read = await handlers.GET(request("GET"), { params });
    const write = await handlers.PUT(request("PUT", { comment: null, reason: "other" }), { params });
    const malformed = await handlers.GET(request("GET"), { params: { chatId: "chat 1", messageId: "answer-1" } });
    for (const response of [read, write, malformed]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "answer_problem_report_unavailable" });
    }
    expect(repository.readOwn).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();

    // The answer vanished between the check and the write.
    repository.resolveAnswer.mockResolvedValue(target);
    repository.save.mockResolvedValue(null);
    const vanished = await handlers.PUT(request("PUT", { comment: null, reason: "other" }), { params });
    expect(vanished.status).toBe(404);
    expect(lines().some((line) => line.includes("answer_problem_report\""))).toBe(false);
  });

  it("requires an active signed-in user", async () => {
    expect((await handlers.GET(request("GET", undefined, null), { params })).status).toBe(401);
    const disabled = await handlers.PUT(request("PUT", { comment: null, reason: "other" }, inactive.cookie), { params });
    expect(disabled.status).toBe(403);
    expect(repository.resolveAnswer).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown reason", { comment: null, reason: "rude" }],
    ["a missing reason", { comment: "Hello" }],
    ["an unknown field", { comment: null, question: "copy me", reason: "other" }],
    ["a comment over 1,000 characters", { comment: "x".repeat(1_001), reason: "other" }],
    ["a non-text comment", { comment: 42, reason: "other" }],
    ["a non-object body", "[]"],
    ["malformed JSON", "{"]
  ])("refuses %s before touching the answer", async (_label, body) => {
    const response = await handlers.PUT(request("PUT", body), { params });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "answer_problem_report_invalid" });
    expect(rateLimiter.check).not.toHaveBeenCalled();
    expect(repository.resolveAnswer).not.toHaveBeenCalled();
  });

  it("limits creates and updates per user with a stable code and Retry-After", async () => {
    rateLimiter.check.mockResolvedValue({ allowed: false, retryAfterSeconds: 3_600.2 });
    const response = await handlers.PUT(request("PUT", { comment: PRIVATE_COMMENT, reason: "other" }), { params });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3601");
    expect(await response.json()).toEqual({ error: "answer_problem_report_rate_limited" });
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("fails visibly on a database failure without logging the comment or the error text", async () => {
    repository.save.mockRejectedValue(new Error(`insert failed for ${PRIVATE_COMMENT}`));
    const response = await handlers.PUT(request("PUT", { comment: PRIVATE_COMMENT, reason: "error_or_broken" }), { params });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "answer_problem_report_failed" });
    const output = lines().join("\n");
    expect(output).toContain("answer_problem_report_failed");
    expect(output).not.toContain("PRIVATE-COMMENT");
  });
});
