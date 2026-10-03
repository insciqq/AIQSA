import { expect, test, type Page } from "@playwright/test";
import type { ChatDetailWire, ChatMessageWire } from "../../lib/contracts/chats";
import type { ScheduledTask, ScheduledTaskRun } from "../../lib/contracts/scheduledTasks";
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
const touchSizes = [{ width: 390, height: 844 }, { width: 844, height: 390 }];

test.use({ timezoneId: "Europe/London" });
test.setTimeout(240_000);

function task(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: "task", title: "Task", prompt: "Synthetic scheduled instructions.",
    schedule: { kind: "daily", time: "09:00" }, timeZone: "Europe/London",
    modelId: model.modelId, provider: model.provider, searchEnabled: false, emailNotify: false,
    status: "active", pauseReason: null, nextRunAt: "2026-10-05T08:00:00.000Z", lastRun: null, running: false,
    chatId: null, unseenResult: false, revision: 1,
    createdAt: "2026-09-20T08:00:00.000Z", updatedAt: "2026-09-20T08:00:00.000Z",
    ...overrides
  };
}

const listFixture: ScheduledTask[] = [
  task({
    id: "brief", title: "Weekday news brief", chatId, unseenResult: true,
    schedule: { kind: "weekly", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] },
    lastRun: { scheduledFor: "2026-10-02T08:00:00.000Z", state: "completed", reasonCode: null, finishedAt: "2026-10-02T08:01:10.000Z" }
  }),
  task({ id: "market", title: "Market open notes", running: true, chatId: "scheduled-market-chat", schedule: { kind: "daily", time: "07:30" } }),
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

const recentRuns: ScheduledTaskRun[] = [
  { scheduledFor: "2026-10-02T08:00:00.000Z", trigger: "schedule", state: "completed", reasonCode: null,
    startedAt: "2026-10-02T08:00:03.000Z", finishedAt: "2026-10-02T08:01:10.000Z", chatId },
  { scheduledFor: "2026-10-01T13:12:00.000Z", trigger: "manual", state: "failed", reasonCode: "chat_busy",
    startedAt: "2026-10-01T13:12:00.000Z", finishedAt: "2026-10-01T13:42:00.000Z", chatId },
  { scheduledFor: "2026-10-01T08:00:00.000Z", trigger: "schedule", state: "skipped", reasonCode: "missed",
    startedAt: null, finishedAt: "2026-10-01T20:00:00.000Z", chatId }
];

type Write = Readonly<{ method: string; path: string; body: unknown }>;

async function installScheduledApi(page: Page, initial: readonly ScheduledTask[]) {
  const state = { tasks: initial.map((entry) => structuredClone(entry)), writes: [] as Write[] };
  await page.route(/\/api\/me\/scheduled-tasks(\/[^?]*)?(\?.*)?$/u, async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname.replace(/^\/api\/me\/scheduled-tasks/u, "");
    if (method !== "GET") state.writes.push({ method, path, body: request.postData() ? request.postDataJSON() : null });
    if (!path && method === "GET") {
      return route.fulfill({ json: { tasks: state.tasks, limits: { maxActive: 10, maxTotal: 50 }, emailAvailable: true } });
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
      state.tasks[index] = { ...current, unseenResult: false };
      return route.fulfill({ status: 204, body: "" });
    }
    if (action === "run") {
      if (current.running) return route.fulfill({ status: 409, json: { error: "scheduled_task_running" } });
      state.tasks[index] = { ...current, running: true };
      return route.fulfill({ json: { task: state.tasks[index] } });
    }
    if (method === "GET") return route.fulfill({ json: { task: current, recentRuns } });
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
    pinned: false, messageCount: 2, usageStats: null, contextStats: { approximateActiveBranchInputTokens: 400 },
    pageInfo: { activeLeafMessageId: "brief-answer", beforeCursor: null, hasOlder: false, snapshotUpdatedAt: updatedAt },
    workspace: { available: false, enabled: false, internetEnabled: false, sessionState: null },
    messages: [
      message("brief-question", "user", "Give me a short brief of the most important news from the last 24 hours.", null,
        { scheduledTask: { taskId: "brief", title: "Weekday news brief" } }),
      message("brief-answer", "assistant", "Here is your brief for Friday:\n\n- Synthetic headline one.\n- Synthetic headline two.", "brief-question")
    ]
  };
}

async function prepare(page: Page, tasks: readonly ScheduledTask[], theme: "dark" | "light" = "light") {
  await page.clock.setFixedTime(now);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.context().addCookies([{ name: "aiqsa.theme", value: theme, url: "http://127.0.0.1:3000" }]);
  const chat = chatFixture();
  await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
  await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));
  await page.route("**/api/chats/compact?*", (route) => route.fulfill({ json: {
    chats: [{ activeRun: false, assistant: null, folderId: null, id: chatId, title: chat.title, updatedAt: chat.updatedAt,
      scheduledTask: { taskId: "brief", unseen: true } }],
    folders: [], nextCursor: null
  } }));
  await page.route(`**/api/chats/${chatId}`, (route) => route.fulfill({ json: { chat } }));
  await page.route(`**/api/chats/${chatId}/branches`, (route) => route.fulfill({ json: { branchGraph: {
    activeLeafMessageId: chat.activeLeafMessageId, snapshotUpdatedAt: chat.updatedAt,
    nodes: chat.messages.map((item) => ({ id: item.id, parentMessageId: item.parentMessageId, preview: String(item.content),
      role: item.role, status: item.status }))
  } } }));
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

