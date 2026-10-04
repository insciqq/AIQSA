import { expect, test, type Page } from "@playwright/test";
import type { ChatDetailWire, ChatMessageWire } from "../../lib/contracts/chats";
import type {
  ScheduledTask,
  ScheduledTaskCheckOutcome,
  ScheduledTaskRun,
  ScheduledTaskWeekday
} from "../../lib/contracts/scheduledTasks";
import { matrixCatalog } from "./shell/catalog";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { runAccountMenuAction } from "./shell/page";
import { captureState, type CaptureStep } from "./support/capture";
import { expectNoHorizontalOverflow, expectTouchSafe, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

// Mocked owner API; the browser clock and zone are fixed so every date is stable.
const now = new Date("2026-10-04T10:00:00.000Z");
const model = matrixCatalog.models[0]!;
const chatId = "scheduled-brief-chat";
const watchChatId = "scheduled-watch-chat";
const touchSizes = [{ width: 390, height: 844 }, { width: 844, height: 390 }];
const workdays: ScheduledTaskWeekday[] = ["mon", "tue", "wed", "thu", "fri"];

test.use({ timezoneId: "Europe/London" });
test.setTimeout(240_000);

function task(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: "task", title: "Task", prompt: "Synthetic scheduled instructions.",
    schedule: { kind: "daily", time: "09:00" }, timeZone: "Europe/London",
    modelId: model.modelId, provider: model.provider, searchEnabled: false, emailNotify: false, toolsEnabled: false,
    workspaceEnabled: false, chatMode: "same", kind: "standard", status: "active", pauseReason: null, completionReason: null,
    nextRunAt: "2026-10-05T08:00:00.000Z", lastRun: null, running: false,
    chatId: null, unseenResult: false, revision: 1,
    createdAt: "2026-09-20T08:00:00.000Z", updatedAt: "2026-09-20T08:00:00.000Z",
    ...overrides
  };
}

const listFixture: ScheduledTask[] = [
  task({
    id: "brief", title: "Weekday news brief", chatId, unseenResult: true,
    schedule: { kind: "weekly", time: "09:00", days: workdays },
    lastRun: { scheduledFor: "2026-10-02T08:00:00.000Z", state: "completed", reasonCode: null, finishedAt: "2026-10-02T08:01:10.000Z" }
  }),
  task({ id: "market", title: "Market open notes", running: true, chatMode: "new", chatId: "scheduled-market-chat",
    schedule: { kind: "daily", time: "07:30" } }),
  task({
    id: "inbox", title: "Inbox check", chatId: "scheduled-inbox-chat",
    schedule: { kind: "hourly", everyHours: 2, time: "09:00", until: "18:00", days: workdays },
    lastRun: { scheduledFor: "2026-10-02T15:00:00.000Z", state: "skipped", reasonCode: "previous_running", finishedAt: "2026-10-02T15:00:01.000Z" }
  }),
  task({
    id: "model", title: "Model check-in", status: "paused", nextRunAt: null, pauseReason: "model_unavailable",
    lastRun: { scheduledFor: "2026-10-03T07:00:00.000Z", state: "failed", reasonCode: "model_unavailable", finishedAt: "2026-10-03T07:00:02.000Z" }
  }),
  task({
    id: "friday", title: "Weekly summary for the New York team with a deliberately long title that wraps", status: "paused",
    nextRunAt: null, timeZone: "America/New_York", schedule: { kind: "weekly", time: "17:00", days: ["fri"] }
  }),
  task({ id: "launch", title: "Launch reminder", status: "completed", nextRunAt: null,
    schedule: { kind: "once", date: "2026-10-01", time: "10:00" },
    lastRun: { scheduledFor: "2026-10-01T09:00:00.000Z", state: "completed", reasonCode: null, finishedAt: "2026-10-01T09:00:40.000Z" } }),
  task({ id: "monthly", title: "Monthly bills", schedule: { kind: "monthly", time: "10:00", dayOfMonth: 31 }, nextRunAt: "2026-10-31T10:00:00.000Z",
    lastRun: { scheduledFor: "2026-09-30T09:00:00.000Z", state: "skipped", reasonCode: "missed", finishedAt: "2026-09-30T21:00:00.000Z" } })
];

