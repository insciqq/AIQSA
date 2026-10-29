import { expect, test, type Page, type Route } from "@playwright/test";
import type { SubagentThreadState } from "../../lib/contracts/subagents";
import type { SubagentThreadSummary, SubagentTurnView } from "../../lib/contracts/subagentViews";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { scrollMessage } from "./shell/thread";
import { CAPTURE_SIZES, captureState } from "./support/capture";
import { expectNoHorizontalOverflow, expectTouchSafe } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

/**
 * Sub-agents in the chat list and the chat (operator decision 2026-10-29),
 * on a disposable stand: the shell, its address and layout are real; the
 * sub-agent projections are a scripted owner-only server (`page.route`) whose
 * sub-agents run, wait, finish and stop as the test says, so the tree's
 * polling, Stop, Stop all and the wake-up turn are exercised against the
 * route contracts of `lib/contracts/subagentViews.ts`. The real routes, the
 * fake-provider `call_subagent` path and the wake-up run are covered by the
 * integration task's stand run.
 */

const chatId = "subagents-ui-chat";
const timestamp = "2026-10-30T10:00:00.000Z";
const longName = `long-${"x".repeat(38)}-name`;

type ThreadScript = { name: string; state: SubagentThreadState; updatedAt: string };

function threadSummary(id: string, script: ThreadScript): SubagentThreadSummary {
  const active = script.state === "running" || script.state === "waiting";
  return {
    createdAt: timestamp, endedAt: active ? null : script.updatedAt, id, mode: "background", name: script.name,
    outcome: script.state === "done" ? "done" : null, reason: script.state === "stopped" ? "user_stop" : null,
    state: script.state, turnCount: 1, type: null, updatedAt: script.updatedAt
  };
}

function turnView(id: string, script: ThreadScript): SubagentTurnView {
  const active = script.state === "running" || script.state === "waiting";
  return {
    brief: `Brief for ${script.name}: compare the three cheapest laptops and write the table to laptops.md.`,
    endedAt: active ? null : script.updatedAt, files: active ? [] : ["research/laptops.md"], id: `turn-${id}`, messages: [],
    mode: "background", model: { displayName: "Fake model", effort: null },
    outcome: script.state === "done" ? "done" : null, parentMessageId: "answer-1",
    reason: script.state === "stopped" ? "user_stop" : null,
    report: active ? null : `Report of ${script.name}: three laptops compared.`,
    startedAt: timestamp, state: script.state,
    toolActivity: { calls: [{ origin: "tool", round: 1, status: active ? "running" : "complete", toolName: "web_search" }] },
    workspaceActivity: null
  };
}

/** The owner-only sub-agent routes of one chat, with their sub-agents driven by the test. */
async function installSubagentRoutes(page: Page) {
  const threads = new Map<string, ThreadScript>([
    ["thread-researcher", { name: "researcher", state: "running", updatedAt: "2026-10-30T10:01:00.000Z" }],
    ["thread-browser", { name: "browser", state: "waiting", updatedAt: "2026-10-30T10:01:00.000Z" }],
    ["thread-long", { name: longName, state: "done", updatedAt: "2026-10-30T10:00:30.000Z" }]
  ]);
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

function chatDetail(withWakeUp: boolean) {
  const messages: Record<string, unknown>[] = [
    scrollMessage("question-1", "user", "Research the three cheapest laptops with sub-agents.", null),
    { ...scrollMessage("answer-1", "assistant", "I started two sub-agents; their results arrive on their own.", "question-1"),
      toolActivity: { calls: [callSubagent("thread-researcher", "researcher"), callSubagent("thread-browser", "browser")] } }
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

async function installChat(page: Page, state: { wakeUp: boolean }) {
  await installMatrixCatalogFixture(page, { chats: [chatDetail(false)], folders: [] });
  await page.route("**/api/chats/compact?*", (route) => route.fulfill({ json: {
    chats: [{ activeRun: false, assistant: null, folderId: null, id: chatId, title: "Laptop research", updatedAt: timestamp }],
    folders: [], nextCursor: null
  } }));
  // Registered last, so it answers before the catalog fixture's static detail.
  await page.route(`**/api/chats/${chatId}`, (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { chat: { ...chatDetail(state.wakeUp), contextStats: { approximateActiveBranchInputTokens: 0 },
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
    const status = page.getByTestId("subagent-chat-status");
    await expect(status).toContainText("1 sub-agent working · 1 waiting for you");
    await expect(page.getByRole("link", { name: "Open researcher" })).toBeVisible();

    await captureState(page, testInfo, "subagents-chat-running", {
      atEachSize: async () => expectNoHorizontalOverflow(page)
    });

    // The tree updates live: the running sub-agent finishes on its own.
    routes.set("thread-researcher", "done");
    await expect(list.getByRole("treeitem", { name: "researcher, Done" })).toBeVisible({ timeout: 10_000 });
    await expect(status).toContainText(/^1 sub-agent waiting for you/u);

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

    // Stop all while a sub-agent runs.
    routes.set("thread-researcher", "running");
    await expect(status).toBeVisible({ timeout: 10_000 });
    await status.getByRole("button", { name: "Stop all" }).click();
    await expect(status).toHaveCount(0);
    expect(routes.posts).toContain(`/api/chats/${chatId}/subagents/stop-all`);
    await expect(list.getByRole("treeitem", { name: "researcher, Stopped" })).toBeVisible();

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

    test(`the phone drawer opens a thread, Stop and Stop all are touch-safe (${viewport.label})`, async ({ page }, testInfo) => {
      await page.setViewportSize({ height: viewport.height, width: viewport.width });
      await installChat(page, { wakeUp: false });
      await installSubagentRoutes(page);
      await signInWithLocalToken(page, `/c/${chatId}`);
      const status = page.getByTestId("subagent-chat-status");
      await expect(status).toBeVisible();
      await expectTouchSafe(status.getByRole("button", { name: "Stop all" }));
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
        sizes: CAPTURE_SIZES.filter((size) => size.width === viewport.width && size.height === viewport.height)
      });
    });
  });
}
