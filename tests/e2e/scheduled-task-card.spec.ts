import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ChatDetailWire, ChatMessageWire } from "../../lib/contracts/chats";
import type { ScheduledTask, ScheduledTaskCard } from "../../lib/contracts/scheduledTasks";
import { matrixCatalog } from "./shell/catalog";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { captureState } from "./support/capture";
import { expectNoHorizontalOverflow, expectTouchSafe, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

// Mocked owner API; the browser clock and zone are fixed so every date is stable.
const now = new Date("2026-10-04T10:00:00.000Z");
const model = matrixCatalog.models[0]!;
const chatId = "scheduled-card-chat";
const touchSizes = [{ width: 390, height: 844 }, { width: 844, height: 390 }];
const everyDay = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

test.use({ timezoneId: "Europe/London" });
test.setTimeout(240_000);

function card(overrides: Partial<ScheduledTaskCard> & Pick<ScheduledTaskCard, "taskId" | "title">): ScheduledTaskCard {
  return {
    kind: "standard", schedule: { kind: "daily", time: "07:30" }, timeZone: "Europe/London", timeZoneFallback: false,
    toolsEnabled: false, workspaceEnabled: false, status: "active", nextRunAt: "2026-10-05T06:30:00.000Z",
    ...overrides
  };
}

/** One card per answer, as the chat tool creates at most one task per answer. */
const cards = {
  weekly: card({ taskId: "brief-card", title: "Weekday morning brief", toolsEnabled: true,
    schedule: { kind: "weekly", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] }, nextRunAt: "2026-10-05T08:00:00.000Z" }),
  monitoring: card({ taskId: "release-card", title: "Release monitor", kind: "monitoring", toolsEnabled: true, workspaceEnabled: true,
    schedule: { kind: "hourly", everyHours: 1, time: "00:00", until: null, days: [...everyDay] }, nextRunAt: "2026-10-04T11:00:00.000Z" }),
  otherZone: card({ taskId: "team-card", title: "New York team summary", timeZone: "America/New_York",
    schedule: { kind: "weekly", time: "17:00", days: ["fri"] }, nextRunAt: "2026-10-09T21:00:00.000Z" }),
  deleted: card({ taskId: "price-card", title: "Old price check", deleted: true }),
  paused: card({ taskId: "digest-card", title: "Evening reading digest", status: "paused", nextRunAt: null })
} satisfies Record<string, ScheduledTaskCard>;

/** Cards of tasks later answers managed: what each answer last did, over the task as it is now. */
const managed = {
  moved: card({ taskId: "moved-card", title: "Report reminder", action: "changed",
    schedule: { kind: "weekly", time: "10:00", days: ["mon", "wed", "fri"] }, nextRunAt: "2026-10-05T09:00:00.000Z" }),
  stopped: card({ taskId: "monitor-card", title: "Price monitor", kind: "monitoring", action: "paused", status: "paused",
    nextRunAt: null, toolsEnabled: true }),
  proposal: card({ taskId: "old-report-card", title: "Old weekly report", action: "delete_proposed",
    schedule: { kind: "weekly", time: "08:00", days: ["mon"] }, nextRunAt: "2026-10-05T07:00:00.000Z" }),
  proposalGone: card({ taskId: "gone-card", title: "Gone reminder", action: "delete_proposed", deleted: true })
} satisfies Record<string, ScheduledTaskCard>;

const turns: readonly Readonly<{ ask: string; answer: string; card: ScheduledTaskCard }>[] = [
  { card: cards.weekly, ask: "Every weekday at 9, send me a short morning brief.", answer: "Done: your weekday morning brief is scheduled." },
  { card: cards.monitoring, ask: "Watch the project every hour and tell me when a release ships.", answer: "I will check every hour and report only a new release." },
  { card: cards.otherZone, ask: "Every Friday at 5 pm New York time, summarise the team's week.", answer: "Scheduled for Fridays at 17:00 New York time." },
  { card: cards.deleted, ask: "Check the price every morning.", answer: "Scheduled the price check." },
  { card: cards.paused, ask: "Every morning, pick one article for me to read.", answer: "Your reading digest is set up." },
  { card: managed.moved, ask: "Move my report reminder to 10:00.", answer: "Moved your report reminder to 10:00." },
  { card: managed.stopped, ask: "Stop the price monitor.", answer: "Paused the price monitor." },
  { card: managed.proposal, ask: "Delete the old weekly report.", answer: "Confirm the deletion in the card below." },
  { card: managed.proposalGone, ask: "Delete the gone reminder.", answer: "Confirm the deletion in the card below." }
];

