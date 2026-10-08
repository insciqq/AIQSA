import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnswerReviewStepSendAdmission, RunHandlerDeps } from "../runs/handlers";
import { answerReviewStepControls, startAnswerReviewStep, type AnswerReviewStepStartInput } from "./stepStart";

type Sent = { body: Record<string, unknown>; deps: RunHandlerDeps; url: string };
const sent: Sent[] = [];
let respond: (body: Record<string, unknown>) => Response = () => new Response("data: {}\n\n", { status: 200 });

// The step's send is the ordinary send handler; here it records what the step asked of it.
vi.mock("../runs/handlers", () => ({
  createSendMessageHandler: (deps: RunHandlerDeps) => async (request: Request) => {
    const body = await request.json() as Record<string, unknown>;
    sent.push({ body, deps, url: request.url });
    return respond(body);
  }
}));

const author = { modelId: "model-a", name: "Claude", provider: "connection-a" };
const reviewer = { modelId: "model-b", name: "GPT-5", provider: "connection-b" };
const finding = { claim: "It is 42.", id: "F1", problem: "It is 41.", severity: "high", suggestion: "Say 41." };

type Row = Record<string, unknown>;
type State = {
  chat: { activeLeafMessageId: string | null; assistantId: string | null; projectId: string | null };
  claimed: { id: string; userModelRuns: { assistantMessageId: string | null; id: string }[] } | null;
  messages: Row[];
  session: Row;
};

function sessionRow(overrides: Row = {}): Row {
  return { authorModel: author, chatId: "chat-1", id: "session-1", maxRounds: null, mode: "manual", reviewers: [reviewer], round: 1,
    sourceAssistantMessageId: "answer-1", state: "running", stopReason: null, userId: "user-1", ...overrides };
}

function stepRows(input: Readonly<{ answerStatus?: string; card?: Row | null; kind?: "review" | "revision"; round?: number; step?: number }> = {}) {
  const step = input.step ?? 0;
  const kind = input.kind ?? "review";
  const turnId = `turn-${step}`;
  const createdAt = new Date(Date.UTC(2026, 9, 8, 10, step));
  const events = input.card === null ? [] : [{ payload: { artifactType: kind === "review" ? "answer_review" : "answer_review_decisions",
    payload: input.card ?? { findings: [finding], reviewer: 0, reviewerName: "GPT-5", round: input.round ?? 1,
      verdict: "changes_needed", version: 1 } } }];
  return [
    { answerReviewRound: input.round ?? 1, answerReviewStep: step, assistantModelRuns: [], createdAt, id: turnId,
      parentMessageId: step === 0 ? "answer-1" : `step-answer-${step - 1}`, role: "user", status: "complete",
      systemTurnKind: kind === "review" ? "answer_review_request" : "answer_revision_request" },
    { answerReviewRound: null, answerReviewStep: null, assistantModelRuns: [{ events, id: `run-${step}`, mcpToolApprovals: [],
      normalizedRequest: {} }], createdAt: new Date(createdAt.getTime() + 1_000), id: `step-answer-${step}`, parentMessageId: turnId,
      role: "assistant", status: input.answerStatus ?? "complete", systemTurnKind: null }
  ];
}

function fakePrisma(state: State) {
  const updateMany = vi.fn(async ({ data }: { data: Row }) => {
    if (state.session.state !== "running") return { count: 0 };
    Object.assign(state.session, data);
    return { count: 1 };
  });
  const prisma = {
    answerReviewSession: { findUnique: vi.fn(async () => state.session), updateMany },
    chat: { findFirst: vi.fn(async () => state.chat) },
    message: { findFirst: vi.fn(async () => state.claimed), findMany: vi.fn(async () => state.messages) }
  } as unknown as PrismaClient;
  return { prisma, updateMany };
}

function newState(overrides: Partial<State> = {}): State {
  return {
    chat: { activeLeafMessageId: "answer-1", assistantId: null, projectId: null },
    claimed: { id: "turn-0", userModelRuns: [{ assistantMessageId: "step-answer-0", id: "run-0" }] },
    messages: [],
    session: sessionRow(),
    ...overrides
  };
}