// Monitoring: one task watching in its chat, one that reached its goal; both use tools.
const monitoringFixture: ScheduledTask[] = [
  task({
    id: "watch", title: "Release watch", kind: "monitoring", chatId: watchChatId, toolsEnabled: true,
    schedule: { kind: "hourly", everyHours: 4, time: "00:00", until: null, days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
    nextRunAt: "2026-10-04T12:00:00.000Z",
    lastRun: { scheduledFor: "2026-10-04T08:00:00.000Z", state: "completed", reasonCode: "update", finishedAt: "2026-10-04T08:01:30.000Z" }
  }),
  task({
    id: "tickets", title: "Concert ticket watch", kind: "monitoring", chatId: "scheduled-tickets-chat", toolsEnabled: true,
    workspaceEnabled: true, status: "completed", nextRunAt: null, completionReason: "goal_reached",
    lastRun: { scheduledFor: "2026-10-03T08:00:00.000Z", state: "completed", reasonCode: "goal_reached", finishedAt: "2026-10-03T08:02:00.000Z" }
  })
];

function checkRun(id: string, scheduledFor: string, reasonCode: ScheduledTaskCheckOutcome,
  extra: Partial<ScheduledTaskRun> = {}): ScheduledTaskRun {
  const startedAt = new Date(Date.parse(scheduledFor) + 2_000).toISOString();
  const finishedAt = new Date(Date.parse(scheduledFor) + 90_000).toISOString();
  return { id, scheduledFor, trigger: "schedule", state: "completed", reasonCode, startedAt, finishedAt,
    chatId: "scheduled-tickets-chat", unseen: false, unavailableSources: [], ...extra };
}

const runsFixture: Readonly<Record<string, readonly ScheduledTaskRun[]>> = {
  tickets: [
    checkRun("tickets-run-5", "2026-10-03T08:00:00.000Z", "goal_reached"),
    checkRun("tickets-run-4", "2026-10-02T08:00:00.000Z", "could_not_check", {
      unavailableSources: [{ name: "Ticket marketplace", reason: "mcp_reauthorization_required" }]
    }),
    checkRun("tickets-run-3", "2026-10-01T08:00:00.000Z", "no_update"),
    checkRun("tickets-run-2", "2026-09-30T08:00:00.000Z", "no_update"),
    checkRun("tickets-run-1", "2026-09-29T08:00:00.000Z", "baseline")
  ],
  brief: [
    { id: "brief-run-3", scheduledFor: "2026-10-02T08:00:00.000Z", trigger: "schedule", state: "completed", reasonCode: null,
      startedAt: "2026-10-02T08:00:03.000Z", finishedAt: "2026-10-02T08:01:10.000Z", chatId, unseen: true, unavailableSources: [] },
    { id: "brief-run-2", scheduledFor: "2026-10-01T13:12:00.000Z", trigger: "manual", state: "failed", reasonCode: "chat_busy",
      startedAt: "2026-10-01T13:12:00.000Z", finishedAt: "2026-10-01T13:42:00.000Z", chatId, unseen: false, unavailableSources: [] },
    { id: "brief-run-1", scheduledFor: "2026-10-01T08:00:00.000Z", trigger: "schedule", state: "skipped", reasonCode: "missed",
      startedAt: null, finishedAt: "2026-10-01T20:00:00.000Z", chatId: null, unseen: false, unavailableSources: [] }
  ],
  inbox: [
    { id: "inbox-run-2", scheduledFor: "2026-10-02T15:00:00.000Z", trigger: "schedule", state: "skipped", reasonCode: "previous_running",
      startedAt: null, finishedAt: "2026-10-02T15:00:01.000Z", chatId: null, unseen: false, unavailableSources: [] },
    { id: "inbox-run-1", scheduledFor: "2026-10-02T13:00:00.000Z", trigger: "schedule", state: "completed", reasonCode: null,
      startedAt: "2026-10-02T13:00:02.000Z", finishedAt: "2026-10-02T15:10:00.000Z", chatId: "scheduled-inbox-chat", unseen: false, unavailableSources: [] }
  ]
};

type Write = Readonly<{ method: string; path: string; body: unknown }>;

async function installScheduledApi(page: Page, initial: readonly ScheduledTask[]) {
  const state = {
    runs: structuredClone(runsFixture) as Record<string, ScheduledTaskRun[]>,
    tasks: initial.map((entry) => structuredClone(entry)),
    writes: [] as Write[]
  };
  await page.route(/\/api\/me\/scheduled-tasks(\/[^?]*)?(\?.*)?$/u, async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname.replace(/^\/api\/me\/scheduled-tasks/u, "");
    if (method !== "GET") state.writes.push({ method, path, body: request.postData() ? request.postDataJSON() : null });
    if (!path && method === "GET") {
      return route.fulfill({ json: { tasks: state.tasks, limits: { maxActive: 10, maxActiveHourly: 3, maxTotal: 50 },
        emailAvailable: true } });
    }
    if (!path && method === "POST") {
      const created = task({ ...request.postDataJSON() as Partial<ScheduledTask>, id: "created", nextRunAt: "2026-10-05T16:00:00.000Z" });
      state.tasks.unshift(created);
      return route.fulfill({ status: 201, json: { task: created } });
    }
    const [, id, action] = path.split("/");
    const index = state.tasks.findIndex((entry) => entry.id === id);
    const current = state.tasks[index];
    if (!current) return route.fulfill({ status: 404, json: { error: "scheduled_task_not_found" } });
    if (action === "seen") {
      // Only the named runs become seen; the task's dot follows whatever stays unread.
      const { runIds } = request.postDataJSON() as { runIds: string[] };
      const runs = (state.runs[current.id] ?? []).map((run) => runIds.includes(run.id) ? { ...run, unseen: false } : run);
      state.runs[current.id] = runs;
      state.tasks[index] = { ...current, unseenResult: runs.some((run) => run.unseen) };
      return route.fulfill({ status: 204, body: "" });
    }
    if (action === "run") {
      if (current.running) return route.fulfill({ status: 409, json: { error: "scheduled_task_running" } });
      state.tasks[index] = { ...current, running: true };
      return route.fulfill({ json: { task: state.tasks[index] } });
    }
    if (method === "GET") return route.fulfill({ json: { task: current, recentRuns: state.runs[current.id] ?? [] } });
    if (method === "DELETE") {
      state.tasks.splice(index, 1);
      return route.fulfill({ status: 204, body: "" });
    }
    const { expectedRevision: _revision, status, ...patch } = request.postDataJSON() as Record<string, unknown>;
    const next: ScheduledTask = { ...current, ...patch as Partial<ScheduledTask>, revision: current.revision + 1,
      ...(status === "paused" ? { status: "paused", nextRunAt: null, pauseReason: null } : {}),
      ...(status === "active" ? { status: "active", nextRunAt: "2026-10-05T08:00:00.000Z", pauseReason: null } : {}) };
    state.tasks[index] = next;
    return route.fulfill({ json: { task: next } });
  });
  return state;
}

function message(id: string, role: "assistant" | "user", content: string, parentMessageId: string | null,
  extra: Partial<ChatMessageWire> = {}): ChatMessageWire {
  return { id, role, content, parentMessageId, createdAt: "2026-10-02T08:00:00.000Z", status: "complete",
    citationMessageId: null, errorMessage: null, modelId: role === "assistant" ? model.modelId : null,
    modelRunId: null, provider: role === "assistant" ? model.provider : null, ...extra };
}

