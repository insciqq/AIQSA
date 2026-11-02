import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeResearchPlanProposal, RESEARCH_TIME_MS, researchPlanAnswerDocument, researchPlanProposalDocument, type ResearchPlanAnswer, type ResearchPlanProposal } from "../../contracts/research";
import { decodeThreadWorkspaceActivityEntry } from "../../contracts/workspace";
import { defaultNativeEngineDeps } from "../engine/defaultEngine";
import { createResearchPlanHandlers } from "./planHandlers";
import { createResearchPlanStore, createResearchPlanWindow, RESEARCH_PLAN_WINDOW_LIMITS, researchPlanRowView, researchPlanWindows, ResearchPlanWindows,
  type ResearchPlanStore, type ResearchPlanWindowKey } from "./planWindow";
import { proposalArguments } from "./planWindow.testFixtures";
import type { ResearchRunScope } from "./ports";

/**
 * The plan window under a fake clock, its route and its row. `seam.test.ts` runs it through the real engine; here is what a person does to it.
 */
const QUESTIONS = { questions: [{ question: "Which one?", sites: [], source_classes: ["primary_official", "independent_tests", "owner_reviews", "action_channel"] }] };
const decoded = decodeResearchPlanProposal(proposalArguments(QUESTIONS));
if (!decoded.ok) throw new Error(decoded.message);
const PROPOSAL: ResearchPlanProposal = decoded.value;
const KEY: ResearchPlanWindowKey = { chatId: "chat", runId: "run-1", userId: "user" };
const FOREIGN: ResearchPlanWindowKey = { ...KEY, userId: "someone-else" };

const OPENED_AT = Date.parse("2026-11-01T12:00:00.000Z");
/** A deadline no test of an ordinary window comes near. */
const FAR_DEADLINE = OPENED_AT + 24 * 60 * 60_000;

function memoryStore() {
  const store: ResearchPlanStore = {
    chatOpen: vi.fn(async ({ userId }) => userId === KEY.userId),
    closed: vi.fn(async () => undefined),
    held: vi.fn(async () => undefined),
    opened: vi.fn(async () => null),
    read: vi.fn(async () => null),
    rebuilt: vi.fn(async () => undefined)
  };
  return store;
}

function scope(extra: Partial<ResearchRunScope> = {}): ResearchRunScope {
  return { branchRunIds: [], chatId: KEY.chatId, extendTurn: () => undefined, now: () => Date.now(), researchRunId: KEY.runId, runId: KEY.runId,
    sources: { opened: async () => [] }, turnEndsAt: () => FAR_DEADLINE, userFollowups: async () => [], userId: KEY.userId, userMessage: "q", ...extra };
}

function opened(extra: Partial<ResearchRunScope> = {}, store = memoryStore(), signal = new AbortController().signal) {
  const windows = new ResearchPlanWindows();
  const answer = createResearchPlanWindow(scope(extra), { store, windows }).open({ goal: "Goal.", proposal: PROPOSAL, signal });
  answer.catch(() => undefined);
  const live = () => windows.find(KEY)!;
  return { answer, live, store, windows };
}

