import { expect, test, type Page, type Route } from "@playwright/test";
import type { SubagentThreadState } from "../../lib/contracts/subagents";
import type { SubagentCurrentStep, SubagentThreadSummary, SubagentTurnView } from "../../lib/contracts/subagentViews";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { scrollMessage } from "./shell/thread";
import { CAPTURE_SIZES, captureState } from "./support/capture";
import { createGatedRunStreamFixture } from "./support/gatedRunStream";
import { expectNoHorizontalOverflow, expectTouchSafe } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

/**
 * Sub-agents in the chat list and the chat (operator decisions 2026-10-29
 * and 2026-10-30: each state has one place), on a disposable stand: the shell, its address and layout are real; the
 * sub-agent projections are a scripted owner-only server (`page.route`) whose
 * sub-agents run, wait, finish and stop as the test says, so the tree's
 * polling, the answer's rows, the chip and its list, Stop, Stop all and the
 * wake-up turn are exercised against the
 * route contracts of `lib/contracts/subagentViews.ts`. The real routes, the
 * fake-provider `call_subagent` path and the wake-up run are covered by the
 * integration task's stand run.
 */

const chatId = "subagents-ui-chat";
const timestamp = "2026-10-30T10:00:00.000Z";
const longName = `long-${"x".repeat(38)}-name`;

type ThreadScript = {
  /** The answer that started its latest turn; the static chat's answer unless the script says otherwise. */
  answer?: string;
  mode?: "background" | "foreground";
  name: string;
  state: SubagentThreadState;
  step?: SubagentCurrentStep;
  updatedAt: string;
};

const fakeModel = { displayName: "GPT-6 Luna", effort: "high" };
const searching: SubagentCurrentStep = { origin: "web_search", serverName: "Web search", toolName: "web_search" };
const reading: SubagentCurrentStep = { fetchTarget: "shop.example/laptops/cheapest", origin: "web_fetch", toolName: "fetch_url" };
const script = (name: string, state: SubagentThreadState, overrides: Partial<ThreadScript> = {}): ThreadScript =>
  ({ name, state, updatedAt: "2026-10-30T10:01:00.000Z", ...overrides });
const longNames = Array.from({ length: 20 }, (_, index) => `long-${String(index).padStart(2, "0")}-${"x".repeat(35)}-name`);

function threadSummary(id: string, script: ThreadScript): SubagentThreadSummary {
  const active = script.state === "running" || script.state === "waiting";
  return {
    createdAt: timestamp, currentStep: active ? script.step ?? null : null, endedAt: active ? null : script.updatedAt, id,
    latestAnswerMessageId: script.answer ?? "answer-1", mode: script.mode ?? "background", model: fakeModel, name: script.name,
    outcome: script.state === "done" ? "done" : null, reason: script.state === "stopped" ? "user_stop" : null,
    state: script.state, turnCount: 1, type: null, updatedAt: script.updatedAt
  };
}

function turnView(id: string, script: ThreadScript): SubagentTurnView {
  const active = script.state === "running" || script.state === "waiting";
  return {
    brief: `Brief for ${script.name}: compare the three cheapest laptops and write the table to laptops.md.`,
    endedAt: active ? null : script.updatedAt, files: active ? [] : ["research/laptops.md"], id: `turn-${id}`, messages: [],
    mode: script.mode ?? "background", model: fakeModel,
    outcome: script.state === "done" ? "done" : null, parentMessageId: "answer-1",
    reason: script.state === "stopped" ? "user_stop" : null,
    report: active ? null : `Report of ${script.name}: three laptops compared.`,
    startedAt: timestamp, state: script.state,
    toolActivity: { calls: [{ origin: "tool", round: 1, status: active ? "running" : "complete", toolName: "web_search" }] },
    workspaceActivity: null
  };
}