function chatFixture(): ChatDetailWire {
  const updatedAt = "2026-10-02T08:01:10.000Z";
  return {
    assistant: null, id: chatId, title: "Weekday news brief", createdAt: "2026-09-28T08:00:00.000Z", updatedAt,
    activeLeafMessageId: "brief-answer", defaultModelId: model.modelId, defaultProvider: model.provider, folderId: null,
    pinned: false, messageCount: 4, usageStats: null, contextStats: { approximateActiveBranchInputTokens: 400 },
    pageInfo: { activeLeafMessageId: "brief-answer", beforeCursor: null, hasOlder: false, snapshotUpdatedAt: updatedAt },
    workspace: { available: false, enabled: false, internetEnabled: false, sessionState: null },
    messages: [
      // An earlier run whose result was already seen, then the unread newest one.
      message("brief-question-1", "user", "Give me a short brief of the most important news from the last 24 hours.", null,
        { scheduledTask: { taskId: "brief", taskRunId: "brief-run-0", title: "Weekday news brief", unseen: false } }),
      message("brief-answer-1", "assistant", "Here is your brief for Thursday:\n\n- Synthetic headline zero.", "brief-question-1"),
      message("brief-question", "user", "Give me a short brief of the most important news from the last 24 hours.", "brief-answer-1",
        { scheduledTask: { taskId: "brief", taskRunId: "brief-run-3", title: "Weekday news brief", unseen: true } }),
      message("brief-answer", "assistant", "Here is your brief for Friday:\n\n- Synthetic headline one.\n- Synthetic headline two.", "brief-question")
    ]
  };
}

/** A monitoring chat: its first check, checks with no update around one that could not check, then an update. */
const watchChecks: readonly Readonly<{ answer: string; outcome: ScheduledTaskCheckOutcome }>[] = [
  { outcome: "baseline", answer: "Watching: the latest release is 1.4.0, published on 28 September." },
  { outcome: "no_update", answer: "Still 1.4.0. No new release since the last check." },
  { outcome: "no_update", answer: "Still 1.4.0. The release page is unchanged." },
  { outcome: "could_not_check", answer: "I could not reach the release tracker, so I could not check for a new release." },
  { outcome: "no_update", answer: "Still 1.4.0. Nothing new in the changelog." },
  { outcome: "no_update", answer: "Still 1.4.0. No new tags." },
  { outcome: "no_update", answer: "Still 1.4.0. The download page is unchanged." },
  { outcome: "update", answer: "Release 1.5.0 is out:\n\n- Faster sync.\n- A new export format." }
];

function watchChatFixture(): ChatDetailWire {
  const updatedAt = "2026-10-04T08:01:30.000Z";
  const messages: ChatMessageWire[] = [];
  watchChecks.forEach((check, index) => {
    const turn = `watch-${index + 1}`;
    const marker = { taskId: "watch", taskRunId: `watch-run-${index + 1}`, title: "Release watch", unseen: false };
    messages.push(message(`${turn}-question`, "user", "Tell me when a new release of the project is published.",
      messages.at(-1)?.id ?? null, { scheduledTask: marker, scheduledOutcome: check.outcome }));
    messages.push(message(`${turn}-answer`, "assistant", check.answer, `${turn}-question`, { scheduledOutcome: check.outcome }));
  });
  const leaf = messages.at(-1)!.id;
  return {
    assistant: null, id: watchChatId, title: "Release watch", createdAt: "2026-09-28T08:00:00.000Z", updatedAt,
    activeLeafMessageId: leaf, defaultModelId: model.modelId, defaultProvider: model.provider, folderId: null,
    pinned: false, messageCount: messages.length, usageStats: null, contextStats: { approximateActiveBranchInputTokens: 900 },
    pageInfo: { activeLeafMessageId: leaf, beforeCursor: null, hasOlder: false, snapshotUpdatedAt: updatedAt },
    workspace: { available: false, enabled: false, internetEnabled: false, sessionState: null },
    messages
  };
}

/** The navigation marker each fixture chat carries. */
const chatMarkers: Readonly<Record<string, Readonly<{ taskId: string; unseen: boolean }>>> = {
  [chatId]: { taskId: "brief", unseen: true },
  [watchChatId]: { taskId: "watch", unseen: false }
};

async function prepare(page: Page, tasks: readonly ScheduledTask[], theme: "dark" | "light" = "light",
  chats: readonly ChatDetailWire[] = [chatFixture()]) {
  await page.clock.setFixedTime(now);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.context().addCookies([{ name: "aiqsa.theme", value: theme, url: "http://127.0.0.1:3000" }]);
  await installMatrixCatalogFixture(page, { chats, folders: [] });
  await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));
  // The installation offers Workspace, so the editor's switch depends only on the task's model.
  await page.route("**/api/workspace", (route) => route.fulfill({ json: { workspace: {
    available: true, enabled: false, internetEnabled: false, sessionState: null
  } } }));
  await page.route("**/api/chats/compact?*", (route) => route.fulfill({ json: {
    chats: chats.map((chat) => ({ activeRun: false, assistant: null, folderId: null, id: chat.id, title: chat.title,
      updatedAt: chat.updatedAt, scheduledTask: chatMarkers[chat.id] ?? null })),
    folders: [], nextCursor: null
  } }));
  for (const chat of chats) {
    await page.route(`**/api/chats/${chat.id}`, (route) => route.fulfill({ json: { chat } }));
    await page.route(`**/api/chats/${chat.id}/branches`, (route) => route.fulfill({ json: { branchGraph: {
      activeLeafMessageId: chat.activeLeafMessageId, snapshotUpdatedAt: chat.updatedAt,
      nodes: chat.messages.map((item) => ({ id: item.id, parentMessageId: item.parentMessageId, preview: String(item.content),
        role: item.role, status: item.status }))
    } } }));
  }
  // A missed fixture must fail before it can dispatch a provider request.
  await page.route("**/api/chats/*/messages", (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 409, json: { error: "unexpected_fixture_run" } }) : route.fallback());
  const api = await installScheduledApi(page, tasks);
  await signInWithLocalToken(page, "/");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({ timeout: 30_000 });
  return api;
}