beforeEach(() => {
  vi.useFakeTimers({ now: OPENED_AT });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the window", () => {
  it("releases the proposal by itself at its time, with nobody there", async () => {
    const { answer, store, windows } = opened();
    await vi.advanceTimersByTimeAsync(RESEARCH_TIME_MS.planWindow - 1);
    expect(windows.find(KEY)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toEqual({ changed: false, plan: PROPOSAL, releasedBy: "timer" });
    expect(windows.find(KEY)).toBeNull();
    expect(store.opened).toHaveBeenCalledWith(KEY, { goal: "Goal.", proposal: PROPOSAL, windowEndsAt: new Date(Date.parse("2026-11-01T12:00:00.000Z") + RESEARCH_TIME_MS.planWindow) });
    expect(store.closed).toHaveBeenCalledWith(KEY, { answer: { changed: false, plan: PROPOSAL, releasedBy: "timer" },
      frame: { branches: [], changes: [], criteria: PROPOSAL.criteria, rows: [] }, releasedAt: expect.any(Date) });
  });

  it("closes at once on the button and on a saved edit, and says whether the plan changed", async () => {
    const first = opened();
    await vi.advanceTimersByTimeAsync(0);
    await expect(first.live().act({ action: "start", runId: KEY.runId })).resolves.toBe("applied");
    await expect(first.answer).resolves.toMatchObject({ changed: false, releasedBy: "start_button" });

    const second = opened();
    await vi.advanceTimersByTimeAsync(0);
    const edit = { assumptions: [], steps: ["Only this"], understood: "Other." };
    await second.live().act({ action: "save", edit, runId: KEY.runId });
    await expect(second.answer).resolves.toEqual({ changed: true, plan: { ...PROPOSAL, ...edit }, releasedBy: "saved_edit" });

    const same = opened();
    await vi.advanceTimersByTimeAsync(0);
    await same.live().act({ action: "save", edit: { assumptions: PROPOSAL.assumptions, steps: PROPOSAL.steps, understood: PROPOSAL.understood }, runId: KEY.runId });
    await expect(same.answer).resolves.toMatchObject({ changed: false, releasedBy: "saved_edit" });
  });

  it("holds the timer through a lease, and an abandoned edit releases the plan as it stood", async () => {
    const { answer, live, store } = opened();
    await vi.advanceTimersByTimeAsync(20_000);
    await live().act({ action: "hold", runId: KEY.runId });
    expect(live().view().heldUntil).toBe(new Date(Date.now() + RESEARCH_TIME_MS.abandonedEdit).toISOString());
    expect(store.held).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(RESEARCH_TIME_MS.planWindow);
    expect(store.closed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(RESEARCH_TIME_MS.abandonedEdit);
    await expect(answer).resolves.toEqual({ changed: false, plan: PROPOSAL, releasedBy: "abandoned_edit" });
  });

  it("gives the remaining time back when an edit is cancelled, and at least the minimum a person can see", async () => {
    const { answer, live } = opened();
    await vi.advanceTimersByTimeAsync(20_000);
    await live().act({ action: "hold", runId: KEY.runId });
    await vi.advanceTimersByTimeAsync(30_000);
    await live().act({ action: "cancel_hold", runId: KEY.runId });
    expect(live().view().heldUntil).toBeNull();
    expect(Date.parse(live().view().windowEndsAt) - Date.now()).toBe(RESEARCH_TIME_MS.planWindow - 20_000);
    await vi.advanceTimersByTimeAsync(RESEARCH_TIME_MS.planWindow - 21_000);
    await live().act({ action: "hold", runId: KEY.runId });
    await live().act({ action: "cancel_hold", runId: KEY.runId });
    expect(Date.parse(live().view().windowEndsAt) - Date.now()).toBe(RESEARCH_PLAN_WINDOW_LIMITS.resumeMinimumMs);
    await vi.advanceTimersByTimeAsync(RESEARCH_PLAN_WINDOW_LIMITS.resumeMinimumMs);
    await expect(answer).resolves.toMatchObject({ releasedBy: "timer" });
  });

  it("renews a lease while a person edits, and only so far", async () => {
    const { answer, live, store } = opened();
    await vi.advanceTimersByTimeAsync(0);
    for (let lease = 0; lease < RESEARCH_PLAN_WINDOW_LIMITS.holdLeases + 2 && !vi.mocked(store.closed).mock.calls.length; lease += 1) {
      await live()?.act({ action: "hold", runId: KEY.runId });
      await vi.advanceTimersByTimeAsync(RESEARCH_TIME_MS.abandonedEdit - 1_000);
    }
    await vi.advanceTimersByTimeAsync(RESEARCH_TIME_MS.abandonedEdit);
    await expect(answer).resolves.toMatchObject({ releasedBy: "abandoned_edit" });
    expect(Date.now() - Date.parse("2026-11-01T12:00:00.000Z")).toBeLessThanOrEqual((RESEARCH_PLAN_WINDOW_LIMITS.holdLeases + 2) * RESEARCH_TIME_MS.abandonedEdit);
  });

  it("takes a chat message as an edit, held or not, and not what was written before it opened", async () => {
    let written = [{ id: "earlier", text: "Written while scoping." }];
    const { answer, live } = opened({ userFollowups: async () => written });
    await vi.advanceTimersByTimeAsync(RESEARCH_PLAN_WINDOW_LIMITS.followupPollMs * 2);
    await live().act({ action: "hold", runId: KEY.runId });
    expect(live()).not.toBeNull();
    written = [...written, { id: "new", text: "Cheaper, please." }];
    await vi.advanceTimersByTimeAsync(RESEARCH_PLAN_WINDOW_LIMITS.followupPollMs);
    await expect(answer).resolves.toEqual({ changed: false, plan: PROPOSAL, releasedBy: "chat_message" });
  });

  it("goes on when reading what the user wrote fails", async () => {
    const { answer } = opened({ userFollowups: async () => { throw new Error("database down"); } });
    await vi.advanceTimersByTimeAsync(RESEARCH_TIME_MS.planWindow);
    await expect(answer).resolves.toMatchObject({ releasedBy: "timer" });
  });

  it("is rejected through the signal on Stop, writing no release", async () => {
    const stop = new AbortController();
    const { answer, store, windows } = opened({}, memoryStore(), stop.signal);
    await vi.advanceTimersByTimeAsync(1_000);
    stop.abort(new Error("stopped"));
    await expect(answer).rejects.toThrow("stopped");
    expect(store.closed).not.toHaveBeenCalled();
    expect(windows.find(KEY)).toBeNull();
  });

  it("releases the plan even when its row cannot be written: bookkeeping never holds the answer", async () => {
    const store = memoryStore();
    vi.mocked(store.opened).mockRejectedValue(new Error("database down"));
    vi.mocked(store.closed).mockRejectedValue(new Error("database down"));
    const { answer } = opened({}, store);
    await vi.advanceTimersByTimeAsync(RESEARCH_TIME_MS.planWindow);
    await expect(answer).resolves.toMatchObject({ releasedBy: "timer" });
  });

  it("keeps an action on a closing window out, and answers it as closed", async () => {
    const store = memoryStore();
    let finish: () => void = () => undefined;
    vi.mocked(store.closed).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { answer, live } = opened({}, store);
    await vi.advanceTimersByTimeAsync(0);
    const window = live();
    void window.act({ action: "start", runId: KEY.runId });
    await expect(window.act({ action: "hold", runId: KEY.runId })).resolves.toBe("closed");
    expect(window.view().answer).toMatchObject({ releasedBy: "start_button" });
    finish();
    await answer;
  });

  it("opens no window on an answered plan, and a rebuilt plan replaces the answer's", async () => {
    const store = memoryStore();
    const windows = new ResearchPlanWindows();
    const port = createResearchPlanWindow(scope(), { store, windows });
    const first = port.open({ goal: "Goal.", proposal: PROPOSAL, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(0);
    await windows.find(KEY)!.act({ action: "save", edit: { assumptions: [], steps: ["Mine"], understood: "Mine." }, runId: KEY.runId });
    await first;
    const rebuilt = { ...PROPOSAL, steps: ["Mine"], understood: "Mine." };
    await expect(port.open({ goal: "Goal.", proposal: rebuilt, signal: new AbortController().signal })).resolves.toEqual({ changed: true, plan: rebuilt, releasedBy: "saved_edit" });
    expect(windows.find(KEY)).toBeNull();
    expect(store.rebuilt).toHaveBeenCalledWith(KEY, expect.objectContaining({ answer: { changed: true, plan: rebuilt, releasedBy: "saved_edit" } }));
  });

  it("finds an answered plan from its row on a continuation's new port", async () => {
    const stored: ResearchPlanAnswer = { changed: true, plan: PROPOSAL, releasedBy: "saved_edit" };
    const store = memoryStore();
    vi.mocked(store.opened).mockResolvedValue(researchPlanAnswerDocument(stored));
    const { answer, windows } = opened({ runId: "run-2" }, store);
    await expect(answer).resolves.toEqual(stored);
    expect(windows.find(KEY)).toBeNull();
    expect(store.rebuilt).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(RESEARCH_TIME_MS.planWindow * 2);
    expect(store.closed).not.toHaveBeenCalled();
  });
});

describe("the turn's deadline", () => {
  const reserve = RESEARCH_PLAN_WINDOW_LIMITS.releaseReserveMs;
  const endingIn = (ms: number) => ({ turnEndsAt: () => OPENED_AT + ms });

  it("releases a held edit in time for the release to extend the turn, as an abandoned edit", async () => {
    const turnMs = 3 * 60_000;
    const { answer, live, store } = opened(endingIn(turnMs));
    await vi.advanceTimersByTimeAsync(20_000);
    await live().act({ action: "hold", runId: KEY.runId });
    expect(live().view().heldUntil).toBe(new Date(OPENED_AT + turnMs - reserve).toISOString());
    await vi.advanceTimersByTimeAsync(turnMs - reserve - 20_000 - 1);
    expect(store.closed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toEqual({ changed: false, plan: PROPOSAL, releasedBy: "abandoned_edit" });
    expect(Date.now()).toBe(OPENED_AT + turnMs - reserve);
  });

  it("does not let a renewed lease pass it", async () => {
    const turnMs = RESEARCH_TIME_MS.abandonedEdit + 2 * 60_000;
    const { answer, live } = opened(endingIn(turnMs));
    await vi.advanceTimersByTimeAsync(0);
    await live().act({ action: "hold", runId: KEY.runId });
    await vi.advanceTimersByTimeAsync(RESEARCH_TIME_MS.abandonedEdit - 1_000);
    await live().act({ action: "hold", runId: KEY.runId });
    expect(live().view().heldUntil).toBe(new Date(OPENED_AT + turnMs - reserve).toISOString());
    await vi.advanceTimersByTimeAsync(OPENED_AT + turnMs - reserve - Date.now());
    await expect(answer).resolves.toMatchObject({ releasedBy: "abandoned_edit" });
    expect(Date.now()).toBe(OPENED_AT + turnMs - reserve);
  });

  it("shortens a window opened late, so the countdown is the truth, and gives back no more than is left", async () => {
    const turnMs = reserve + 30_000;
    const { answer, live } = opened(endingIn(turnMs));
    await vi.advanceTimersByTimeAsync(0);
    expect(live().view().windowEndsAt).toBe(new Date(OPENED_AT + 30_000).toISOString());
    await vi.advanceTimersByTimeAsync(25_000);
    await live().act({ action: "hold", runId: KEY.runId });
    await live().act({ action: "cancel_hold", runId: KEY.runId });
    expect(live().view().windowEndsAt).toBe(new Date(OPENED_AT + 30_000).toISOString());
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(answer).resolves.toMatchObject({ releasedBy: "timer" });
  });

  it("releases at once a window opened with no time left, so research still starts", async () => {
    const { answer } = opened(endingIn(reserve - 1_000));
    await vi.advanceTimersByTimeAsync(0);
    await expect(answer).resolves.toEqual({ changed: false, plan: PROPOSAL, releasedBy: "timer" });
    expect(Date.now()).toBe(OPENED_AT);
  });

  it("changes nothing for a hold far from it", async () => {
    const { answer, live } = opened(endingIn(60 * 60_000));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(live().view().windowEndsAt).toBe(new Date(OPENED_AT + RESEARCH_TIME_MS.planWindow).toISOString());
    await live().act({ action: "hold", runId: KEY.runId });
    expect(live().view().heldUntil).toBe(new Date(OPENED_AT + 20_000 + RESEARCH_TIME_MS.abandonedEdit).toISOString());
    await vi.advanceTimersByTimeAsync(RESEARCH_TIME_MS.abandonedEdit);
    await expect(answer).resolves.toMatchObject({ releasedBy: "abandoned_edit" });
    expect(Date.now()).toBe(OPENED_AT + 20_000 + RESEARCH_TIME_MS.abandonedEdit);
  });
});

describe("the row", () => {
  it("answers a reload after the window closed", () => {
    const answer: ResearchPlanAnswer = { changed: true, plan: { ...PROPOSAL, steps: ["Mine"] }, releasedBy: "saved_edit" };
    const windowEndsAt = new Date(Date.now() - 5_000);
    expect(researchPlanRowView({ answer: researchPlanAnswerDocument(answer), heldUntil: null, proposal: researchPlanProposalDocument(PROPOSAL), windowEndsAt }, KEY.runId, Date.now()))
      .toEqual({ answer, heldUntil: null, proposal: PROPOSAL, runId: KEY.runId, serverTime: new Date().toISOString(), windowEndsAt: windowEndsAt.toISOString() });
  });

  it("reads as ended with no answer when its run is gone: a countdown never goes on with nothing waiting", () => {
    const view = researchPlanRowView({ answer: null, heldUntil: new Date(Date.now() + 60_000), proposal: researchPlanProposalDocument(PROPOSAL), windowEndsAt: new Date(Date.now() + 30_000) }, KEY.runId, Date.now())!;
    expect(view).toMatchObject({ answer: null, heldUntil: null, serverTime: view.windowEndsAt });
  });

  it("is written under the owner, chat and run, and never over a release", async () => {
    const researchFrame = { findFirst: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 1 })), upsert: vi.fn(async () => ({})) };
    const store = createResearchPlanStore({ chat: { findFirst: vi.fn(async () => null) }, researchFrame } as never);
    await store.opened(KEY, { goal: "Goal.", proposal: PROPOSAL, windowEndsAt: new Date() });
    expect(researchFrame.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ chatId: "chat", goal: "Goal.", modelRunId: "run-1", userId: "user" }),
      where: { userId_chatId_modelRunId: { chatId: "chat", modelRunId: "run-1", userId: "user" } } }));
    await store.closed(KEY, { answer: { changed: false, plan: PROPOSAL, releasedBy: "timer" }, frame: { branches: [], changes: [], criteria: PROPOSAL.criteria, rows: [] }, releasedAt: new Date() });
    expect(researchFrame.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { chatId: "chat", modelRunId: "run-1", releasedAt: null, userId: "user" } }));
    await expect(store.chatOpen({ chatId: "chat", userId: "user" })).resolves.toBe(false);
  });

  it("leaves a frame someone changed alone when a plan is rebuilt", async () => {
    const researchFrame = { updateMany: vi.fn(async () => ({ count: 0 })) };
    const store = createResearchPlanStore({ chat: {}, researchFrame } as never);
    await store.rebuilt(KEY, { answer: { changed: true, plan: PROPOSAL, releasedBy: "saved_edit" }, frame: { branches: [], changes: [], criteria: PROPOSAL.criteria, rows: [] } });
    expect(researchFrame.updateMany).toHaveBeenCalledTimes(2);
    expect(researchFrame.updateMany.mock.calls[0]).toEqual([expect.objectContaining({ data: expect.objectContaining({ frame: expect.anything() }), where: expect.objectContaining({ version: 1 }) })]);
    expect(researchFrame.updateMany.mock.calls[1]).toEqual([expect.objectContaining({ data: { answer: expect.anything() } })]);
  });
});