/** The owner's stored task behind a card. */
function task(source: ScheduledTaskCard): ScheduledTask {
  return {
    id: source.taskId, title: source.title, prompt: "Synthetic scheduled instructions.",
    schedule: source.schedule, timeZone: source.timeZone,
    modelId: model.modelId, provider: model.provider, searchEnabled: false, emailNotify: false, toolsEnabled: source.toolsEnabled,
    workspaceEnabled: source.workspaceEnabled, chatMode: "same", kind: source.kind, status: source.status, pauseReason: null,
    completionReason: null, nextRunAt: source.nextRunAt, lastRun: null, running: false,
    // A task created from chat gets its own chat on its first run, never the chat that created it.
    chatId: null, unseenResult: false, revision: 1,
    createdAt: "2026-10-04T09:00:00.000Z", updatedAt: "2026-10-04T09:00:00.000Z"
  };
}

type Write = Readonly<{ method: string; path: string; body: unknown }>;

async function installScheduledApi(page: Page, initial: readonly ScheduledTask[]) {
  const state = { tasks: initial.map((entry) => structuredClone(entry)), writes: [] as Write[] };
  await page.route(/\/api\/me\/scheduled-tasks(\/[^?]*)?(\?.*)?$/u, async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname.replace(/^\/api\/me\/scheduled-tasks/u, "");
    if (method !== "GET") state.writes.push({ method, path, body: request.postData() ? request.postDataJSON() : null });
    if (!path && method === "GET") {
      return route.fulfill({ json: { tasks: state.tasks, limits: { maxActive: 10, maxActiveHourly: 3, maxTotal: 50 },
        emailAvailable: true } });
    }
    const [, id, action] = path.split("/");
    const index = state.tasks.findIndex((entry) => entry.id === id);
    const current = state.tasks[index];
    if (!current) return route.fulfill({ status: 404, json: { error: "scheduled_task_not_found" } });
    if (action === "seen") return route.fulfill({ status: 204, body: "" });
    if (method === "GET" && !action) return route.fulfill({ json: { task: current, recentRuns: [] } });
    if (method === "DELETE" && !action) {
      state.tasks.splice(index, 1);
      return route.fulfill({ status: 204, body: "" });
    }
    // No other write belongs to these flows.
    return route.fulfill({ status: 409, json: { error: "unexpected_fixture_write" } });
  });
  return state;
}

function message(id: string, role: "assistant" | "user", content: string, parentMessageId: string | null,
  extra: Partial<ChatMessageWire> = {}): ChatMessageWire {
  return { id, role, content, parentMessageId, createdAt: "2026-10-04T09:00:00.000Z", status: "complete",
    citationMessageId: null, errorMessage: null, modelId: role === "assistant" ? model.modelId : null,
    modelRunId: null, provider: role === "assistant" ? model.provider : null, ...extra };
}

/** The chat detail as a reload projects it: each answer carries the card of the task it created. */
function chatFixture(): ChatDetailWire {
  const updatedAt = "2026-10-04T09:05:00.000Z";
  const messages: ChatMessageWire[] = [];
  turns.forEach((turn, index) => {
    messages.push(message(`turn-${index + 1}-question`, "user", turn.ask, messages.at(-1)?.id ?? null));
    messages.push(message(`turn-${index + 1}-answer`, "assistant", turn.answer, `turn-${index + 1}-question`, {
      artifactSummary: { citations: [], reasoningText: [], scheduledTasks: [turn.card], sources: [] }
    }));
  });
  const leaf = messages.at(-1)!.id;
  return {
    assistant: null, id: chatId, title: "Scheduling helpers", createdAt: "2026-10-04T09:00:00.000Z", updatedAt,
    activeLeafMessageId: leaf, defaultModelId: model.modelId, defaultProvider: model.provider, folderId: null,
    pinned: false, messageCount: messages.length, usageStats: null, contextStats: { approximateActiveBranchInputTokens: 600 },
    pageInfo: { activeLeafMessageId: leaf, beforeCursor: null, hasOlder: false, snapshotUpdatedAt: updatedAt },
    workspace: { available: false, enabled: false, internetEnabled: false, sessionState: null },
    messages
  };
}