function sheetWidth(step: CaptureStep): number {
  // Below 640 px wide or 32rem high the sheet is full screen.
  return step.size.width < 640 || step.size.height < 512 ? step.size.width : Math.min(step.size.width, 600);
}

function seenWrites(api: Awaited<ReturnType<typeof installScheduledApi>>, taskId: string): unknown[] {
  return api.writes.filter((write) => write.method === "POST" && write.path === `/${taskId}/seen`).map((write) => write.body);
}

test("scheduled list, empty state, create, edit and delete fit every size in both themes", async ({ page }, info) => {
  const api = await prepare(page, listFixture);
  await runAccountMenuAction(page, "Scheduled");
  const panel = page.getByTestId("scheduled-tasks-panel");
  await expect(panel.getByRole("heading", { name: "Scheduled tasks", level: 2 })).toBeVisible();
  await expect(panel.getByText("4 of 10 active")).toBeVisible();
  const rows = panel.getByRole("list", { name: "Scheduled tasks" }).getByRole("listitem");
  await expect(rows).toHaveCount(listFixture.length);
  const brief = rows.filter({ hasText: "Weekday news brief" });
  await expect(brief).toContainText("Every weekday at 09:00");
  await expect(brief).toContainText("Next run Mon 5 Oct, 09:00");
  await expect(brief).toContainText("Last run Fri 2 Oct, 09:00 · Answered");
  await expect(brief.getByText("New result")).toHaveCount(1);
  await expect(rows.filter({ hasText: "Market open notes" })).toContainText("Running now");
  const inbox = rows.filter({ hasText: "Inbox check" });
  await expect(inbox).toContainText("Every 2 hours, 09:00–18:00, Mon–Fri");
  await expect(inbox).toContainText("Skipped: the previous run was still in progress");
  await expect(rows.filter({ hasText: "Model check-in" })).toContainText("Paused: the model is no longer available. Edit to choose another model.");
  await expect(rows.filter({ hasText: "Model check-in" })).toContainText("Failed: the model was unavailable");
  await expect(rows.filter({ hasText: "New York team" })).toContainText("Every Fri at 17:00 · America/New York");
  await expect(rows.filter({ hasText: "Launch reminder" })).toContainText("Completed");
  await expect(rows.filter({ hasText: "Monthly bills" })).toContainText("Skipped: the scheduled time passed while runs were unavailable");
  await expect(panel).not.toContainText(/model_unavailable|chat_busy|previous_running|missed\b/u);
  await captureState(page, info, "scheduled-list", {
    atEachSize: async () => {
      await expectNoHorizontalOverflow(page);
      await expectWithinViewport(page, panel.getByRole("button", { name: "New task", exact: true }));
    }
  });

  // Create: a weekly task through the sheet, with validation, a live preview and a new chat per run.
  await panel.getByRole("button", { name: "New task", exact: true }).click();
  const sheet = page.getByTestId("scheduled-task-sheet");
  const dialog = sheet.getByRole("dialog", { name: "New scheduled task", exact: true });
  await expect(sheet.getByLabel("Name", { exact: true })).toBeFocused();
  await sheet.getByLabel("Name", { exact: true }).fill("Weekly planning");
  await sheet.getByLabel("Instructions", { exact: true }).fill("List three priorities for the coming week.");
  await sheet.getByLabel("Repeat", { exact: true }).selectOption("weekly");
  await sheet.getByLabel("Time", { exact: true }).fill("17:00");
  await sheet.getByRole("button", { name: "Sunday", exact: true }).click();
  await expect(sheet.getByTestId("scheduled-task-preview")).toHaveText("Choose at least one day to see the next run.");
  await sheet.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(sheet.getByRole("alert")).toHaveText("Choose at least one day.");
  await sheet.getByRole("button", { name: "Monday", exact: true }).click();
  await sheet.getByRole("button", { name: "Thursday", exact: true }).click();
  await expect(sheet.getByRole("button", { name: "Monday", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(sheet.getByTestId("scheduled-task-preview")).toHaveText("Next run: Mon 5 Oct, 17:00");
  await expect(sheet.getByText("The email contains the task title and a link, never the answer.")).toBeVisible();
  const chatChoice = sheet.getByRole("group", { name: "Chat", exact: true });
  await expect(chatChoice.getByRole("radio", { name: "Each run starts a new chat", exact: true })).toBeChecked();
  await expect(chatChoice.getByRole("radio", { name: "Continue in this task's chat", exact: true })).toBeEnabled();
  expect(api.writes).toEqual([]);
  await captureState(page, info, "scheduled-create-weekly", {
    atEachSize: async (step) => {
      await expectWithinViewport(page, dialog);
      expect(Math.round((await dialog.boundingBox())!.width)).toBe(sheetWidth(step));
      await expectWithinViewport(page, sheet.getByRole("button", { name: "Create task", exact: true }));
      await expectNoHorizontalOverflow(page);
    }
  });
  await captureState(page, info, "scheduled-create-chat-mode", {
    anchor: chatChoice,
    atEachSize: async () => {
      await expectWithinViewport(page, chatChoice.getByRole("radio", { name: "Continue in this task's chat", exact: true }));
      await expectNoHorizontalOverflow(page);
    }
  });
  await sheet.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  expect(api.writes).toEqual([{ method: "POST", path: "", body: {
    title: "Weekly planning", prompt: "List three priorities for the coming week.",
    schedule: { kind: "weekly", time: "17:00", days: ["mon", "thu"] }, timeZone: "Europe/London",
    modelId: model.modelId, provider: model.provider, searchEnabled: false, emailNotify: false, toolsEnabled: true,
    workspaceEnabled: false, chatMode: "new", kind: "standard"
  } }]);
  await expect(panel.getByRole("heading", { name: "Weekly planning" })).toBeFocused();
  await expect(panel.getByText("“Weekly planning” is scheduled.")).toBeVisible();

  // Edit: the sheet lists recent runs compactly, marks the rendered unread one seen and links each run's chat.
  await panel.getByRole("button", { name: "More actions for Weekday news brief", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const edit = sheet.getByRole("dialog", { name: "Edit scheduled task", exact: true });
  const runs = edit.getByRole("region", { name: "Recent runs", exact: true });
  await expect(runs.getByRole("listitem")).toHaveCount(runsFixture.brief!.length);
  await expect(runs.getByRole("listitem").nth(0)).toContainText("New result: Answered");
  await expect(runs.getByRole("listitem").nth(1)).toContainText("Run now");
  await expect(runs.getByRole("listitem").nth(1)).toContainText("Failed: the task's chat was busy with another answer");
  await expect(runs.getByRole("button", { name: /^Open chat from /u })).toHaveCount(2);
  await expect.poll(() => seenWrites(api, "brief")).toEqual([{ runIds: ["brief-run-3"] }]);
  await expect(edit.getByLabel("Repeat", { exact: true })).toHaveValue("weekdays");
  await expect(sheet.getByTestId("scheduled-task-preview")).toHaveText("Next run: Mon 5 Oct, 09:00");
  await captureState(page, info, "scheduled-edit-recent-runs", {
    anchor: runs,
    atEachSize: async () => {
      await expectWithinViewport(page, runs.getByRole("button", { name: "Open chat from Fri 2 Oct, 09:00", exact: true }));
      await expectWithinViewport(page, sheet.getByRole("button", { name: "Save changes", exact: true }));
      await expectNoHorizontalOverflow(page);
    }
  });
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  // Its only unread run was rendered, so the task's dot is gone after the list is reread.
  await expect(brief.getByText("New result")).toHaveCount(0);

  // Hourly: the interval, window and days, with the chat fixed to the task's own.
  await panel.getByRole("button", { name: "More actions for Inbox check", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const hourly = sheet.getByRole("dialog", { name: "Edit scheduled task", exact: true });
  await expect(hourly.getByLabel("Repeat", { exact: true })).toHaveValue("hourly");
  await expect(hourly.getByLabel("Interval", { exact: true })).toHaveValue("2");
  await expect(hourly.getByRole("radio", { name: "Set hours", exact: true })).toBeChecked();
  await expect(hourly.getByLabel("From", { exact: true })).toHaveValue("09:00");
  await expect(hourly.getByLabel("Until", { exact: true })).toHaveValue("18:00");
  await expect(hourly.getByRole("button", { name: "Friday", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(hourly.getByRole("button", { name: "Saturday", exact: true })).toHaveAttribute("aria-pressed", "false");
  const hourlyChat = hourly.getByRole("group", { name: "Chat", exact: true });
  await expect(hourlyChat.getByRole("radio", { name: "Each run starts a new chat", exact: true })).toBeDisabled();
  await expect(hourlyChat.getByRole("radio", { name: "Continue in this task's chat", exact: true })).toBeChecked();
  await expect(hourlyChat).toContainText("Hourly tasks always continue in one chat.");
  await expect(sheet.getByTestId("scheduled-task-preview")).toHaveText("Next run: Mon 5 Oct, 09:00");
  await expect(hourly.getByRole("region", { name: "Recent runs", exact: true }).getByRole("listitem").nth(0))
    .toContainText("Skipped: the previous run was still in progress");
  await captureState(page, info, "scheduled-edit-hourly", {
    atEachSize: async () => {
      await expectWithinViewport(page, hourly);
      await expectWithinViewport(page, sheet.getByRole("button", { name: "Save changes", exact: true }));
      await expectNoHorizontalOverflow(page);
    }
  });
  await captureState(page, info, "scheduled-edit-hourly-chat", {
    anchor: hourlyChat,
    atEachSize: async () => {
      await expectWithinViewport(page, hourlyChat.getByRole("radio", { name: "Continue in this task's chat", exact: true }));
      await expectNoHorizontalOverflow(page);
    }
  });
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  expect(api.writes.filter((write) => write.method === "PATCH")).toEqual([]);

  // Delete: an inline confirmation names the task and what stays.
  await panel.getByRole("button", { name: "More actions for Model check-in", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const confirm = panel.getByRole("group", { name: "Delete Model check-in", exact: true });
  await expect(confirm).toContainText("Delete “Model check-in”? Its chats and answers stay in your history.");
  await captureState(page, info, "scheduled-delete-confirm", {
    anchor: confirm,
    atEachSize: async () => {
      await expectWithinViewport(page, confirm.getByRole("button", { name: "Delete task", exact: true }));
      await expectNoHorizontalOverflow(page);
    }
  });
  await confirm.getByRole("button", { name: "Delete task", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "Model check-in" })).toHaveCount(0);
  expect(api.writes.at(-1)).toEqual({ method: "DELETE", path: "/model", body: null });

  // Pause from the row switch, and the run conflict reads as a sentence.
  await panel.getByRole("switch", { name: "Run Monthly bills on schedule", exact: true }).click();
  await expect(rows.filter({ hasText: "Monthly bills" })).toContainText("Paused");
  expect(api.writes.at(-1)).toEqual({ method: "PATCH", path: "/monthly", body: { expectedRevision: 1, status: "paused" } });
  await panel.getByRole("button", { name: "More actions for Market open notes", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: /Run now/u })).toBeDisabled();
  await page.keyboard.press("Escape");
});

test("the empty state offers ideas that prefill the sheet", async ({ page }, info) => {
  const api = await prepare(page, []);
  await runAccountMenuAction(page, "Scheduled");
  const empty = page.getByTestId("scheduled-tasks-empty");
  await expect(empty.getByRole("heading", { name: "No scheduled tasks yet" })).toBeVisible();
  await expect(page.getByTestId("scheduled-tasks-panel").getByText("0 of 10 active")).toBeVisible();
  await captureState(page, info, "scheduled-empty", {
    atEachSize: async () => {
      await expectNoHorizontalOverflow(page);
      // Short landscape viewports scroll the ideas into reach; each must still fit on screen.
      for (const idea of await empty.getByRole("button").all()) {
        await idea.scrollIntoViewIfNeeded();
        await expectWithinViewport(page, idea);
      }
    }
  });
  await empty.getByRole("button", { name: "Reminder on the 1st of each month", exact: true }).click();
  const sheet = page.getByTestId("scheduled-task-sheet");
  await expect(sheet.getByLabel("Repeat", { exact: true })).toHaveValue("monthly");
  await expect(sheet.getByLabel("Day of the month", { exact: true })).toHaveValue("1");
  await expect(sheet.getByText("Shorter months use their last day.")).toBeVisible();
  await expect(sheet.getByTestId("scheduled-task-preview")).toHaveText("Next run: Sun 1 Nov, 10:00");
  // An untouched idea closes without a discard question.
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  expect(api.writes).toEqual([]);
});

test("an unread scheduled chat shows a dot, clears only its rendered result and its task's chat says how to change the task", async ({ page }, info) => {
  const api = await prepare(page, listFixture);
  if ((page.viewportSize()?.width ?? 0) < 768) await page.getByRole("button", { name: "Open sidebar" }).click();
  const row = page.getByRole("treeitem", { name: "Weekday news brief", exact: true });
  await expect(row).toHaveAccessibleDescription("New scheduled result");
  await captureState(page, info, "scheduled-navigation-unread", { sizes: [{ width: 1440, height: 900 }] });
  await row.click();
  const chip = page.getByRole("button", { name: "Scheduled · Weekday news brief", exact: true }).last();
  await expect(chip).toBeVisible();
  // Only the unread turn the transcript renders is sent; the earlier, seen one is not.
  await expect.poll(() => seenWrites(api, "brief")).toEqual([{ runIds: ["brief-run-3"] }]);
  await expect(row).not.toHaveAttribute("aria-describedby");
  const hint = page.getByTestId("scheduled-task-chat-hint");
  await expect(hint).toHaveText(/Replies here don't change the scheduled task\./u);
  const editTask = hint.getByRole("button", { name: "Edit task Weekday news brief", exact: true });
  await captureState(page, info, "scheduled-transcript-chip", {
    atEachSize: async () => {
      await expect(chip).toBeVisible();
      await expectWithinViewport(page, editTask);
      await expectWithinViewport(page, page.getByRole("textbox", { name: "Message", exact: true }));
      await expectNoHorizontalOverflow(page);
    }
  });
  await chip.click();
  await expect(page.getByTestId("library-v2").getByRole("tab", { name: "Scheduled" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Back to chat", exact: true }).click();
  await expect(hint).toBeVisible();
  // Edit task opens that task's editor in Studio › Scheduled.
  await editTask.click();
  const sheet = page.getByTestId("scheduled-task-sheet");
  await expect(sheet.getByRole("dialog", { name: "Edit scheduled task", exact: true })).toBeVisible();
  await expect(sheet.getByLabel("Name", { exact: true })).toHaveValue("Weekday news brief");
  // The modal editor hides the page behind it from the accessibility tree.
  await expect(page.getByTestId("library-v2").getByRole("tab", { includeHidden: true, name: "Scheduled" }))
    .toHaveAttribute("aria-selected", "true");
});

test("monitoring tasks show their type, the editor offers Type and the tool switches, and the history names each check", async ({ page }, info) => {
  const api = await prepare(page, [...listFixture.slice(0, 1), ...monitoringFixture]);
  await runAccountMenuAction(page, "Scheduled");
  const panel = page.getByTestId("scheduled-tasks-panel");
  const rows = panel.getByRole("list", { name: "Scheduled tasks" }).getByRole("listitem");
  const watch = rows.filter({ hasText: "Release watch" });
  await expect(watch).toContainText("Monitoring · Next run Sun 4 Oct, 13:00");
  await expect(watch).toContainText("Last run Sun 4 Oct, 09:00 · Update");
  const tickets = rows.filter({ hasText: "Concert ticket watch" });
  await expect(tickets).toContainText("Monitoring · Goal reached — completed");
  await expect(tickets).toContainText("Last run Sat 3 Oct, 09:00 · Goal reached");
  // A reached goal completes the task, and it can still be resumed.
  await expect(tickets.getByRole("switch", { name: "Run Concert ticket watch on schedule", exact: true })).toHaveAttribute("aria-checked", "false");
  await expect(rows.filter({ hasText: "Weekday news brief" })).not.toContainText("Monitoring");
  await captureState(page, info, "scheduled-list-monitoring", {
    anchor: tickets,
    atEachSize: async () => {
      await expectWithinViewport(page, tickets.getByRole("switch"));
      await expectNoHorizontalOverflow(page);
    }
  });

  // The editor of a monitoring task: Type, the chat fixed to its own, the tool switches and the check history.
  await panel.getByRole("button", { name: "More actions for Concert ticket watch", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const sheet = page.getByTestId("scheduled-task-sheet");
  const dialog = sheet.getByRole("dialog", { name: "Edit scheduled task", exact: true });
  const type = dialog.getByRole("group", { name: "Type", exact: true });
  await expect(type.getByRole("radio", { name: "Monitoring", exact: true })).toBeChecked();
  await expect(type).toContainText("Monitoring reports only when something changed and can stop itself when the goal is reached.");
  const chat = dialog.getByRole("group", { name: "Chat", exact: true });
  await expect(chat.getByRole("radio", { name: "Each run starts a new chat", exact: true })).toBeDisabled();
  await expect(chat.getByRole("radio", { name: "Continue in this task's chat", exact: true })).toBeChecked();
  await expect(chat).toContainText("Monitoring compares each check with the last result, so it always continues in one chat.");
  const tools = dialog.getByRole("switch", { name: "Tools (MCP and Skills)", exact: true });
  const workspace = dialog.getByRole("switch", { name: "Workspace", exact: true });
  await expect(tools).toHaveAttribute("aria-checked", "true");
  await expect(workspace).toHaveAttribute("aria-checked", "true");
  await expect(workspace).toHaveAccessibleDescription("Runs share this task's Workspace, so its files stay from run to run.");
  const runs = dialog.getByRole("region", { name: "Recent runs", exact: true });
  const entries = runs.getByRole("listitem");
  await expect(entries).toHaveCount(runsFixture.tickets!.length);
  await expect(entries.nth(0)).toContainText("Goal reached — task completed");
  await expect(entries.nth(1)).toContainText("Could not check: a source was unavailable");
  await expect(entries.nth(1)).toContainText("Ticket marketplace needs sign-in.");
  await expect(entries.nth(1)).toHaveAttribute("data-tone", "attention");
  await expect(entries.nth(2)).toContainText("No update: nothing changed since the last shown result");
  await expect(entries.nth(2)).toHaveAttribute("data-tone", "quiet");
  await expect(entries.nth(4)).toContainText("First check: the starting point later checks compare with");
  await expect(dialog).not.toContainText(/no_update|could_not_check|goal_reached|mcp_reauthorization_required/u);
  await captureState(page, info, "scheduled-edit-monitoring", {
    anchor: type,
    atEachSize: async (step) => {
      await expectWithinViewport(page, dialog);
      expect(Math.round((await dialog.boundingBox())!.width)).toBe(sheetWidth(step));
      await expectWithinViewport(page, type.getByRole("radio", { name: "Monitoring", exact: true }));
      await expectNoHorizontalOverflow(page);
    }
  });
  await captureState(page, info, "scheduled-edit-monitoring-tools", {
    anchor: workspace,
    atEachSize: async () => {
      await expectWithinViewport(page, tools);
      await expectWithinViewport(page, workspace);
      await expectNoHorizontalOverflow(page);
    }
  });
  await captureState(page, info, "scheduled-edit-monitoring-history", {
    anchor: entries.nth(1),
    atEachSize: async () => {
      await expectWithinViewport(page, entries.nth(1));
      await expectWithinViewport(page, sheet.getByRole("button", { name: "Save changes", exact: true }));
      await expectNoHorizontalOverflow(page);
    }
  });

  // Back to Regular restores the owner's chat choice; no save leaves the editor.
  await type.getByRole("radio", { name: "Regular", exact: true }).check();
  await expect(chat.getByRole("radio", { name: "Continue in this task's chat", exact: true })).toBeChecked();
  await expect(chat.getByRole("radio", { name: "Each run starts a new chat", exact: true })).toBeEnabled();
  await type.getByRole("radio", { name: "Monitoring", exact: true }).check();
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(sheet).toHaveCount(0);

  // A new task starts with the composer's tool defaults and switches to monitoring in one chat.
  await panel.getByRole("button", { name: "New task", exact: true }).click();
  const create = sheet.getByRole("dialog", { name: "New scheduled task", exact: true });
  await create.getByLabel("Name", { exact: true }).fill("Docs watch");
  await create.getByRole("group", { name: "Type", exact: true }).getByRole("radio", { name: "Monitoring", exact: true }).check();
  await create.getByLabel("Instructions", { exact: true }).fill("Tell me when the documentation changes.");
  await expect(create.getByRole("switch", { name: "Tools (MCP and Skills)", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(create.getByRole("switch", { name: "Workspace", exact: true })).toHaveAttribute("aria-checked", "false");
  await expect(create.getByRole("switch", { name: "Workspace", exact: true }))
    .toHaveAccessibleDescription("Runs share this task's Workspace, so its files stay from run to run.");
  await create.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  expect(api.writes.at(-1)).toMatchObject({ method: "POST", path: "", body: {
    title: "Docs watch", kind: "monitoring", chatMode: "same", toolsEnabled: true, workspaceEnabled: false
  } });
  expect(api.writes.filter((write) => write.method === "PATCH")).toEqual([]);
});

test("a monitoring chat folds checks with no update into one row and shows them unchanged on request", async ({ page }, info) => {
  await prepare(page, monitoringFixture, "light", [chatFixture(), watchChatFixture()]);
  if ((page.viewportSize()?.width ?? 0) < 768) await page.getByRole("button", { name: "Open sidebar" }).click();
  await page.getByRole("treeitem", { name: "Release watch", exact: true }).click();
  const thread = page.getByTestId("conversation-thread");
  await expect(thread.getByText("Release 1.5.0 is out:")).toBeVisible();
  const groups = page.getByTestId("scheduled-checks-row");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toHaveText(/2 checks with no update\s*·\s*Show/u);
  await expect(groups.nth(1)).toHaveText(/3 checks with no update\s*·\s*Show/u);
  // The first check, the one that could not check and the update stay visible; checks with no update do not.
  await expect(thread.getByText("Watching: the latest release is 1.4.0")).toBeVisible();
  await expect(thread.getByText("I could not reach the release tracker")).toBeVisible();
  await expect(thread.getByText(/^Still 1\.4\.0/u)).toHaveCount(0);
  const show = page.getByRole("button", { name: "Show 3 checks with no update", exact: true });
  await expect(show).toHaveAttribute("aria-expanded", "false");
  await captureState(page, info, "scheduled-transcript-checks-collapsed", {
    anchor: groups.nth(1),
    atEachSize: async () => {
      await expectWithinViewport(page, show);
      await expectNoHorizontalOverflow(page);
    }
  });

  // The toggle is a keyboard control; the checks appear unchanged, each with its own turn.
  await show.focus();
  await page.keyboard.press("Enter");
  const hide = page.getByRole("button", { name: "Hide 3 checks with no update", exact: true });
  await expect(hide).toHaveAttribute("aria-expanded", "true");
  await expect(hide).toBeFocused();
  for (const text of ["Still 1.4.0. Nothing new in the changelog.", "Still 1.4.0. No new tags.", "Still 1.4.0. The download page is unchanged."]) {
    await expect(thread.getByText(text, { exact: true })).toBeVisible();
  }
  await expect(thread.getByText("Still 1.4.0. No new release since the last check.", { exact: true })).toHaveCount(0);
  await captureState(page, info, "scheduled-transcript-checks-expanded", {
    anchor: hide,
    atEachSize: async () => {
      await expectWithinViewport(page, hide);
      await expectNoHorizontalOverflow(page);
    }
  });
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Show 3 checks with no update", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(thread.getByText(/^Still 1\.4\.0/u)).toHaveCount(0);
});

test.describe("touch controls", () => {
  test.use({ hasTouch: true });
  test("rows and the editor keep touch-safe controls and reachable actions in both phone orientations", async ({ page }, info) => {
    await prepare(page, listFixture.slice(0, 3));
    for (const size of touchSizes) {
      await page.setViewportSize(size);
      await runAccountMenuAction(page, "Scheduled");
      const panel = page.getByTestId("scheduled-tasks-panel");
      const brief = panel.getByRole("listitem").filter({ hasText: "Weekday news brief" });
      for (const control of [brief.getByRole("switch"), brief.getByRole("button", { name: "Open chat for Weekday news brief" }),
        brief.getByRole("button", { name: "More actions for Weekday news brief" })]) await expectTouchSafe(control);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath(`scheduled-list-touch-${size.width}x${size.height}.png`) });
      await panel.getByRole("button", { name: "New task", exact: true }).click();
      const sheet = page.getByTestId("scheduled-task-sheet");
      await sheet.getByLabel("Repeat", { exact: true }).selectOption("weekly");
      for (const day of await sheet.getByRole("group", { name: "Days" }).getByRole("button").all()) await expectTouchSafe(day);
      for (const control of await sheet.getByRole("switch").all()) await expectTouchSafe(control);
      for (const name of ["Cancel", "Create task"]) {
        const button = sheet.getByRole("button", { name, exact: true });
        await expectTouchSafe(button);
        await expectWithinViewport(page, button);
      }
      await sheet.getByLabel("Instructions", { exact: true }).focus();
      await expectWithinViewport(page, sheet.getByRole("button", { name: "Create task", exact: true }));
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath(`scheduled-sheet-touch-${size.width}x${size.height}.png`) });
      // Hourly: the window and chat choices are whole touch targets, not just their radio dots.
      await sheet.getByLabel("Repeat", { exact: true }).selectOption("hourly");
      await sheet.getByRole("radio", { name: "Set hours", exact: true }).check();
      for (const name of ["All day", "Set hours", "Continue in this task's chat"]) {
        await expectTouchSafe(sheet.getByRole("radio", { name, exact: true }).locator("xpath=.."));
      }
      for (const field of ["Interval", "From", "Until"]) await expectTouchSafe(sheet.getByLabel(field, { exact: true }));
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath(`scheduled-sheet-hourly-touch-${size.width}x${size.height}.png`) });
      await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
      await sheet.getByRole("button", { name: "Confirm discard changes", exact: true }).click();
      await expect(sheet).toHaveCount(0);
      await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    }
  });

  test("the monitoring editor and folded checks keep touch-safe controls in both phone orientations", async ({ page }, info) => {
    await prepare(page, monitoringFixture, "light", [chatFixture(), watchChatFixture()]);
    await page.setViewportSize(touchSizes[0]!);
    await page.getByRole("button", { name: "Open sidebar" }).click();
    await page.getByRole("treeitem", { name: "Release watch", exact: true }).click();
    const show = page.getByRole("button", { name: "Show 3 checks with no update", exact: true });
    for (const size of touchSizes) {
      await page.setViewportSize(size);
      await show.scrollIntoViewIfNeeded();
      await expectTouchSafe(show);
      await expectWithinViewport(page, show);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath(`scheduled-transcript-checks-touch-${size.width}x${size.height}.png`) });
    }
    for (const size of touchSizes) {
      await page.setViewportSize(size);
      await runAccountMenuAction(page, "Scheduled");
      const panel = page.getByTestId("scheduled-tasks-panel");
      await panel.getByRole("button", { name: "More actions for Release watch", exact: true }).click();
      await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
      const sheet = page.getByTestId("scheduled-task-sheet");
      for (const name of ["Regular", "Monitoring"]) {
        await expectTouchSafe(sheet.getByRole("radio", { name, exact: true }).locator("xpath=.."));
      }
      for (const name of ["Tools (MCP and Skills)", "Workspace"]) {
        const control = sheet.getByRole("switch", { name, exact: true });
        await control.scrollIntoViewIfNeeded();
        await expectTouchSafe(control);
        await expectWithinViewport(page, control);
      }
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath(`scheduled-sheet-monitoring-touch-${size.width}x${size.height}.png`) });
      await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(sheet).toHaveCount(0);
      await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    }
  });

  test("the task chat keeps a touch-safe Edit task action above the composer in both phone orientations", async ({ page }, info) => {
    await prepare(page, listFixture.slice(0, 1));
    await page.setViewportSize(touchSizes[0]!);
    await page.getByRole("button", { name: "Open sidebar" }).click();
    await page.getByRole("treeitem", { name: "Weekday news brief", exact: true }).click();
    const editTask = page.getByTestId("scheduled-task-chat-hint").getByRole("button", { name: "Edit task Weekday news brief", exact: true });
    for (const size of touchSizes) {
      await page.setViewportSize(size);
      await expectTouchSafe(editTask);
      await expectWithinViewport(page, editTask);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath(`scheduled-chat-hint-touch-${size.width}x${size.height}.png`) });
    }
  });
});
