import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composerSessionKey, selectComposerSession, useComposerSessionStore } from "@/components/app-shell/composerSessionStore";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import type { ResearchPlanRelease } from "@/lib/contracts/research";
import type { ThreadWorkspaceActivity, ThreadWorkspaceActivityEntry } from "@/lib/contracts/workspace";
import { AnswerProcessV2 } from "./AnswerProcessV2";
import { ResearchPlanCardV2 } from "./ResearchPlanCardV2";

const chatId = "chat-1";
const runId = "run-1";
const SERVER_START = Date.parse("2026-11-02T10:00:00.000Z");
const START = "Start research";

const words = { assumptions: ["Price matters most"], steps: ["Read the standards", "Find the candidates", "Compare them", "Pick one"],
  understood: "You want the best kettle" };
const row = (state: "scoping" | "window", items = words.steps): ThreadWorkspaceActivityEntry => ({
  id: "plan:run-1", items: items.map((text) => ({ completed: false, text })), kind: "plan", phase: "running", researchPlan: { runId, state }, sequence: 3
});
const activity = (entry: ThreadWorkspaceActivityEntry): ThreadWorkspaceActivity => ({ entries: [entry] });

type Answer = Readonly<{ changed: boolean; plan: typeof words; releasedBy: ResearchPlanRelease }>;

/** The route as a browser sees it, on a clock of its own: nothing in here reads the client's time. */
function planRoute() {
  const route = {
    answer: null as Answer | null,
    /** The next POST of this action fails with this status. */
    failNext: null as Readonly<{ action: string; status: number }> | null,
    gone: false,
    heldUntil: null as number | null,
    /** The server's cap on `heldUntil`. */
    leaseCap: Infinity,
    notFound: false,
    now: SERVER_START,
    /** The next POST finds the window closed by this. */
    closeOnPost: null as Answer | null,
    posts: [] as Record<string, unknown>[],
    reads: 0,
    windowEndsAt: SERVER_START + 42_000
  };
  const view = () => ({
    answer: route.answer, heldUntil: route.heldUntil === null ? null : new Date(route.heldUntil).toISOString(),
    proposal: { ...words, branches: [], criteria: [], questions: [], rows: [], skipped: [] }, runId, serverTime: new Date(route.now).toISOString(),
    windowEndsAt: new Date(route.gone ? Math.min(route.windowEndsAt, route.now) : route.windowEndsAt).toISOString()
  });
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (route.notFound) return Response.json({ code: "research_plan_not_found" }, { status: 404 });
    if (init?.method !== "POST") {
      route.reads += 1;
      return Response.json(view());
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    route.posts.push(body);
    const failing = route.failNext;
    if (failing && failing.action === body.action) {
      const { status } = failing;
      route.failNext = null;
      return Response.json({ code: status === 400 ? "research_plan_request_invalid" : "unavailable" }, { status });
    }
    if (route.closeOnPost) {
      route.answer = route.closeOnPost;
      route.closeOnPost = null;
      return Response.json({ outcome: "closed", view: view() });
    }
    if (body.action === "start") route.answer = { changed: false, plan: words, releasedBy: "start_button" };
    if (body.action === "save") route.answer = { changed: true, plan: body.plan as typeof words, releasedBy: "saved_edit" };
    if (body.action === "hold") route.heldUntil = Math.min(route.now + 300_000, route.leaseCap);
    if (body.action === "cancel_hold") {
      route.heldUntil = null;
      route.windowEndsAt = route.now + 42_000;
    }
    return Response.json({ outcome: "applied", view: view() });
  });
  vi.stubGlobal("fetch", fetchMock);
  return route;
}

/** Moves the server and the browser's timers together. */
async function pass(route: ReturnType<typeof planRoute>, ms: number) {
  const step = 500;
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    route.now += step;
    await act(() => vi.advanceTimersByTimeAsync(step));
  }
}

const settle = () => act(() => vi.advanceTimersByTimeAsync(0));
const card = () => screen.getByTestId("research-plan-card");
const clock = () => screen.getByTestId("research-plan-clock").textContent;
const button = (name: string) => within(card()).getByRole("button", { name });
const startButton = () => button(START);