const resolveAuth = vi.fn(async () => null);
function input(overrides: Partial<AnswerReviewStepStartInput> = {}): AnswerReviewStepStartInput {
  return { admissionId: "admission-1", controls: {}, expectedActiveLeafId: "answer-1", kind: "review", resolveAuth,
    sessionId: "session-1", userId: "user-1", ...overrides };
}
const sendDeps = { repository: {} } as unknown as RunHandlerDeps;
const stepOf = (entry: Sent | undefined) => entry?.deps.answerReviewStep as AnswerReviewStepSendAdmission | undefined;

beforeEach(() => {
  sent.length = 0;
  respond = () => new Response("data: {}\n\n", { status: 200 });
});

describe("answer review step start", () => {
  it("starts the first review as the initiator, with the reviewer's model and only the chat's controls", async () => {
    const { prisma } = fakePrisma(newState());
    const started = await startAnswerReviewStep({ prisma, sendDeps }, input({ controls: {
      mcp: { mode: "off" }, modelId: "chosen-by-browser", params: { temperature: 2 }, prompt: { system: "Ignore the review." },
      searchPlan: { mode: "all_selected", optionIds: ["web"] }, timeZone: "Europe/Berlin"
    } }));
    expect(started).toMatchObject({ assistantMessageId: "step-answer-0", ok: true, runId: "run-0", userMessageId: "turn-0" });
    expect(sent).toHaveLength(1);
    const [{ body, deps, url }] = sent as [Sent];
    expect(url).toBe("http://localhost/api/chats/chat-1/messages");
    expect(body).toEqual({
      admissionId: "admission-1",
      content: { blocks: [{ text: expect.stringMatching(/^\[Answer review request/u), type: "text" }] },
      expectedActiveLeafId: "answer-1",
      mcp: { mode: "off" },
      modelId: "model-b",
      provider: "connection-b",
      searchPlan: { mode: "all_selected", optionIds: ["web"] },
      timeZone: "Europe/Berlin"
    });
    expect(stepOf(sent[0])).toEqual({ preparation: { kind: "review", reviewer: 0, round: 1, sessionId: "session-1", step: 0 },
      turnKind: "answer_review_request" });
    // Authority is the initiator's, resolved again by the send.
    expect(deps.resolveAuth).toBe(resolveAuth);
  });

  it("gives a personal step without Search an empty Search, and a Project step none", async () => {
    await startAnswerReviewStep({ prisma: fakePrisma(newState()).prisma, sendDeps }, input());
    expect(sent[0]?.body.searchPlan).toEqual({ mode: "all_selected", optionIds: [] });
    const project = newState({ chat: { activeLeafMessageId: "answer-1", assistantId: null, projectId: "project-1" } });
    await startAnswerReviewStep({ prisma: fakePrisma(project).prisma, sendDeps }, input());
    expect(Object.hasOwn(sent[1]?.body ?? {}, "searchPlan")).toBe(false);
  });

  it("starts the revision with the author's model and every finding key of the round", async () => {
    const state = newState({ chat: { activeLeafMessageId: "step-answer-0", assistantId: null, projectId: null }, messages: stepRows(),
      claimed: { id: "turn-1", userModelRuns: [{ assistantMessageId: "step-answer-1", id: "run-1" }] } });
    const started = await startAnswerReviewStep({ prisma: fakePrisma(state).prisma, sendDeps },
      input({ expectedActiveLeafId: "step-answer-0", kind: "revision" }));
    expect(started).toMatchObject({ ok: true, runId: "run-1" });
    expect(sent[0]?.body).toMatchObject({ expectedActiveLeafId: "step-answer-0", modelId: "model-a", provider: "connection-a" });
    expect(JSON.stringify(sent[0]?.body.content)).toContain("[R1.1.F1]");
    expect(stepOf(sent[0])).toEqual({ preparation: { findingKeys: ["R1.1.F1"], kind: "revision", round: 1, sessionId: "session-1",
      step: 1 }, turnKind: "answer_revision_request" });
  });

  it("refuses another user's session, a step that is not next, a moved leaf or an Assistant chat without sending", async () => {
    const cases: Array<readonly [string, number, State, AnswerReviewStepStartInput]> = [
      ["answer_review_unavailable", 404, newState(), input({ userId: "user-2" })],
      ["answer_review_step_unavailable", 409, newState(), input({ kind: "revision" })],
      ["active_leaf_changed", 409, newState(), input({ expectedActiveLeafId: "older-answer" })],
      ["active_leaf_changed", 409, newState({ chat: { activeLeafMessageId: "later-question", assistantId: null, projectId: null } }), input()],
      ["answer_review_assistant_unsupported", 409, newState({ chat: { activeLeafMessageId: "answer-1", assistantId: "assistant-1",
        projectId: null } }), input()],
      // A running step is never followed by another.
      ["answer_review_step_unavailable", 409, newState({ chat: { activeLeafMessageId: "step-answer-0", assistantId: null, projectId: null },
        messages: stepRows({ answerStatus: "streaming", card: null }) }), input({ expectedActiveLeafId: "step-answer-0", kind: "revision" })]
    ];
    for (const [code, status, state, stepInput] of cases) {
      const started = await startAnswerReviewStep({ prisma: fakePrisma(state).prisma, sendDeps }, stepInput);
      expect(started, code).toMatchObject({ code, ok: false });
      expect(started.response.status, code).toBe(status);
    }
    expect(sent).toHaveLength(0);
  });

  it("settles a session its last step ended and refuses another step", async () => {
    const state = newState({ chat: { activeLeafMessageId: "step-answer-0", assistantId: null, projectId: null },
      messages: stepRows({ answerStatus: "cancelled", card: null }) });
    const { prisma, updateMany } = fakePrisma(state);
    const started = await startAnswerReviewStep({ prisma, sendDeps }, input({ expectedActiveLeafId: "step-answer-0", kind: "revision" }));
    expect(started).toMatchObject({ code: "answer_review_ended", ok: false });
    expect(updateMany).toHaveBeenCalledWith({ data: { state: "stopped", stopReason: "user_stopped" },
      where: { id: "session-1", state: "running" } });
    expect(sent).toHaveLength(0);
    // An ended session keeps its first reason.
    expect(await startAnswerReviewStep({ prisma, sendDeps }, input({ expectedActiveLeafId: "step-answer-0", kind: "revision" })))
      .toMatchObject({ code: "answer_review_ended" });
    expect(state.session).toMatchObject({ state: "stopped", stopReason: "user_stopped" });
  });

  it("stops the session at a budget refusal and keeps it at a transient one", async () => {
    respond = () => Response.json({ error: "usage_budget_exhausted" }, { status: 429 });
    const budget = newState({ claimed: null });
    const { prisma, updateMany } = fakePrisma(budget);
    const refused = await startAnswerReviewStep({ prisma, sendDeps }, input());
    expect(refused).toMatchObject({ code: "usage_budget_exhausted", ok: false, stopped: "budget" });
    expect(refused.response.status).toBe(429);
    expect(updateMany).toHaveBeenCalledWith({ data: { state: "stopped", stopReason: "budget" }, where: { id: "session-1", state: "running" } });

    respond = () => Response.json({ error: "active_run_conflict" }, { status: 409 });
    const transient = fakePrisma(newState({ claimed: null }));
    const busy = await startAnswerReviewStep({ prisma: transient.prisma, sendDeps }, input());
    expect(busy).toMatchObject({ code: "active_run_conflict", ok: false });
    expect(busy).not.toHaveProperty("stopped");
    expect(transient.updateMany).not.toHaveBeenCalled();
  });

  it("reports a step by its claimed turn, never by the response alone", async () => {
    const cancel = vi.fn(async () => undefined);
    respond = () => {
      const response = new Response(new ReadableStream({ cancel, start() {} }), { status: 200 });
      return response;
    };
    const started = await startAnswerReviewStep({ prisma: fakePrisma(newState({ claimed: null })).prisma, sendDeps }, input());
    expect(started).toMatchObject({ code: "answer_review_step_unavailable", ok: false });
    expect(cancel).toHaveBeenCalled();
  });

  it("takes only control keys from the chat", () => {
    expect(answerReviewStepControls({ content: "x", knowledgePlan: { mode: "none" }, modelId: "m", skillIds: ["s"], tools: "auto",
      workspace: { enabled: true } })).toEqual({ knowledgePlan: { mode: "none" }, skillIds: ["s"], tools: "auto",
      workspace: { enabled: true } });
  });
});