describe("the route", () => {
  type Auth = Readonly<{ status?: string; userId: string }> | null;

  function route(auth: Auth = { userId: KEY.userId }) {
    const store = memoryStore();
    const windows = new ResearchPlanWindows();
    const handlers = createResearchPlanHandlers({ now: () => Date.now(), resolveAuth: (async () => auth ? { id: "session", user: { status: auth.status ?? "active" }, userId: auth.userId } : null) as never, store, windows });
    const context = { params: { chatId: KEY.chatId } };
    const get = (runId = KEY.runId) => handlers.read(new Request(`http://app/api/chats/chat/research/plan?runId=${encodeURIComponent(runId)}`), context);
    const post = (body: unknown) => handlers.act(new Request("http://app/api/chats/chat/research/plan", { body: typeof body === "string" ? body : JSON.stringify(body), method: "POST" }), context);
    return { get, post, store, windows };
  }

  const open = async (at: ReturnType<typeof route>) => {
    const answer = createResearchPlanWindow(scope(), { store: at.store, windows: at.windows }).open({ goal: "Goal.", proposal: PROPOSAL, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(0);
    return answer;
  };

  it("shows the owner a waiting window with the server's times", async () => {
    const at = route();
    void open(at);
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await at.get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ answer: null, heldUntil: null, proposal: { understood: PROPOSAL.understood }, runId: KEY.runId, serverTime: new Date().toISOString(),
      windowEndsAt: new Date(Date.now() + RESEARCH_TIME_MS.planWindow - 5_000).toISOString() });
  });

  it("gives another user's window and a missing one the same response, and changes nothing", async () => {
    const owner = route();
    void open(owner);
    const otherUser = createResearchPlanHandlers({ resolveAuth: (async () => ({ id: "s", user: { status: "active" }, userId: FOREIGN.userId })) as never, store: owner.store, windows: owner.windows });
    const context = { params: { chatId: KEY.chatId } };
    const foreign = await otherUser.read(new Request(`http://app/x?runId=${KEY.runId}`), context);
    const foreignPost = await otherUser.act(new Request("http://app/x", { body: JSON.stringify({ action: "start", runId: KEY.runId }), method: "POST" }), context);
    const missing = await route().get("run-none");
    expect([foreign.status, foreignPost.status, missing.status]).toEqual([404, 404, 404]);
    const bodies = await Promise.all([foreign.json(), foreignPost.json(), missing.json()]);
    expect(bodies[0]).toEqual(bodies[2]);
    expect(bodies[1]).toEqual(bodies[2]);
    expect(owner.windows.find(KEY)).not.toBeNull();
    expect(owner.store.closed).not.toHaveBeenCalled();
  });

  it("refuses a chat of the same id that is not the caller's, even when its window waits under that user", async () => {
    const at = route();
    void open(at);
    vi.mocked(at.store.chatOpen).mockResolvedValue(false);
    expect((await at.get()).status).toBe(404);
    expect((await at.post({ action: "start", runId: KEY.runId })).status).toBe(404);
    expect(at.store.closed).not.toHaveBeenCalled();
  });

  it("gives someone signed out or inactive the same answer", async () => {
    for (const auth of [null, { status: "disabled", userId: KEY.userId }]) {
      const at = route(auth);
      void open(at);
      expect((await at.get()).status).toBe(404);
      expect((await at.post({ action: "start", runId: KEY.runId })).status).toBe(404);
      expect(at.windows.find(KEY)).not.toBeNull();
    }
  });

  it("bounds and decodes a body before it touches anything", async () => {
    const at = route();
    void open(at);
    for (const body of ["not json", { action: "explode", runId: KEY.runId }, { action: "save", plan: { steps: [] }, runId: KEY.runId }, { action: "start" }, "x".repeat(70_000)]) {
      expect((await at.post(body)).status, String(body).slice(0, 20)).toBe(400);
    }
    expect(await (await at.post({ action: "save", plan: { assumptions: [], steps: [], understood: "u" }, runId: KEY.runId })).json()).toMatchObject({ code: "research_plan_request_invalid", message: expect.stringContaining("steps") });
    expect(at.store.chatOpen).not.toHaveBeenCalled();
    expect(at.store.closed).not.toHaveBeenCalled();
  });

  it("answers an action on a closed window plainly, from the row, and a reload after it", async () => {
    const at = route();
    const answer: ResearchPlanAnswer = { changed: false, plan: PROPOSAL, releasedBy: "timer" };
    vi.mocked(at.store.read).mockResolvedValue({ answer: researchPlanAnswerDocument(answer), heldUntil: null, proposal: researchPlanProposalDocument(PROPOSAL), windowEndsAt: new Date(Date.now() - 1_000) });
    const response = await at.post({ action: "start", runId: KEY.runId });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "closed", view: { answer: { releasedBy: "timer" } } });
    expect(await (await at.get()).json()).toMatchObject({ answer: { releasedBy: "timer" } });
  });

  it("applies the button and a lease, and each answer holds the window as it now stands", async () => {
    const at = route();
    const closing = open(at);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await (await at.post({ action: "hold", runId: KEY.runId })).json()).toMatchObject({ outcome: "applied", view: { heldUntil: expect.any(String) } });
    expect(await (await at.post({ action: "start", runId: KEY.runId })).json()).toMatchObject({ outcome: "applied", view: { answer: { releasedBy: "start_button" } } });
    await expect(closing).resolves.toMatchObject({ releasedBy: "start_button" });
  });
});