async function openWindow() {
  const view = render(<ResearchPlanCardV2 activity={activity(row("window"))} live />);
  await settle();
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(SERVER_START);
  useWorkspaceStore.setState({ activeChatId: chatId });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useWorkspaceStore.setState({ activeChatId: null });
});

describe("while a plan is being made", () => {
  it("shows the server's line as it comes and asks the route for nothing", async () => {
    const route = planRoute();
    render(<ResearchPlanCardV2 activity={activity(row("scoping", ["Making a plan before research starts"]))} live />);
    await settle();
    expect(card()).toHaveAttribute("data-state", "scoping");
    expect(card()).toHaveTextContent("Making a plan before research starts");
    expect(within(card()).queryByRole("button")).toBeNull();
    expect(route.reads).toBe(0);
  });

  it("leaves an answer that ended in scoping to the ordinary plan", () => {
    planRoute();
    render(<AnswerProcessV2 workspaceActivity={activity(row("scoping", ["Making a plan before research starts"]))} />);
    expect(screen.queryByTestId("research-plan-card")).toBeNull();
    expect(screen.getByTestId("tool-activity-disclosure").querySelector("summary")).toHaveTextContent("Plan · 0 of 1 complete");
  });
});

describe("the window", () => {
  it("shows how the task was understood, the assumptions, the numbered steps and the time the server gave", async () => {
    planRoute();
    await openWindow();
    expect(card()).toHaveAttribute("data-state", "window");
    expect(card()).toHaveTextContent(words.understood);
    expect(card()).toHaveTextContent(words.assumptions[0]!);
    expect(within(card()).getAllByRole("listitem").map((item) => item.textContent)).toEqual([...words.assumptions, ...words.steps]);
    expect(clock()).toBe("Research starts in 0:42");
    expect(startButton()).toHaveAttribute("lang", "ru");
  });

  it("starts research at once and shows the plan standing until the row takes over", async () => {
    const route = planRoute();
    await openWindow();
    fireEvent.click(startButton());
    await settle();
    expect(route.posts).toEqual([{ action: "start", runId }]);
    expect(card()).toHaveAttribute("data-state", "answered");
    expect(card()).toHaveTextContent("The plan stands. Research is starting.");
    expect(within(card()).queryByRole("button")).toBeNull();
    const reads = route.reads;
    await pass(route, 20_000);
    expect(route.reads).toBe(reads);
  });

  it("turns into the ordinary plan when the row loses researchPlan", async () => {
    planRoute();
    const { rerender } = render(<AnswerProcessV2 liveLabel="Working…" workspaceActivity={activity(row("window"))} />);
    await settle();
    expect(card()).toBeVisible();
    expect(screen.queryByTestId("answer-plan")).toBeNull();
    expect(document.body).not.toHaveTextContent("0 of 4 complete");
    const { researchPlan: _released, ...stands } = row("window");
    rerender(<AnswerProcessV2 liveLabel="Working…" workspaceActivity={activity(stands)} />);
    expect(screen.queryByTestId("research-plan-card")).toBeNull();
    expect(screen.getByTestId("tool-activity-disclosure").querySelector("summary")).toHaveTextContent("Plan · 0 of 4 complete");
  });

  it("stays right after a reload", async () => {
    const route = planRoute();
    const { unmount } = await openWindow();
    await pass(route, 12_000);
    unmount();
    route.now += 5_000;
    await openWindow();
    expect(clock()).toBe("Research starts in 0:25");
  });

  it("counts by the server's time whatever the client's clock says", async () => {
    const route = planRoute();
    vi.setSystemTime(Date.parse("2001-01-01T00:00:00.000Z"));
    await openWindow();
    expect(clock()).toBe("Research starts in 0:42");
    await pass(route, 2_000);
    vi.setSystemTime(Date.parse("2040-01-01T00:00:00.000Z"));
    await pass(route, 1_000);
    expect(clock()).toBe("Research starts in 0:39");
  });

  it("re-reads when a background tab comes back, so a hold from elsewhere shows at once", async () => {
    const route = planRoute();
    await openWindow();
    route.heldUntil = route.now + 300_000;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(card()).toHaveAttribute("data-state", "held");
  });

  it("is right at a throttled timer's late firing, which also re-reads", async () => {
    const route = planRoute();
    await openWindow();
    const reads = route.reads;
    // A background tab's timers fire late: the server's minute went by in one firing.
    route.now += 30_000;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(clock()).toBe("Research starts in 0:12");
    expect(route.reads).toBeGreaterThan(reads);
  });

  it("speaks only at meaningful moments, never with the seconds", async () => {
    const route = planRoute();
    await openWindow();
    const live = () => within(card()).getByRole("status");
    expect(screen.getByTestId("research-plan-clock")).toHaveAttribute("aria-hidden", "true");
    expect(live()).toHaveTextContent("about a minute");
    await pass(route, 5_000);
    expect(live()).toHaveTextContent("about a minute");
    await pass(route, 8_000);
    expect(live()).toHaveTextContent("Research starts in 30 seconds.");
    await pass(route, 15_000);
    expect(live()).toHaveTextContent("Research starts in 30 seconds.");
    await pass(route, 6_000);
    expect(live()).toHaveTextContent("Research starts in 10 seconds.");
  });

  it("polls at zero until the answer arrives", async () => {
    const route = planRoute();
    await openWindow();
    await pass(route, 42_500);
    expect(card()).toHaveAttribute("data-state", "closing");
    expect(card()).toHaveTextContent("The time is up.");
    expect(screen.queryByTestId("research-plan-clock")).toBeNull();
    expect(within(card()).queryByRole("button")).toBeNull();
    route.answer = { changed: false, plan: words, releasedBy: "timer" };
    await pass(route, 1_500);
    expect(card()).toHaveAttribute("data-state", "answered");
  });

  it("shows a closed window as closed on load", async () => {
    const route = planRoute();
    route.answer = { changed: true, plan: { ...words, steps: ["Only this"] }, releasedBy: "saved_edit" };
    route.windowEndsAt = route.now - 10_000;
    await openWindow();
    expect(card()).toHaveAttribute("data-state", "answered");
    expect(card()).toHaveTextContent("Only this");
    expect(card()).not.toHaveTextContent(words.steps[0]!);
  });

  it("says plainly when the run is gone, with no countdown and no actions", async () => {
    const route = planRoute();
    route.gone = true;
    route.windowEndsAt = route.now;
    await openWindow();
    await pass(route, 1_500);
    expect(card()).toHaveAttribute("data-state", "gone");
    expect(card()).toHaveTextContent("This plan ended before research started");
    expect(card()).toHaveTextContent(words.steps[0]!);
    expect(screen.queryByTestId("research-plan-clock")).toBeNull();
    expect(within(card()).queryByRole("button")).toBeNull();
    const reads = route.reads;
    await pass(route, 20_000);
    expect(route.reads).toBe(reads);
  });

  it("treats a window the route does not know as gone, with the row's steps", async () => {
    const route = planRoute();
    route.notFound = true;
    await openWindow();
    expect(card()).toHaveAttribute("data-state", "gone");
    expect(card()).toHaveTextContent(words.steps[3]!);
  });

  it("fails visibly when the plan cannot be read, and retries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    render(<ResearchPlanCardV2 activity={activity(row("window"))} live />);
    await settle();
    expect(card()).toHaveAttribute("data-state", "failed");
    expect(card()).toHaveTextContent("Could not load the plan.");
    planRoute();
    fireEvent.click(button("Try again"));
    await settle();
    expect(card()).toHaveAttribute("data-state", "window");
  });

  it("shows a second tab the same state by the same reads", async () => {
    const route = planRoute();
    await openWindow();
    const first = card();
    render(<div data-testid="second"><ResearchPlanCardV2 activity={activity(row("window"))} live /></div>);
    await settle();
    fireEvent.click(within(first).getByRole("button", { name: "Edit" }));
    await settle();
    await pass(route, 5_500);
    const second = within(screen.getByTestId("second")).getByTestId("research-plan-card");
    expect(second).toHaveAttribute("data-state", "held");
    expect(within(second).getByTestId("research-plan-clock")).toHaveTextContent("Timer held by an edit, up to 4:5");
    fireEvent.click(within(second).getByRole("button", { name: "Resume timer" }));
    await settle();
    expect(second).toHaveAttribute("data-state", "window");
  });
});