async function prepare(page: Page, theme: "dark" | "light" = "light") {
  const chats = [chatFixture()];
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
      updatedAt: chat.updatedAt, scheduledTask: null })),
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
  // The deleted cards' tasks are gone from the owner's list; every other card's task exists.
  const api = await installScheduledApi(page, turns.map((turn) => turn.card).filter((entry) => !entry.deleted).map(task));
  await signInWithLocalToken(page, `/c/${chatId}`);
  await expect(page.getByTestId("scheduled-task-card")).toHaveCount(turns.length, { timeout: 30_000 });
  return api;
}

function cardOf(page: Page, title: string): Locator {
  return page.getByTestId("scheduled-task-card").filter({ hasText: title });
}

function editButton(scope: Locator, title: string): Locator {
  return scope.getByRole("button", { name: `Edit scheduled task ${title}`, exact: true });
}

function deleteButton(scope: Locator, title: string): Locator {
  return scope.getByRole("button", { name: `Delete scheduled task ${title}`, exact: true });
}

test("cards show a created, monitoring, other-zone, deleted and paused task at every size in both themes", async ({ page }, info) => {
  const api = await prepare(page);
  const weekly = cardOf(page, cards.weekly.title);
  await expect(weekly.getByRole("status")).toHaveText("Scheduled task created");
  await expect(weekly).toContainText("Every weekday at 09:00 · Tools");
  await expect(weekly).toContainText("Next run Mon 5 Oct, 09:00");
  // The viewer's own zone is not repeated.
  await expect(weekly).not.toContainText("Europe/London");
  await expect(weekly).toHaveAttribute("data-state", "active");
  await expect(editButton(weekly, cards.weekly.title)).toBeVisible();
  await expect(deleteButton(weekly, cards.weekly.title)).toBeVisible();
  await captureState(page, info, "scheduled-card-created", {
    anchor: weekly,
    atEachSize: async () => {
      await expectWithinViewport(page, editButton(weekly, cards.weekly.title));
      await expectWithinViewport(page, deleteButton(weekly, cards.weekly.title));
      await expectNoHorizontalOverflow(page);
    }
  });

  const monitoring = cardOf(page, cards.monitoring.title);
  await expect(monitoring).toContainText("Every hour · Monitoring · Tools · Workspace");
  await expect(monitoring).toContainText("Next run Sun 4 Oct, 12:00");
  const otherZone = cardOf(page, cards.otherZone.title);
  await expect(otherZone).toContainText("Every Fri at 17:00 · America/New York");
  // The next run reads in the task's own zone.
  await expect(otherZone).toContainText("Next run Fri 9 Oct, 17:00");
  await captureState(page, info, "scheduled-card-monitoring-zone", {
    anchor: otherZone,
    atEachSize: async () => {
      await expectWithinViewport(page, deleteButton(otherZone, cards.otherZone.title));
      await expectNoHorizontalOverflow(page);
    }
  });

  const deleted = cardOf(page, cards.deleted.title);
  await expect(deleted.getByRole("status")).toHaveText("Scheduled task deleted");
  await expect(deleted).toHaveAttribute("data-state", "deleted");
  await expect(deleted).toContainText("Every day at 07:30");
  await expect(deleted).not.toContainText("Next run");
  await expect(deleted.getByRole("button")).toHaveCount(0);
  const paused = cardOf(page, cards.paused.title);
  await expect(paused.getByRole("status")).toHaveText("Scheduled task created");
  await expect(paused).toHaveAttribute("data-state", "paused");
  await expect(paused).toContainText("Paused");
  await expect(paused).not.toContainText("Next run");
  await expect(editButton(paused, cards.paused.title)).toBeVisible();
  await captureState(page, info, "scheduled-card-deleted-paused", {
    anchor: paused,
    atEachSize: async () => {
      await expectWithinViewport(page, deleteButton(paused, cards.paused.title));
      await expectNoHorizontalOverflow(page);
    }
  });
  // Reading the transcript writes nothing.
  expect(api.writes).toEqual([]);
});

test("Edit opens Studio › Scheduled on that task's editor", async ({ page }, info) => {
  const api = await prepare(page);
  const monitoring = cardOf(page, cards.monitoring.title);
  await editButton(monitoring, cards.monitoring.title).click();
  const sheet = page.getByTestId("scheduled-task-sheet");
  const dialog = sheet.getByRole("dialog", { name: "Edit scheduled task", exact: true });
  await expect(dialog).toBeVisible();
  // The modal editor hides the page behind it from the accessibility tree.
  await expect(page.getByTestId("library-v2").getByRole("tab", { includeHidden: true, name: "Scheduled" }))
    .toHaveAttribute("aria-selected", "true");
  await expect(sheet.getByLabel("Name", { exact: true })).toHaveValue(cards.monitoring.title);
  await expect(dialog.getByRole("group", { name: "Type", exact: true }).getByRole("radio", { name: "Monitoring", exact: true }))
    .toBeChecked();
  await captureState(page, info, "scheduled-card-edit-opens-editor", {
    atEachSize: async () => {
      await expectWithinViewport(page, dialog);
      await expectWithinViewport(page, sheet.getByRole("button", { name: "Save changes", exact: true }));
      await expectNoHorizontalOverflow(page);
    }
  });
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  expect(api.writes).toEqual([]);
});