describe("what reaches production", () => {
  it("is the real window: the engine's deps open it on the database and in the process's windows", async () => {
    const researchFrame = { findFirst: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 1 })), upsert: vi.fn(async () => ({})) };
    const deps = defaultNativeEngineDeps({} as never, { researchFrame } as never);
    const factory = deps.research?.ports?.planWindow;
    expect(factory).toBeTypeOf("function");
    const run = scope({ researchRunId: "run-production", runId: "run-production" });
    const answer = factory!(run).open({ goal: "Goal.", proposal: PROPOSAL, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(researchFrame.upsert).toHaveBeenCalledOnce();
    const key = { ...KEY, runId: "run-production" };
    expect(researchPlanWindows().find(key)).not.toBeNull();
    await researchPlanWindows().find(key)!.act({ action: "start", runId: key.runId });
    await expect(answer).resolves.toMatchObject({ releasedBy: "start_button" });
    expect(researchFrame.updateMany).toHaveBeenCalledOnce();
  });
});

describe("the activity entry", () => {
  const entry = { id: "plan:abc", items: [{ completed: false, text: "Step." }], kind: "plan", phase: "running" };

  it("carries the run of a plan window through the contract", () => {
    const window = { ...entry, researchPlan: { runId: "run-1", state: "window" } };
    expect(decodeThreadWorkspaceActivityEntry(window)).toEqual(window);
  });

  it("is refused anywhere but on a plan, and with anything else in it", () => {
    expect(decodeThreadWorkspaceActivityEntry({ ...entry, researchPlan: { runId: "run-1", state: "open" } })).toBeNull();
    expect(decodeThreadWorkspaceActivityEntry({ ...entry, researchPlan: { other: true, runId: "run-1", state: "window" } })).toBeNull();
    expect(decodeThreadWorkspaceActivityEntry({ ...entry, researchPlan: { runId: "not an id!", state: "window" } })).toBeNull();
    expect(decodeThreadWorkspaceActivityEntry({ id: "note", kind: "agent_note", phase: "succeeded", researchPlan: { runId: "run-1", state: "window" }, text: "Note." })).toBeNull();
  });
});
