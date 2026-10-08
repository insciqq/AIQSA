import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestAuth } from "@/tests/support/auth";
import { createAnswerReviewRoundHandler } from "./roundHandler";
import { createAnswerReviewStepHandler } from "./stepHandler";
import type { AnswerReviewServiceDeps } from "./service";
import type { AnswerReviewStepStartDeps } from "./stepStart";

const startRound = vi.hoisted(() => vi.fn());
const startStep = vi.hoisted(() => vi.fn());
vi.mock("./service", async (importOriginal) => ({ ...await importOriginal<typeof import("./service")>(), startAnswerReviewRound: startRound }));
vi.mock("./stepStart", async (importOriginal) => ({ ...await importOriginal<typeof import("./stepStart")>(), startAnswerReviewStep: startStep }));

const auth = createTestAuth({ user: { id: "user-1" } });
const inactive = createTestAuth({ token: "inactive-token", user: { id: "user-2", status: "disabled" } });
const service = {} as AnswerReviewServiceDeps;
const steps = {} as AnswerReviewStepStartDeps;
const resolveAuth = async (request: Request) => await auth.resolveAuth(request) ?? inactive.resolveAuth(request);
const handlers = {
  POST_ROUND: createAnswerReviewRoundHandler({ resolveAuth, service: () => service }),
  POST_STEP: createAnswerReviewStepHandler({ resolveAuth, steps: () => steps })
};
const author = { modelId: "model-a", name: "Claude", provider: "connection-a" };
const session = { authorModel: author, chatId: "chat-1", id: "session-1", maxRounds: null, mode: "manual" as const,
  reviewers: [{ modelId: "model-b", name: "GPT-5", provider: "connection-b" }], round: 1, sourceAssistantMessageId: "answer-1",
  state: "running" as const, stopReason: null, userId: "user-1" };

function post(path: string, body: unknown, cookie: string | null = auth.cookie): Request {
  return new Request(`http://app.local${path}`, { body: JSON.stringify(body), headers: {
    "content-type": "application/json", ...(cookie ? { cookie: cookie.split(";")[0]! } : {}) }, method: "POST" });
}
const roundBody = { answerMessageId: "answer-1", expectedActiveLeafId: "answer-1", reviewers: [{ modelId: "model-b", provider: "connection-b" }] };
const stepBody = { admissionId: "admission-1", controls: { timeZone: "Europe/Berlin" }, expectedActiveLeafId: "answer-1", kind: "review" };

beforeEach(() => {
  startRound.mockReset();
  startStep.mockReset();
});

describe("answer review routes", () => {
  it("starts a round for the signed-in user and returns the session with the initiator's actions", async () => {
    startRound.mockResolvedValue({ ok: true, session });
    const response = await handlers.POST_ROUND(post("/api/chats/chat-1/answer-reviews", roundBody), { params: { chatId: "chat-1" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ session: { author, canAct: true, id: "session-1", maxRounds: null, mode: "manual",
      reviewers: session.reviewers, round: 1, sourceAssistantMessageId: "answer-1", state: "running", stopReason: null } });
    expect(startRound).toHaveBeenCalledWith(service, { ...roundBody, chatId: "chat-1", userId: "user-1" });
  });

  it("passes a round refusal through with its status", async () => {
    startRound.mockResolvedValue({ code: "answer_review_not_latest", ok: false, status: 409 });
    const response = await handlers.POST_ROUND(post("/api/chats/chat-1/answer-reviews", roundBody), { params: { chatId: "chat-1" } });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "answer_review_not_latest" });
  });

  it("refuses a malformed round before any read", async () => {
    for (const body of [
      { ...roundBody, reviewers: [] },
      { ...roundBody, reviewers: [roundBody.reviewers[0], roundBody.reviewers[0]] },
      { ...roundBody, reviewers: [{ modelId: "a", provider: "b" }, { modelId: "c", provider: "d" }, { modelId: "e", provider: "f" }] },
      { ...roundBody, reviewers: [{ modelId: "a", name: "Spoofed", provider: "b" }] },
      { ...roundBody, extra: true },
      { ...roundBody, answerMessageId: "a/b" }
    ]) {
      const response = await handlers.POST_ROUND(post("/api/chats/chat-1/answer-reviews", body), { params: { chatId: "chat-1" } });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(startRound).not.toHaveBeenCalled();
  });

  it("starts a step as the signed-in user and returns its run stream", async () => {
    startStep.mockResolvedValue({ assistantMessageId: "a", ok: true, response: new Response("data: {}\n\n", { status: 200 }), runId: "r",
      userMessageId: "u" });
    const request = post("/api/answer-reviews/session-1/steps", stepBody);
    const response = await handlers.POST_STEP(request, { params: { sessionId: "session-1" } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: {}\n\n");
    const [deps, input] = startStep.mock.calls[0]!;
    expect(deps).toBe(steps);
    expect(input).toMatchObject({ ...stepBody, sessionId: "session-1", userId: "user-1" });
    // The step's send resolves the browser session again.
    await expect(input.resolveAuth()).resolves.toMatchObject({ userId: "user-1" });
  });

  it("refuses a step without an active session or with a malformed body", async () => {
    const anonymous = await handlers.POST_STEP(post("/api/answer-reviews/session-1/steps", stepBody, null), { params: { sessionId: "session-1" } });
    expect(anonymous.status).toBe(401);
    const disabled = await handlers.POST_STEP(post("/api/answer-reviews/session-1/steps", stepBody, inactive.cookie),
      { params: { sessionId: "session-1" } });
    expect(disabled.status).toBe(403);
    for (const body of [{ ...stepBody, kind: "auto" }, { ...stepBody, controls: [] }, { ...stepBody, modelId: "m" },
      { ...stepBody, admissionId: "" }]) {
      const response = await handlers.POST_STEP(post("/api/answer-reviews/session-1/steps", body), { params: { sessionId: "session-1" } });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    const badId = await handlers.POST_STEP(post("/api/answer-reviews/a.b/steps", stepBody), { params: { sessionId: "a.b" } });
    expect(badId.status).toBe(404);
    expect(startStep).not.toHaveBeenCalled();
  });

  it("answers a database failure with a neutral unavailability", async () => {
    startStep.mockRejectedValue(new Error("database down"));
    const response = await handlers.POST_STEP(post("/api/answer-reviews/session-1/steps", stepBody), { params: { sessionId: "session-1" } });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "answer_review_unavailable" });
  });
});