/** The owner-only sub-agent routes of one chat, with their sub-agents driven by the test. */
async function installSubagentRoutes(page: Page, initial: readonly (readonly [string, ThreadScript])[] = [
  ["thread-researcher", script("researcher", "running", { step: searching })],
  ["thread-browser", script("browser", "waiting")],
  ["thread-long", script(longName, "done", { answer: "answer-earlier", updatedAt: "2026-10-30T10:00:30.000Z" })]
]) {
  const threads = new Map<string, ThreadScript>(initial);
  const posts: string[] = [];
  let clock = Date.parse("2026-10-30T10:02:00.000Z");
  const tick = () => new Date(clock += 1_000).toISOString();
  const chatThreads = () => {
    const list = [...threads].map(([id, script]) => threadSummary(id, script));
    return { chatId, running: list.filter((thread) => thread.endedAt === null).length, threads: list, truncated: false };
  };
  const notFound = (route: Route) => route.fulfill({ json: { error: "subagent_not_found" }, status: 404 });
  await page.route(/\/api\/(?:subagents(?:\?|$)|chats\/[^/]+\/subagents)/u, async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/api/subagents") {
      const ids = url.searchParams.getAll("chatId");
      return route.fulfill({ json: { chats: ids.includes(chatId) ? [chatThreads()] : [] } });
    }
    const [, , , routeChat, , threadId, action] = url.pathname.split("/");
    if (routeChat !== chatId) return notFound(route);
    if (method === "POST") posts.push(url.pathname);
    if (threadId === "stop-all" && method === "POST") {
      let stopped = 0;
      for (const script of threads.values()) {
        if (script.state !== "running" && script.state !== "waiting") continue;
        Object.assign(script, { state: "stopped", updatedAt: tick() });
        stopped += 1;
      }
      return route.fulfill({ json: { stopped } });
    }
    if (!threadId) return route.fulfill({ json: chatThreads() });
    const script = threads.get(threadId);
    if (!script) return notFound(route);
    if (action === "stop" && method === "POST") {
      if (script.state === "running" || script.state === "waiting") Object.assign(script, { state: "stopped", updatedAt: tick() });
      return route.fulfill({ json: { thread: threadSummary(threadId, script) } });
    }
    return route.fulfill({ json: { chatId, thread: threadSummary(threadId, script), truncated: false, turns: [turnView(threadId, script)] } });
  });
  return {
    posts,
    set(id: string, state: SubagentThreadState) {
      const script = threads.get(id);
      if (script) Object.assign(script, { state, updatedAt: tick() });
    }
  };
}

const callSubagent = (threadId: string, name: string) => ({
  origin: "tool", round: 1, status: "complete", subagent: { mode: "background", name, threadId, turnId: `turn-${threadId}` },
  toolName: "call_subagent"
});

function chatDetail(withWakeUp: boolean, calls: readonly unknown[] = [callSubagent("thread-researcher", "researcher"), callSubagent("thread-browser", "browser")]) {
  const messages: Record<string, unknown>[] = [
    scrollMessage("question-1", "user", "Research the three cheapest laptops with sub-agents.", null),
    { ...scrollMessage("answer-1", "assistant", "I started two sub-agents; their results arrive on their own.", "question-1"),
      toolActivity: { calls } }
  ];
  if (withWakeUp) {
    messages.push(
      { ...scrollMessage("wake-1", "user", "Sub-agent results.", "answer-1"), subagentCallback: { names: ["researcher", "browser"] },
        systemTurnKind: "subagent_callback" },
      scrollMessage("answer-2", "assistant", "Both sub-agents reported back. Here is the comparison.", "wake-1")
    );
  }
  return {
    activeLeafMessageId: String(messages.at(-1)!.id), createdAt: timestamp, defaultModelId: "gpt-5.5", defaultProvider: "openai",
    folderId: null, id: chatId, messageCount: messages.length, messages, pinned: false, title: "Laptop research", updatedAt: timestamp
  };
}