test("Delete asks inline, deletes the task and the card then reads as deleted", async ({ page }, info) => {
  const api = await prepare(page);
  const title = cards.weekly.title;
  const weekly = cardOf(page, title);
  const confirm = weekly.getByRole("group", { name: `Delete ${title}`, exact: true });

  // Keep task closes the question and returns focus to Delete; nothing is sent.
  await deleteButton(weekly, title).click();
  await expect(confirm).toContainText(`Delete “${title}”? Its chats and answers stay in your history.`);
  await expect(confirm.getByRole("button", { name: "Keep task", exact: true })).toBeFocused();
  await expect(editButton(weekly, title)).toHaveCount(0);
  await captureState(page, info, "scheduled-card-delete-confirm", {
    anchor: confirm,
    atEachSize: async () => {
      await expectWithinViewport(page, confirm.getByRole("button", { name: "Delete task", exact: true }));
      await expectWithinViewport(page, confirm.getByRole("button", { name: "Keep task", exact: true }));
      await expectNoHorizontalOverflow(page);
    }
  });
  await confirm.getByRole("button", { name: "Keep task", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(deleteButton(weekly, title)).toBeFocused();
  expect(api.writes).toEqual([]);

  await deleteButton(weekly, title).click();
  await confirm.getByRole("button", { name: "Delete task", exact: true }).click();
  await expect(weekly.getByRole("status")).toHaveText("Scheduled task deleted");
  await expect(weekly).toHaveAttribute("data-state", "deleted");
  await expect(weekly.getByRole("status")).toBeFocused();
  await expect(weekly.getByRole("button")).toHaveCount(0);
  await expect(weekly).not.toContainText("Next run");
  expect(api.writes).toEqual([{ method: "DELETE", path: `/${cards.weekly.taskId}`, body: null }]);
  expect(api.tasks.map((entry) => entry.id)).not.toContain(cards.weekly.taskId);
  // The other cards keep their own state.
  await expect(cardOf(page, cards.monitoring.title)).toHaveAttribute("data-state", "active");
  await captureState(page, info, "scheduled-card-deleted-after-delete", {
    anchor: weekly,
    atEachSize: async () => {
      await expectWithinViewport(page, weekly.getByRole("status"));
      await expectNoHorizontalOverflow(page);
    }
  });
});

test("managed cards say what an answer changed, paused or proposed to delete, at every size in both themes", async ({ page }, info) => {
  const api = await prepare(page);
  const moved = cardOf(page, managed.moved.title);
  await expect(moved.getByRole("status")).toHaveText("Scheduled task changed");
  await expect(moved).toHaveAttribute("data-action", "changed");
  await expect(moved).toContainText("Every Mon, Wed, Fri at 10:00");
  await expect(moved).toContainText("Next run Mon 5 Oct, 10:00");
  await expect(editButton(moved, managed.moved.title)).toBeVisible();
  const stopped = cardOf(page, managed.stopped.title);
  await expect(stopped.getByRole("status")).toHaveText("Scheduled task paused");
  await expect(stopped).toHaveAttribute("data-state", "paused");
  await expect(stopped).toContainText("Paused");
  await expect(stopped).not.toContainText("Next run");
  await captureState(page, info, "scheduled-card-managed", {
    anchor: stopped,
    atEachSize: async () => {
      await expectWithinViewport(page, editButton(stopped, managed.stopped.title));
      await expectWithinViewport(page, deleteButton(stopped, managed.stopped.title));
      await expectNoHorizontalOverflow(page);
    }
  });

  // A proposal asks at once, without taking focus; its task stays until the owner answers.
  const proposal = cardOf(page, managed.proposal.title);
  const question = proposal.getByRole("group", { name: `Delete ${managed.proposal.title}`, exact: true });
  await expect(proposal.getByRole("status")).toHaveText("Deletion proposed");
  await expect(proposal).toContainText("Next run Mon 5 Oct, 08:00");
  await expect(question).toContainText(`Delete “${managed.proposal.title}”? Its chats and answers stay in your history.`);
  await expect(question.getByRole("button", { name: "Keep task", exact: true })).not.toBeFocused();
  await expect(editButton(proposal, managed.proposal.title)).toHaveCount(0);
  // A proposal whose task is already gone reads as deleted.
  const gone = cardOf(page, managed.proposalGone.title);
  await expect(gone.getByRole("status")).toHaveText("Scheduled task deleted");
  await expect(gone.getByRole("button")).toHaveCount(0);
  await captureState(page, info, "scheduled-card-delete-proposal", {
    anchor: proposal,
    atEachSize: async () => {
      await expectWithinViewport(page, question.getByRole("button", { name: "Delete task", exact: true }));
      await expectWithinViewport(page, question.getByRole("button", { name: "Keep task", exact: true }));
      await expectNoHorizontalOverflow(page);
    }
  });
  expect(api.writes).toEqual([]);
});

test("a deletion proposal deletes only on the owner's click, and Keep leaves the task", async ({ page }, info) => {
  const api = await prepare(page);
  const title = managed.proposal.title;
  let proposal = cardOf(page, title);
  let question = proposal.getByRole("group", { name: `Delete ${title}`, exact: true });
  await question.getByRole("button", { name: "Keep task", exact: true }).click();
  await expect(proposal.getByRole("status")).toHaveText("Scheduled task kept");
  await expect(proposal.getByRole("status")).toBeFocused();
  await expect(question).toHaveCount(0);
  await expect(editButton(proposal, title)).toBeVisible();
  await expect(deleteButton(proposal, title)).toBeVisible();
  expect(api.writes).toEqual([]);
  expect(api.tasks.map((entry) => entry.id)).toContain(managed.proposal.taskId);
  await captureState(page, info, "scheduled-card-proposal-kept", {
    anchor: proposal,
    atEachSize: async () => {
      await expectWithinViewport(page, deleteButton(proposal, title));
      await expectNoHorizontalOverflow(page);
    }
  });

  // Nothing records the decline: a reload asks again while the task exists, and Delete deletes it.
  await page.reload();
  await expect(page.getByTestId("scheduled-task-card")).toHaveCount(turns.length, { timeout: 30_000 });
  proposal = cardOf(page, title);
  question = proposal.getByRole("group", { name: `Delete ${title}`, exact: true });
  await expect(proposal.getByRole("status")).toHaveText("Deletion proposed");
  await question.getByRole("button", { name: "Delete task", exact: true }).click();
  await expect(proposal.getByRole("status")).toHaveText("Scheduled task deleted");
  await expect(proposal.getByRole("status")).toBeFocused();
  await expect(proposal.getByRole("button")).toHaveCount(0);
  expect(api.writes).toEqual([{ method: "DELETE", path: `/${managed.proposal.taskId}`, body: null }]);
  expect(api.tasks.map((entry) => entry.id)).not.toContain(managed.proposal.taskId);
  await captureState(page, info, "scheduled-card-proposal-deleted", {
    anchor: proposal,
    atEachSize: async () => {
      await expectWithinViewport(page, proposal.getByRole("status"));
      await expectNoHorizontalOverflow(page);
    }
  });
});

test.describe("touch controls", () => {
  test.use({ hasTouch: true });
  test("card actions and the delete question stay touch-safe in both phone orientations", async ({ page }, info) => {
    await prepare(page);
    const title = cards.weekly.title;
    const weekly = cardOf(page, title);
    const confirm = weekly.getByRole("group", { name: `Delete ${title}`, exact: true });
    for (const size of touchSizes) {
      await page.setViewportSize(size);
      await weekly.scrollIntoViewIfNeeded();
      for (const control of [editButton(weekly, title), deleteButton(weekly, title)]) {
        // A resized thread re-anchors to its newest turn: bring each control back.
        await control.scrollIntoViewIfNeeded();
        await expectTouchSafe(control);
        await expectWithinViewport(page, control);
      }
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath(`scheduled-card-touch-${size.width}x${size.height}.png`) });
      await deleteButton(weekly, title).click();
      for (const name of ["Delete task", "Keep task"]) {
        const control = confirm.getByRole("button", { name, exact: true });
        await control.scrollIntoViewIfNeeded();
        await expectTouchSafe(control);
        await expectWithinViewport(page, control);
      }
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath(`scheduled-card-confirm-touch-${size.width}x${size.height}.png`) });
      await confirm.getByRole("button", { name: "Keep task", exact: true }).click();
      await expect(confirm).toHaveCount(0);
    }
  });
});