describe("editing", () => {
  async function edit() {
    await openWindow();
    fireEvent.click(button("Edit"));
    await settle();
  }

  it("holds the timer when editing starts, says so and moves focus into the plan", async () => {
    const route = planRoute();
    await edit();
    expect(route.posts).toEqual([{ action: "hold", runId }]);
    expect(card()).toHaveAttribute("data-state", "editing");
    expect(clock()).toBe("Timer held while you edit");
    expect(screen.getByLabelText("How I understood the task")).toHaveFocus();
    await pass(route, 10_000);
    expect(clock()).toBe("Timer held while you edit");
    expect(within(card()).getAllByRole("status")[0]).toHaveTextContent("The timer is held");
  });

  it("renews the lease before it runs out, and shows what is left once the server stops extending it", async () => {
    const route = planRoute();
    route.leaseCap = route.now + 400_000;
    await edit();
    await pass(route, 205_000);
    const holds = () => route.posts.filter((post) => post.action === "hold").length;
    expect(holds()).toBe(1);
    await pass(route, 15_000);
    expect(holds()).toBe(2);
    await pass(route, 100_000);
    expect(holds()).toBe(3);
    expect(clock()).toMatch(/^Timer held while you edit: 1:\d\d left to edit$/u);
    await pass(route, 30_000);
    expect(holds()).toBe(3);
  });

  it("keeps the countdown honest when the hold fails, and tries again", async () => {
    const route = planRoute();
    route.failNext = { action: "hold", status: 503 };
    await edit();
    expect(clock()).toBe("Research starts in 0:42");
    expect(card()).toHaveTextContent("The timer could not be held");
    await pass(route, 5_500);
    expect(clock()).toBe("Timer held while you edit");
    expect(card()).not.toHaveTextContent("could not be held");
  });

  it("gives the time back on Cancel and returns focus to Edit", async () => {
    const route = planRoute();
    await edit();
    fireEvent.change(screen.getByLabelText("Step 1"), { target: { value: "Changed" } });
    fireEvent.click(button("Cancel"));
    await settle();
    expect(route.posts.at(-1)).toEqual({ action: "cancel_hold", runId });
    expect(card()).toHaveAttribute("data-state", "window");
    expect(clock()).toBe("Research starts in 0:42");
    expect(button("Edit")).toHaveFocus();
    expect(card()).toHaveTextContent(words.steps[0]!);
  });

  it("edits, deletes and adds steps and saves them with the start button", async () => {
    const route = planRoute();
    await edit();
    fireEvent.change(screen.getByLabelText("How I understood the task"), { target: { value: "  You want a quiet kettle " } });
    fireEvent.change(screen.getByLabelText("Step 1"), { target: { value: "Read the reviews" } });
    fireEvent.click(button("Delete step 4"));
    fireEvent.click(button("Add step"));
    expect(screen.getByLabelText("Step 4")).toHaveFocus();
    fireEvent.change(screen.getByLabelText("Step 4"), { target: { value: "Ask owners" } });
    fireEvent.click(button("Add assumption"));
    fireEvent.click(startButton());
    await settle();
    expect(route.posts.at(-1)).toEqual({ action: "save", plan: { assumptions: words.assumptions, steps: ["Read the reviews", "Find the candidates", "Compare them", "Ask owners"],
      understood: "You want a quiet kettle" }, runId });
    expect(card()).toHaveAttribute("data-state", "answered");
    expect(card()).toHaveTextContent("Ask owners");
  });

  it("starts plainly when the edit changed nothing", async () => {
    const route = planRoute();
    await edit();
    fireEvent.click(startButton());
    await settle();
    expect(route.posts.at(-1)).toEqual({ action: "start", runId });
    expect(card()).toHaveAttribute("data-state", "answered");
  });

  it("keeps focus on a neighbour when a step is deleted, and never deletes the last one", async () => {
    planRoute();
    await edit();
    fireEvent.click(button("Delete step 2"));
    expect(button("Delete step 2")).toHaveFocus();
    fireEvent.click(button("Delete step 3"));
    expect(button("Delete step 2")).toHaveFocus();
    fireEvent.click(button("Delete step 2"));
    expect(button("Add step")).toHaveFocus();
    expect(button("Delete step 1")).toBeDisabled();
  });

  it("stops at the person's limit of steps", async () => {
    planRoute();
    await edit();
    for (let added = 0; added < 8; added += 1) fireEvent.click(button("Add step"));
    expect(screen.getByLabelText("Step 12")).toBeVisible();
    expect(within(card()).queryByRole("button", { name: "Add step" })).toBeNull();
  });

  it("refuses an empty plan before asking the server", async () => {
    const route = planRoute();
    await edit();
    fireEvent.change(screen.getByLabelText("How I understood the task"), { target: { value: "   " } });
    fireEvent.click(startButton());
    await settle();
    expect(within(card()).getByRole("alert")).toHaveTextContent("Write how the task was understood");
    expect(route.posts.filter((post) => post.action === "save")).toEqual([]);
  });

  it("shows saving on the button, with the fields locked, and rejects a second press", async () => {
    const route = planRoute();
    await edit();
    fireEvent.change(screen.getByLabelText("Step 1"), { target: { value: "Changed" } });
    const saved: { release?: () => void } = {};
    const fetchMock = vi.mocked(fetch);
    const answerSave = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementationOnce(async (url, init) => {
      await new Promise<void>((resolve) => { saved.release = resolve; });
      return answerSave(url as string, init);
    });
    fireEvent.click(startButton());
    await settle();
    expect(card()).toHaveAttribute("data-saving", "true");
    expect(startButton()).toHaveAttribute("aria-busy", "true");
    expect(screen.getByLabelText("Step 1")).toBeDisabled();
    fireEvent.click(startButton());
    saved.release?.();
    await settle();
    expect(route.posts.filter((post) => post.action === "save")).toHaveLength(1);
    expect(card()).toHaveAttribute("data-state", "answered");
  });

  it("keeps the text when a save fails, says so and lets the person try again", async () => {
    const route = planRoute();
    await edit();
    fireEvent.change(screen.getByLabelText("Step 1"), { target: { value: "Changed" } });
    route.failNext = { action: "save", status: 503 };
    fireEvent.click(startButton());
    await settle();
    expect(within(card()).getByRole("alert")).toHaveTextContent("Your changes were not saved and are still here.");
    expect(screen.getByLabelText("Step 1")).toHaveValue("Changed");
    expect(card()).toHaveAttribute("data-state", "editing");
    fireEvent.click(startButton());
    await settle();
    expect(card()).toHaveAttribute("data-state", "answered");
    expect(card()).toHaveTextContent("Changed");
  });

  it("says when the server refused the text, and keeps it", async () => {
    const route = planRoute();
    await edit();
    fireEvent.change(screen.getByLabelText("Step 1"), { target: { value: "Changed" } });
    route.failNext = { action: "save", status: 400 };
    fireEvent.click(startButton());
    await settle();
    expect(within(card()).getByRole("alert")).toHaveTextContent("The server refused this text.");
    expect(screen.getByLabelText("Step 1")).toHaveValue("Changed");
  });

  it("does not call a retried save that had gone through a loss", async () => {
    const route = planRoute();
    await edit();
    fireEvent.change(screen.getByLabelText("Step 1"), { target: { value: "Changed" } });
    route.closeOnPost = { changed: true, plan: { ...words, steps: ["Changed", ...words.steps.slice(1)] }, releasedBy: "saved_edit" };
    fireEvent.click(startButton());
    await settle();
    expect(card()).toHaveAttribute("data-state", "answered");
  });

  describe("when the window closed under the edit", () => {
    async function closedByTimer() {
      const route = planRoute();
      const { rerender } = render(<ResearchPlanCardV2 activity={activity(row("window"))} live />);
      await settle();
      fireEvent.click(button("Edit"));
      await settle();
      fireEvent.change(screen.getByLabelText("Step 1"), { target: { value: "My own step" } });
      route.closeOnPost = { changed: false, plan: words, releasedBy: "timer" };
      fireEvent.click(startButton());
      await settle();
      return { rerender, route };
    }

    it("keeps the text and says how it closed", async () => {
      await closedByTimer();
      expect(card()).toHaveAttribute("data-state", "closed");
      expect(card()).toHaveTextContent("The time ran out, so research started with the proposed plan.");
      expect(card()).toHaveTextContent("My own step");
      expect(card()).toHaveTextContent("Price matters most");
      expect(screen.queryByRole("textbox", { name: "Step 1" })).toBeNull();
    });

    it("outlives the row that held the window", async () => {
      const { rerender } = await closedByTimer();
      const { researchPlan: _released, ...stands } = row("window");
      rerender(<ResearchPlanCardV2 activity={activity(stands)} live />);
      expect(card()).toHaveTextContent("My own step");
      fireEvent.click(button("Dismiss"));
      expect(screen.queryByTestId("research-plan-card")).toBeNull();
    });

    it("notices by its own read when the row went first", async () => {
      const route = planRoute();
      const { rerender } = render(<ResearchPlanCardV2 activity={activity(row("window"))} live />);
      await settle();
      fireEvent.click(button("Edit"));
      await settle();
      fireEvent.change(screen.getByLabelText("Step 1"), { target: { value: "My own step" } });
      route.answer = { changed: false, plan: words, releasedBy: "chat_message" };
      route.heldUntil = null;
      const { researchPlan: _released, ...stands } = row("window");
      rerender(<ResearchPlanCardV2 activity={activity(stands)} live />);
      expect(screen.getByLabelText("Step 1")).toHaveValue("My own step");
      await pass(route, 5_500);
      expect(card()).toHaveAttribute("data-state", "closed");
      expect(card()).toHaveTextContent("A message in the chat closed the plan.");
    });

    it("says so when the run stopped under the edit", async () => {
      const route = planRoute();
      await openWindow();
      fireEvent.click(button("Edit"));
      await settle();
      fireEvent.change(screen.getByLabelText("Step 1"), { target: { value: "My own step" } });
      route.notFound = true;
      fireEvent.click(startButton());
      await settle();
      expect(card()).toHaveAttribute("data-state", "closed");
      expect(card()).toHaveTextContent("so research did not start");
      expect(card()).toHaveTextContent("My own step");
    });

    it("copies the text", async () => {
      await closedByTimer();
      const writeText = vi.fn(async () => undefined);
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
      fireEvent.click(button("Copy my text"));
      await settle();
      expect(writeText).toHaveBeenCalledOnce();
      expect(writeText.mock.calls[0]).toEqual([expect.stringContaining("1. My own step")]);
      expect(card()).toHaveTextContent("Copied.");
    });

    it("puts the text in the composer, after what is there", async () => {
      await closedByTimer();
      const key = composerSessionKey(chatId);
      useComposerSessionStore.getState().activateSession(key);
      useComposerSessionStore.getState().updateSession(key, { draft: "Earlier words" });
      fireEvent.click(button("Put in a message"));
      const { draft } = selectComposerSession(useComposerSessionStore.getState(), key);
      expect(draft.startsWith("Earlier words\n\nYou want the best kettle")).toBe(true);
      expect(draft).toContain("1. My own step");
      expect(card()).toHaveAttribute("data-state", "answered");
      useComposerSessionStore.getState().updateSession(key, { draft: "" });
    });
  });
});