async function installChat(page: Page, state: { calls?: readonly unknown[]; wakeUp: boolean }) {
  await installMatrixCatalogFixture(page, { chats: [chatDetail(false, state.calls)], folders: [] });
  await page.route("**/api/chats/compact?*", (route) => route.fulfill({ json: {
    chats: [{ activeRun: false, assistant: null, folderId: null, id: chatId, title: "Laptop research", updatedAt: timestamp }],
    folders: [], nextCursor: null
  } }));
  // Registered last, so it answers before the catalog fixture's static detail.
  await page.route(`**/api/chats/${chatId}`, (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { chat: { ...chatDetail(state.wakeUp, state.calls), contextStats: { approximateActiveBranchInputTokens: 0 },
      pageInfo: { activeLeafMessageId: state.wakeUp ? "answer-2" : "answer-1", beforeCursor: null, hasOlder: false,
        snapshotUpdatedAt: timestamp }, usageStats: null } } })
    : route.continue());
}

async function navigation(page: Page) {
  const list = page.getByRole("complementary", { name: "Chat navigation" });
  if (!(await list.isVisible())) await page.getByRole("button", { name: "Open sidebar" }).click();
  await expect(list).toBeVisible();
  return list;
}

const answerRows = (page: Page) => page.locator(".v2-subagent-answer-row");

/** A chat whose one answer is running in the gated stream, so its foreground sub-agents are really waited for. */
async function startLiveAnswer(page: Page, threads: readonly (readonly [string, ThreadScript])[]) {
  await installMatrixCatalogFixture(page, { chats: [{ activeLeafMessageId: null, createdAt: timestamp, defaultModelId: "gpt-5.5",
    defaultProvider: "openai", folderId: null, id: chatId, messageCount: 0, messages: [], pinned: false, title: "Laptop research", updatedAt: timestamp }], folders: [] });
  await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));
  await page.route("**/api/model-runs/subagents-ui-run", (route) => route.fulfill({ json: { version: 1, run: { id: "subagents-ui-run", status: "streaming" } } }));
  const routes = await installSubagentRoutes(page, threads);
  const stream = createGatedRunStreamFixture({ abortMessage: "Synthetic stream stopped", key: "subagents-ui", notReadyError: "subagents_ui_stream_not_ready" });
  await stream.install(page, chatId);
  await signInWithLocalToken(page, `/c/${chatId}`);
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("Compare the shops with sub-agents.");
  await composer.press("Enter");
  await stream.waitForRequestCount(page, 1);
  await stream.emit(page, "run_start", { modelId: "gpt-5.5", provider: "openai", runId: "subagents-ui-run", status: "streaming" });
  await stream.emit(page, "message_start", { assistantMessageId: "subagents-ui-answer", userMessageId: "subagents-ui-question" });
  await stream.emit(page, "artifact", { artifactType: "tool_call", payload: { name: "call_subagent", ordinal: 0, origin: "tool", round: 1,
    serverName: threads[0]![1].name, status: "requested" } });
  return routes;
}

const foreground = (name: string, state: SubagentThreadState, step?: SubagentCurrentStep) =>
  [`thread-${name}`, script(name, state, { answer: "subagents-ui-answer", mode: "foreground", ...(step ? { step } : {}) })] as const;
const background = (name: string, state: SubagentThreadState, step?: SubagentCurrentStep) =>
  [`thread-${name}`, script(name, state, step ? { step } : {})] as const;