test("scheduled list, empty state, create, edit and delete fit every size in both themes", async ({ page }, info) => {
  const api = await prepare(page, listFixture);
  await runAccountMenuAction(page, "Scheduled");
  const panel = page.getByTestId("scheduled-tasks-panel");
  await expect(panel.getByRole("heading", { name: "Scheduled tasks", level: 2 })).toBeVisible();
  await expect(panel.getByText("3 of 10 active")).toBeVisible();
  const rows = panel.getByRole("list", { name: "Scheduled tasks" }).getByRole("listitem");
  await expect(rows).toHaveCount(listFixture.length);
  const brief = rows.filter({ hasText: "Weekday news brief" });
  await expect(brief).toContainText("Every weekday at 09:00");
  await expect(brief).toContainText("Next run Mon 5 Oct, 09:00");
  await expect(brief).toContainText("Last run Fri 2 Oct, 09:00 · Answered");
  await expect(brief.getByText("New result")).toHaveCount(1);
  await expect(rows.filter({ hasText: "Market open notes" })).toContainText("Running now");
  await expect(rows.filter({ hasText: "Model check-in" })).toContainText("Paused: the model is no longer available. Edit to choose another model.");
  await expect(rows.filter({ hasText: "Model check-in" })).toContainText("Failed: the model was unavailable");
  await expect(rows.filter({ hasText: "New York team" })).toContainText("Every Fri at 17:00 · America/New York");
  await expect(rows.filter({ hasText: "Launch reminder" })).toContainText("Completed");
  await expect(rows.filter({ hasText: "Monthly bills" })).toContainText("Skipped: the scheduled time passed while runs were unavailable");
  await expect(panel).not.toContainText(/model_unavailable|chat_busy|missed\b/u);
  await captureState(page, info, "scheduled-list", {
    atEachSize: async () => {
      await expectNoHorizontalOverflow(page);
      await expectWithinViewport(page, panel.getByRole("button", { name: "New task", exact: true }));
    }
  });

  // Create: a weekly task through the sheet, with validation and a live preview.
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
  expect(api.writes).toEqual([]);
  await captureState(page, info, "scheduled-create-weekly", {
    atEachSize: async (step) => {
      await expectWithinViewport(page, dialog);
      expect(Math.round((await dialog.boundingBox())!.width)).toBe(sheetWidth(step));
      await expectWithinViewport(page, sheet.getByRole("button", { name: "Create task", exact: true }));
      await expectNoHorizontalOverflow(page);
    }
  });
  await sheet.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  expect(api.writes).toEqual([{ method: "POST", path: "", body: {
    title: "Weekly planning", prompt: "List three priorities for the coming week.",
    schedule: { kind: "weekly", time: "17:00", days: ["mon", "thu"] }, timeZone: "Europe/London",
    modelId: model.modelId, provider: model.provider, searchEnabled: false, emailNotify: false
  } }]);
  await expect(panel.getByRole("heading", { name: "Weekly planning" })).toBeFocused();
  await expect(panel.getByText("“Weekly planning” is scheduled.")).toBeVisible();

  // Edit: the sheet lists recent runs compactly.
  await panel.getByRole("button", { name: "More actions for Weekday news brief", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const edit = sheet.getByRole("dialog", { name: "Edit scheduled task", exact: true });
  const runs = edit.getByRole("region", { name: "Recent runs", exact: true });
  await expect(runs.getByRole("listitem")).toHaveCount(recentRuns.length);
  await expect(runs.getByRole("listitem").nth(1)).toContainText("Run now");
  await expect(runs.getByRole("listitem").nth(1)).toContainText("Failed: the task's chat was busy with another answer");
  await expect(edit.getByLabel("Repeat", { exact: true })).toHaveValue("weekdays");
  await expect(sheet.getByTestId("scheduled-task-preview")).toHaveText("Next run: Mon 5 Oct, 09:00");
  await captureState(page, info, "scheduled-edit-recent-runs", {
    anchor: runs,
    atEachSize: async () => {
      await expectWithinViewport(page, sheet.getByRole("button", { name: "Save changes", exact: true }));
      await expectNoHorizontalOverflow(page);
    }
  });
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(sheet).toHaveCount(0);

  // Delete: an inline confirmation names the task and what stays.
  await panel.getByRole("button", { name: "More actions for Model check-in", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const confirm = panel.getByRole("group", { name: "Delete Model check-in", exact: true });
  await expect(confirm).toContainText("Delete “Model check-in”? Its chat and answers stay in your history.");
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
      for (const idea of await empty.getByRole("button").all()) await expectWithinViewport(page, idea);
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

test("an unread scheduled chat shows a dot, clears when opened and its turn links to Scheduled", async ({ page }, info) => {
  const api = await prepare(page, listFixture);
  if ((page.viewportSize()?.width ?? 0) < 768) await page.getByRole("button", { name: "Open sidebar" }).click();
  const row = page.getByRole("treeitem", { name: "Weekday news brief", exact: true });
  await expect(row).toHaveAccessibleDescription("New scheduled result");
  await captureState(page, info, "scheduled-navigation-unread", { sizes: [{ width: 1440, height: 900 }] });
  await row.click();
  const chip = page.getByRole("button", { name: "Scheduled · Weekday news brief", exact: true });
  await expect(chip).toBeVisible();
  await expect.poll(() => api.writes.some((write) => write.method === "POST" && write.path === "/brief/seen")).toBe(true);
  await expect(row).not.toHaveAttribute("aria-describedby");
  await captureState(page, info, "scheduled-transcript-chip", {
    atEachSize: async () => {
      await expect(chip).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });
  await chip.click();
  await expect(page.getByTestId("library-v2").getByRole("tab", { name: "Scheduled" })).toHaveAttribute("aria-selected", "true");
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
      await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
      await sheet.getByRole("button", { name: "Confirm discard changes", exact: true }).click();
      await expect(sheet).toHaveCount(0);
      await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    }
  });
});