test.describe("each sub-agent state has one place · all sizes and themes", () => {
  // Every state is captured at five sizes in both themes.
  test.setTimeout(240_000);

  test("foreground rows in the answer: wholly clickable, the process line neutral, no chip", async ({ page }, testInfo) => {
    await page.setViewportSize({ height: 900, width: 1440 });
    const routes = await startLiveAnswer(page, [foreground("shop-amazon", "running", searching), foreground("shop-ebay", "running", reading)]);
    await expect(answerRows(page)).toHaveCount(2, { timeout: 10_000 });
    await expect(page.getByText("Waiting for sub-agents…").first()).toBeVisible();
    await expect(page.getByTestId("subagent-chat-chip")).toHaveCount(0);
    await expect(answerRows(page).first()).toContainText("Searching the web…");
    await expect(answerRows(page).first()).toContainText("GPT-6 Luna · high");
    routes.set("thread-shop-ebay", "done");
    await expect(answerRows(page).nth(1)).toContainText("Done", { timeout: 10_000 });
    await expect(answerRows(page).nth(1)).toContainText("GPT-6 Luna · high");
    await captureState(page, testInfo, "subagents-foreground-rows", { atEachSize: async () => expectNoHorizontalOverflow(page) });
    await answerRows(page).first().click();
    await expect(page.getByTestId("subagent-thread-view").getByRole("heading", { name: "shop-amazon" })).toBeVisible();
    await expect(page.getByTestId("subagent-thread-view").getByRole("button", { name: "Stop" })).toBeVisible();
  });

  test("more than three collapse into one summary row that unfolds", async ({ page }, testInfo) => {
    await page.setViewportSize({ height: 900, width: 1440 });
    const names = ["shop-a", "shop-b", "shop-c", "shop-d", "shop-e"];
    const routes = await startLiveAnswer(page, names.map((name) => foreground(name, "running", searching)));
    const summary = page.getByRole("button", { name: /^5 sub-agents/u });
    await expect(summary).toBeVisible({ timeout: 10_000 });
    for (const name of names.slice(0, 3)) routes.set(`thread-${name}`, "done");
    await expect(summary).toHaveAccessibleName("5 sub-agents · 3 done, 2 running", { timeout: 10_000 });
    await expect(page.getByRole("link", { name: /^Open shop-/u })).toHaveCount(0);
    await captureState(page, testInfo, "subagents-summary-collapsed", { atEachSize: async () => expectNoHorizontalOverflow(page) });
    await summary.click();
    await expect(page.getByRole("link", { name: /^Open shop-/u })).toHaveCount(5);
    await captureState(page, testInfo, "subagents-summary-unfolded", { atEachSize: async () => expectNoHorizontalOverflow(page) });
  });

  test("a single background sub-agent: a chip that links to its thread and shows its step", async ({ page }, testInfo) => {
    await page.setViewportSize({ height: 900, width: 1440 });
    await installChat(page, { calls: [callSubagent("thread-solo", "solo")], wakeUp: false });
    await installSubagentRoutes(page, [background("solo", "running", reading)]);
    await signInWithLocalToken(page, `/c/${chatId}`);
    const chip = page.getByTestId("subagent-chat-chip").getByRole("link", { name: /^Open solo, Reading shop\.example/u });
    await expect(chip).toBeVisible();
    await expect(page.getByText("Stop all")).toHaveCount(0);
    await expect(answerRows(page)).toHaveCount(0);
    await captureState(page, testInfo, "subagents-chip-single", { atEachSize: async () => expectNoHorizontalOverflow(page) });
    await chip.click();
    await expect(page.getByTestId("subagent-thread-view").getByRole("heading", { name: "solo" })).toBeVisible();
  });

  test("a single background sub-agent waiting for the user reads as such", async ({ page }, testInfo) => {
    await page.setViewportSize({ height: 900, width: 1440 });
    await installChat(page, { calls: [callSubagent("thread-signer", "signer")], wakeUp: false });
    await installSubagentRoutes(page, [background("signer", "waiting")]);
    await signInWithLocalToken(page, `/c/${chatId}`);
    await expect(page.getByTestId("subagent-chat-chip").getByRole("link", { name: "Open signer, Waiting for you, GPT-6 Luna · high" }))
      .toHaveAttribute("data-tone", "warn");
    await captureState(page, testInfo, "subagents-chip-waiting", { atEachSize: async () => expectNoHorizontalOverflow(page) });
  });

  test("several background sub-agents: a chip with a list, a stop per row and Stop all", async ({ page }, testInfo) => {
    await page.setViewportSize({ height: 900, width: 1440 });
    await installChat(page, { calls: [callSubagent("thread-alpha", "alpha")], wakeUp: false });
    const routes = await installSubagentRoutes(page, [background("alpha", "running", searching), background("beta", "running", reading), background("gamma", "waiting")]);
    await signInWithLocalToken(page, `/c/${chatId}`);
    const chip = page.getByTestId("subagent-chat-chip");
    await chip.getByRole("button", { name: "2 sub-agents working · 1 waiting for you" }).click();
    const stopAll = page.getByRole("menuitem", { name: "Stop all" });
    await expect(stopAll).toBeVisible();
    await captureState(page, testInfo, "subagents-chip-several-open", {
      atEachSize: async () => {
        await expect(stopAll).toBeVisible();
        await expectNoHorizontalOverflow(page);
      }
    });
    await page.getByRole("menuitem", { name: "Stop beta" }).click();
    await expect(page.getByRole("menuitem", { name: "Stop beta" })).toHaveCount(0);
    expect(routes.posts).toContain(`/api/chats/${chatId}/subagents/thread-beta/stop`);
    await page.getByRole("menuitem", { name: /^Open gamma, Waiting for you/u }).click();
    await expect(page.getByTestId("subagent-thread-view").getByRole("heading", { name: "gamma" })).toBeVisible();
  });

  test("20 sub-agents with long names hold in the list and in the answer", async ({ page }, testInfo) => {
    await page.setViewportSize({ height: 900, width: 1440 });
    await installChat(page, { calls: [callSubagent("thread-0", longNames[0]!)], wakeUp: false });
    await installSubagentRoutes(page, longNames.map((name, index) => background(name, index === 3 ? "waiting" : "running", reading)));
    await signInWithLocalToken(page, `/c/${chatId}`);
    await page.getByTestId("subagent-chat-chip").getByRole("button", { name: "19 sub-agents working · 1 waiting for you" }).click();
    await expect(page.getByRole("menuitem", { name: "Stop all" })).toBeAttached();
    await captureState(page, testInfo, "subagents-twenty-list", { atEachSize: async () => expectNoHorizontalOverflow(page) });
  });

  test("20 foreground sub-agents with long names unfold in the answer", async ({ page }, testInfo) => {
    await page.setViewportSize({ height: 900, width: 1440 });
    await startLiveAnswer(page, longNames.map((name) => foreground(name, "running", reading)));
    await page.getByRole("button", { name: /^20 sub-agents/u }).click({ timeout: 10_000 });
    await expect(answerRows(page)).toHaveCount(21);
    await captureState(page, testInfo, "subagents-twenty-rows", {
      anchor: answerRows(page).first(),
      atEachSize: async () => expectNoHorizontalOverflow(page)
    });
  });
});

test.describe("sub-agents · desktop and tablet", () => {
  test("the tree, the thread view with Stop, Stop all and the wake-up turn", async ({ page }, testInfo) => {
    // Three states captured at five sizes in both themes, plus live polling waits.
    test.setTimeout(180_000);
    await page.setViewportSize({ height: 900, width: 1440 });
    const chatState = { wakeUp: false };
    await installChat(page, chatState);
    const routes = await installSubagentRoutes(page);
    await signInWithLocalToken(page, `/c/${chatId}`);

    const list = await navigation(page);
    const chatRow = list.getByRole("treeitem", { name: "Laptop research", exact: true });
    await expect(chatRow).toHaveAttribute("aria-expanded", "true");
    await expect(list.getByRole("treeitem", { name: "researcher, Running" })).toBeVisible();
    await expect(list.getByRole("treeitem", { name: "browser, Waiting for you" })).toBeVisible();
    // Both are active background sub-agents: their one place is the chip, not a row in the answer.
    const chip = page.getByTestId("subagent-chat-chip");
    const several = chip.getByRole("button", { name: "1 sub-agent working · 1 waiting for you" });
    await expect(several).toBeVisible();
    await expect(answerRows(page)).toHaveCount(0);

    await captureState(page, testInfo, "subagents-chat-running", {
      atEachSize: async () => expectNoHorizontalOverflow(page)
    });

    // The tree updates live: the running sub-agent finishes on its own.
    routes.set("thread-researcher", "done");
    await expect(list.getByRole("treeitem", { name: "researcher, Done" })).toBeVisible({ timeout: 10_000 });
    // One left: the chip links straight to it and reads as waiting; the one that ended has its row in its answer.
    await expect(chip.getByRole("link", { name: /^Open browser, Waiting for you/u })).toHaveAttribute("data-tone", "warn");
    await expect(answerRows(page).filter({ hasText: "researcher" })).toContainText("Done");

    // A row opens its read-only thread; Stop stops it.
    await list.getByRole("treeitem", { name: "browser, Waiting for you" }).click();
    const view = page.getByTestId("subagent-thread-view");
    await expect(view.getByRole("heading", { name: "browser" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/c/${chatId}\\?agent=thread-browser$`, "u"));
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
    await expect(view.getByText(/Brief for browser/u)).toBeVisible();
    await captureState(page, testInfo, "subagents-thread-waiting", {
      atEachSize: async () => expectNoHorizontalOverflow(page)
    });
    await view.getByRole("button", { name: "Stop" }).click();
    await expect(view.getByRole("button", { name: "Stop" })).toHaveCount(0);
    expect(routes.posts).toContain(`/api/chats/${chatId}/subagents/thread-browser/stop`);
    await expect(list.getByRole("treeitem", { name: "browser, Stopped" })).toBeVisible();

    // Back to the chat; back and forward follow the thread view.
    await view.getByRole("link", { name: "Back to chat" }).click();
    await expect(page.getByTestId("subagent-thread-view")).toHaveCount(0);
    await page.goBack();
    await expect(page.getByTestId("subagent-thread-view")).toBeVisible();
    await page.goForward();
    await expect(page.getByTestId("subagent-thread-view")).toHaveCount(0);

    // Stop all while several run. Nothing runs now, so nothing polls (by
    // design): a new sub-agent starts only with a main-agent turn, whose
    // stream end refreshes the chat, so the step reopens the chat instead.
    routes.set("thread-researcher", "running");
    routes.set("thread-browser", "running");
    await page.reload();
    const listRunning = await navigation(page);
    await chip.getByRole("button", { name: "2 sub-agents working" }).click({ timeout: 10_000 });
    await page.getByRole("menuitem", { name: "Stop all" }).click();
    await expect(chip).toHaveCount(0);
    expect(routes.posts).toContain(`/api/chats/${chatId}/subagents/stop-all`);
    // Nothing runs any more: the rows close by themselves and the disclosure counts no active one.
    await expect(listRunning.getByRole("treeitem", { name: "Laptop research", exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(listRunning.getByRole("button", { name: "Show sub-agents of Laptop research: 3 sub-agents", exact: true }))
      .toBeVisible();

    // The wake-up answer: no user bubble, one line naming the sub-agents.
    chatState.wakeUp = true;
    await page.reload();
    const wakeUp = page.locator("[data-system-turn='subagent_callback']");
    await expect(wakeUp).toHaveText("Sub-agent results: researcher, browser");
    await expect(page.getByText("Sub-agent results.", { exact: true })).toHaveCount(0);
    // Idle: the chat's rows closed; the disclosure opens them, and the long name stays on one line.
    const listAfter = await navigation(page);
    await expect(listAfter.getByRole("treeitem", { name: "Laptop research", exact: true })).toHaveAttribute("aria-expanded", "false");
    await listAfter.getByRole("button", { name: /Show sub-agents of Laptop research/u }).click();
    const longRow = listAfter.getByRole("treeitem", { name: `${longName}, Done` });
    await expect(longRow).toBeVisible();
    expect((await longRow.boundingBox())!.height).toBeLessThanOrEqual(36);
    await captureState(page, testInfo, "subagents-wake-up", {
      anchor: wakeUp,
      atEachSize: async () => expectNoHorizontalOverflow(page)
    });
  });
});

for (const viewport of [
  { height: 844, label: "phone-portrait", width: 390 },
  { height: 390, label: "phone-landscape", width: 844 }
] as const) {
  test.describe(`sub-agents · ${viewport.label}`, () => {
    test.use({ hasTouch: true, isMobile: true });

    const sizes = CAPTURE_SIZES.filter((size) => size.width === viewport.width && size.height === viewport.height);

    test(`the chip and its bottom sheet are touch-safe and open a thread (${viewport.label})`, async ({ page }, testInfo) => {
      await page.setViewportSize({ height: viewport.height, width: viewport.width });
      await installChat(page, { calls: [callSubagent("thread-alpha", "alpha")], wakeUp: false });
      await installSubagentRoutes(page, longNames.map((name) => background(name, "running", reading)));
      await signInWithLocalToken(page, `/c/${chatId}`);
      const chip = page.getByTestId("subagent-chat-chip").getByRole("button", { name: "20 sub-agents working" });
      await expectTouchSafe(chip);
      await expectNoHorizontalOverflow(page);
      await chip.tap();
      const sheet = page.getByRole("dialog", { name: "Background sub-agents sheet" });
      await expect(sheet).toBeVisible();
      await expectTouchSafe(sheet.getByRole("menuitem", { name: `Stop ${longNames[0]}` }));
      await expectTouchSafe(sheet.getByRole("menuitem", { name: new RegExp(`^Open ${longNames[0]}`, "u") }));
      await expectNoHorizontalOverflow(page);
      await captureState(page, testInfo, `subagents-sheet-${viewport.label}`, { atEachSize: async () => expectNoHorizontalOverflow(page), sizes });
      await sheet.getByRole("menuitem", { name: new RegExp(`^Open ${longNames[0]}`, "u") }).tap();
      await expect(page.getByTestId("subagent-thread-view").getByRole("heading", { name: longNames[0]! })).toBeVisible();
    });

    test(`a foreground row is touch-safe and opens its thread (${viewport.label})`, async ({ page }, testInfo) => {
      await page.setViewportSize({ height: viewport.height, width: viewport.width });
      await startLiveAnswer(page, [foreground(longName, "running", reading)]);
      await expect(answerRows(page)).toHaveCount(1, { timeout: 10_000 });
      await expectTouchSafe(answerRows(page).first());
      await expectNoHorizontalOverflow(page);
      await captureState(page, testInfo, `subagents-foreground-${viewport.label}`, { atEachSize: async () => {
        await expectNoHorizontalOverflow(page);
        // A long name ellipsizes: the row, chevron included, stays on the screen.
        const box = await answerRows(page).first().locator(".v2-subagent-chevron").boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      }, sizes });
      await answerRows(page).first().tap();
      await expect(page.getByTestId("subagent-thread-view").getByRole("heading", { name: longName })).toBeVisible();
    });

    test(`the phone drawer opens a thread and Stop is touch-safe (${viewport.label})`, async ({ page }, testInfo) => {
      await page.setViewportSize({ height: viewport.height, width: viewport.width });
      await installChat(page, { wakeUp: false });
      await installSubagentRoutes(page);
      await signInWithLocalToken(page, `/c/${chatId}`);
      await expect(page.getByTestId("subagent-chat-chip")).toBeVisible();
      await expectNoHorizontalOverflow(page);

      const list = await navigation(page);
      const row = list.getByRole("treeitem", { name: "researcher, Running" });
      await expectTouchSafe(row);
      await expectTouchSafe(list.getByRole("button", { name: /Hide sub-agents of Laptop research/u }));
      await page.screenshot({ path: testInfo.outputPath(`subagents-drawer-${viewport.label}.png`) });
      await row.tap();
      await expect(list).toBeHidden();
      const view = page.getByTestId("subagent-thread-view");
      await expect(view.getByRole("heading", { name: "researcher" })).toBeVisible();
      await expectTouchSafe(view.getByRole("link", { name: "Back to chat" }));
      await expectTouchSafe(view.getByRole("button", { name: "Stop" }));
      await expectNoHorizontalOverflow(page);
      await captureState(page, testInfo, `subagents-thread-${viewport.label}`, {
        atEachSize: async () => expectNoHorizontalOverflow(page),
        sizes
      });
    });
  });
}
