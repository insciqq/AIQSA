import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { ChatDetailWire, ChatMessageWire } from "../../lib/contracts/chats";
import type { ScheduledTask, ScheduledTaskRun } from "../../lib/contracts/scheduledTasks";
import type { WorkspaceSecretSummary } from "../../lib/contracts/workspaceSecrets";
import { matrixCatalog } from "./shell/catalog";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { runAccountMenuAction } from "./shell/page";
import { expectSignInRequestSent, recordMessagePosts } from "./support/browserSignInFixture";
import { createGatedRunStreamFixture } from "./support/gatedRunStream";
import { expectCenterUnobscured, expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

/**
 * Sign in again from Settings, on routed synthetic state: an automation whose last run failed because a site needed the
 * owner (its row and its run history), and a saved browser sign-in in Secrets. Each button leaves Settings for the chat
 * the request belongs in (the automation's chat, or a new chat for a saved sign-in), where the server-written request
 * goes out and shows as a chip naming the site. The owner API, the chats and the send are routed or gated in the page;
 * no provider or database is involved.
 */

const model = matrixCatalog.models[0]!;
const taskChatId = "sign-in-task-chat";
const newChatId = "sign-in-new-chat";
const timestamp = "2026-11-20T06:03:00.000Z";

const viewports = [
  { name: "desktop", width: 1440, height: 900, touch: false, theme: "light" },
  { name: "tablet", width: 820, height: 1180, touch: true, theme: "light" },
  { name: "phone", width: 390, height: 844, touch: true, theme: "light" },
  { name: "desktop-dark", width: 1440, height: 900, touch: false, theme: "dark" }
] as const;

function task(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: "task", title: "Task", prompt: "Synthetic scheduled instructions.",
    schedule: { kind: "daily", time: "07:00" }, scheduleEnabled: true, webhookEnabled: false, webhook: null, timeZone: "UTC",
    modelId: model.modelId, provider: model.provider, searchEnabled: false, emailNotify: false, telegramNotify: false,
    toolsEnabled: true, workspaceEnabled: true, memoryEnabled: false, pinnedSkillIds: [], pinnedSkills: [], chatMode: "same",
    kind: "standard", status: "active", pauseReason: null, historyRetentionDays: 90, historyDeletedChats: 0,
    historyNextDeletionAt: null, completionReason: null, nextRunAt: "2026-11-21T07:00:00.000Z", lastRun: null, running: false,
    chatId: null, unseenResult: false, revision: 1, createdAt: "2026-11-01T08:00:00.000Z", updatedAt: "2026-11-01T08:00:00.000Z",
    ...overrides
  };
}

const signInFailure = { state: "failed", reasonCode: "browser_sign_in_required", unseen: false } as const;

const tasks: readonly ScheduledTask[] = [
  task({ id: "inbox", title: "Inbox digest", chatId: taskChatId,
    lastRun: { ...signInFailure, scheduledFor: "2026-11-20T06:00:00.000Z", finishedAt: timestamp, signInHost: "mail.example.com" } }),
  // A failure that recorded no site keeps the way through the chat and offers no button.
  task({ id: "orders", title: "Order status check", chatId: "sign-in-orders-chat",
    lastRun: { ...signInFailure, scheduledFor: "2026-11-20T05:00:00.000Z", finishedAt: "2026-11-20T05:02:00.000Z" } })
];

const runs: readonly ScheduledTaskRun[] = [
  { id: "inbox-run-2", scheduledFor: "2026-11-20T06:00:00.000Z", trigger: "schedule", ...signInFailure,
    startedAt: "2026-11-20T06:00:04.000Z", finishedAt: timestamp, chatId: taskChatId, unavailableSources: [], skills: [],
    signInHost: "portal.example.org" },
  { id: "inbox-run-1", scheduledFor: "2026-11-19T06:00:00.000Z", trigger: "schedule", state: "completed", reasonCode: null,
    startedAt: "2026-11-19T06:00:03.000Z", finishedAt: "2026-11-19T06:01:30.000Z", chatId: taskChatId, unseen: false,
    unavailableSources: [], skills: [] }
];

const secrets: readonly WorkspaceSecretSummary[] = [
  { id: "31000000-0000-4000-8000-000000000001", versionId: "31000000-0000-4000-8000-000000000002", kind: "browser_session",
    name: "mail.example.com", description: "", byteSize: 4_096, updatedAt: "2026-11-18T10:00:00.000Z", envNames: [],
    originalName: "mail.example.com.json", sshProtected: false, browserSession: { autoSaved: true } },
  // An imported file whose name is no site: Sign in again has nothing to open.
  { id: "31000000-0000-4000-8000-000000000003", versionId: "31000000-0000-4000-8000-000000000004", kind: "browser_session",
    name: "Imported session", description: "", byteSize: 2_048, updatedAt: "2026-11-10T10:00:00.000Z", envNames: [],
    originalName: "manual_export.json", sshProtected: false, browserSession: { autoSaved: false } }
];

function message(id: string, role: "assistant" | "user", content: string, parentMessageId: string | null,
  extra: Partial<ChatMessageWire> = {}): ChatMessageWire {
  return { id, role, content, parentMessageId, createdAt: timestamp, status: "complete", citationMessageId: null, errorMessage: null,
    modelId: role === "assistant" ? model.modelId : null, modelRunId: null, provider: role === "assistant" ? model.provider : null, ...extra };
}

function chatDetail(id: string, title: string, messages: ChatMessageWire[]): ChatDetailWire {
  const leaf = messages.at(-1)?.id ?? null;
  return {
    assistant: null, id, title, createdAt: "2026-11-01T08:00:00.000Z", updatedAt: timestamp, activeLeafMessageId: leaf,
    defaultModelId: model.modelId, defaultProvider: model.provider, folderId: null, pinned: false, messageCount: messages.length,
    usageStats: null, contextStats: { approximateActiveBranchInputTokens: messages.length ? 300 : 0 },
    pageInfo: { activeLeafMessageId: leaf, beforeCursor: null, hasOlder: false, snapshotUpdatedAt: timestamp },
    workspace: { available: true, enabled: false, internetEnabled: false, sessionState: null },
    messages
  };
}

/** The automation's chat: its latest scheduled turn, whose answer says the site needs the owner. */
const taskChat = chatDetail(taskChatId, "Inbox digest", [
  message("inbox-question", "user", "Summarize the new mail in my inbox.", null,
    { scheduledTask: { taskId: "inbox", taskRunId: "inbox-run-2", title: "Inbox digest", unseen: false } }),
  message("inbox-answer", "assistant", "mail.example.com asked me to sign in again, so I could not read the inbox.", "inbox-question")
]);

async function prepare(page: Page, testInfo: TestInfo, theme: "light" | "dark") {
  await page.context().addCookies([{ name: "aiqsa.theme", value: theme, url: testInfo.project.use.baseURL! }]);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installMatrixCatalogFixture(page, { chats: [taskChat], folders: [] });
  await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));
  await page.route("**/api/workspace", (route) => route.fulfill({ json: { workspace: {
    available: true, enabled: false, internetEnabled: false, sessionState: null
  } } }));
  await page.route("**/api/chats/compact?*", (route) => route.fulfill({ json: {
    chats: [{ activeRun: false, assistant: null, folderId: null, id: taskChatId, title: taskChat.title, updatedAt: taskChat.updatedAt,
      scheduledTask: { taskId: "inbox", unseen: false } }],
    folders: [], nextCursor: null
  } }));
  // A saved sign-in's request starts a new chat: the create and its first read are answered here.
  const created = chatDetail(newChatId, "New chat", []);
  const { messages: _messages, ...createdSummary } = created;
  const creates: unknown[] = [];
  await page.route("**/api/chats", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    creates.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, json: { chat: createdSummary } });
  });
  for (const chat of [taskChat, created]) {
    await page.route(`**/api/chats/${chat.id}`, (route) => route.request().method() === "GET"
      ? route.fulfill({ json: { chat } }) : route.fallback());
    await page.route(`**/api/chats/${chat.id}/branches`, (route) => route.fulfill({ json: { branchGraph: {
      activeLeafMessageId: chat.activeLeafMessageId, snapshotUpdatedAt: chat.updatedAt,
      nodes: chat.messages.map((item) => ({ id: item.id, parentMessageId: item.parentMessageId, preview: String(item.content),
        role: item.role, status: item.status }))
    } } }));
  }
  await page.route(/\/api\/me\/scheduled-tasks(\/[^?]*)?(\?.*)?$/u, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api\/me\/scheduled-tasks/u, "");
    if (!path && request.method() === "GET") {
      return route.fulfill({ json: { tasks, limits: { maxActive: 10, maxActiveHourly: 3, maxTotal: 50 },
        emailAvailable: false, telegramAvailable: false } });
    }
    const [, id, action] = path.split("/");
    const current = tasks.find((entry) => entry.id === id);
    if (!current) return route.fulfill({ status: 404, json: { error: "scheduled_task_not_found" } });
    if (action === "seen") return route.fulfill({ status: 204, body: "" });
    if (request.method() === "GET" && !action) {
      return route.fulfill({ json: { task: current, recentRuns: current.id === "inbox" ? runs : [] } });
    }
    return route.fulfill({ status: 409, json: { error: "unexpected_scheduled_task_write" } });
  });
  await page.route("**/api/me/workspace/secrets", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { secrets } }) : route.fulfill({ status: 409, json: { error: "unexpected_secret_write" } }));
  const taskStream = createGatedRunStreamFixture({ key: "sign-in-task-chat", abortMessage: "Synthetic stream stopped",
    notReadyError: "sign_in_task_stream_not_ready" });
  await taskStream.install(page, taskChatId);
  const newStream = createGatedRunStreamFixture({ key: "sign-in-new-chat", abortMessage: "Synthetic stream stopped",
    notReadyError: "sign_in_new_stream_not_ready" });
  await newStream.install(page, newChatId);
  await recordMessagePosts(page);
  // A missed fixture must fail before it can dispatch a provider request.
  await page.route("**/api/chats/*/messages", (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 409, json: { error: "unexpected_fixture_run" } }) : route.fallback());
  await signInWithLocalToken(page, "/");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({ timeout: 30_000 });
  return { creates, newStream, taskStream };
}

/** A viewport shot (never an element shot taller than the viewport: Chromium then drops touch emulation) around `target`. */
async function shot(page: Page, testInfo: TestInfo, name: string, target: Locator) {
  await target.evaluate((element) => element.scrollIntoView({ behavior: "instant", block: "center" }));
  await page.waitForTimeout(150);
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

/** A button the person can see, reach and press: inside the window, not under another layer. */
async function expectReachable(page: Page, button: Locator) {
  await button.evaluate((element) => element.scrollIntoView({ behavior: "instant", block: "center" }));
  await expectWithinViewport(page, button);
  await expectCenterUnobscured(button);
  await expect(button).toBeEnabled();
}

for (const viewport of viewports) {
  test.describe(`${viewport.name}`, () => {
    test.use({ hasTouch: viewport.touch, isMobile: viewport.touch, viewport: { width: viewport.width, height: viewport.height } });

    test(`an automation row's Sign in again opens its chat with the request at ${viewport.width}x${viewport.height} ${viewport.theme}`,
      async ({ page }, testInfo) => {
        test.setTimeout(120_000);
        const { taskStream } = await prepare(page, testInfo, viewport.theme);
        await runAccountMenuAction(page, "Automations");
        const panel = page.getByTestId("scheduled-tasks-panel");
        const list = panel.getByRole("list", { name: "Automations" });
        const inbox = list.getByRole("listitem").filter({ hasText: "Inbox digest" });
        const orders = list.getByRole("listitem").filter({ hasText: "Order status check" });
        await expect(inbox).toContainText(/Failed: mail\.example\.com needs you to sign in again/u);
        await expect(panel).not.toContainText("browser_sign_in_required");
        // Without a recorded site the row keeps the way through the chat and offers no button.
        await expect(orders.getByRole("button", { name: /^Sign in again/u })).toHaveCount(0);
        const signIn = inbox.getByRole("button", { name: "Sign in again to mail.example.com", exact: true });
        // It sits above the title's hit area, which covers the rest of the row's text.
        await expectReachable(page, signIn);
        const rowBox = (await inbox.boundingBox())!;
        const buttonBox = (await signIn.boundingBox())!;
        expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
        // Focus order: the title, then Sign in again, then the row's switch.
        await inbox.getByRole("button", { name: "Open chat for Inbox digest", exact: true }).focus();
        await page.keyboard.press("Tab");
        await expect(signIn).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(inbox.getByRole("switch")).toBeFocused();
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await expectNoHorizontalOverflow(page);
        await shot(page, testInfo, `wave-sign-in-automation-row-${viewport.name}`, inbox);

        await signIn.click();
        await expect(page.getByTestId("library-v2")).toBeHidden();
        await taskStream.waitForRequestCount(page, 1);
        await expectSignInRequestSent(page, taskChatId, "mail.example.com");
        await expect(page.getByText("mail.example.com asked me to sign in again, so I could not read the inbox.")).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await shot(page, testInfo, `wave-sign-in-automation-sent-${viewport.name}`,
          page.getByRole("article", { name: "Sign in again", exact: true }).last());
      });

    test(`a failed run's Sign in again in the run history at ${viewport.width}x${viewport.height} ${viewport.theme}`,
      async ({ page }, testInfo) => {
        test.setTimeout(120_000);
        const { taskStream } = await prepare(page, testInfo, viewport.theme);
        await runAccountMenuAction(page, "Automations");
        const panel = page.getByTestId("scheduled-tasks-panel");
        await panel.getByRole("button", { name: "More actions for Inbox digest", exact: true }).click();
        await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
        const sheet = page.getByTestId("scheduled-task-sheet");
        await expect(sheet.getByRole("dialog", { name: "Edit automation", exact: true })).toBeVisible();
        const history = sheet.getByRole("region", { name: "Recent runs", exact: true });
        const rows = history.getByRole("listitem");
        await expect(rows).toHaveCount(2);
        await expect(rows.nth(0)).toContainText("Failed: portal.example.org needs you to sign in again");
        // The failed run offers Sign in again in place of Open chat; the answered one keeps Open chat.
        await expect(rows.nth(0).getByRole("button", { name: /^Open chat/u })).toHaveCount(0);
        await expect(rows.nth(1).getByRole("button", { name: /^Open chat from/u })).toHaveCount(1);
        const signIn = rows.nth(0).getByRole("button", { name: "Sign in again to portal.example.org", exact: true });
        await expectReachable(page, signIn);
        const [rowBox, buttonBox] = await Promise.all([rows.nth(0).boundingBox(), signIn.boundingBox()]);
        expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width + 1);
        await expectNoHorizontalOverflow(page);
        await shot(page, testInfo, `wave-sign-in-run-history-${viewport.name}`, history);

        // It leaves the editor and Settings for the run's chat, where the request goes out.
        await signIn.click();
        await expect(sheet).toHaveCount(0);
        await expect(page.getByTestId("library-v2")).toBeHidden();
        await taskStream.waitForRequestCount(page, 1);
        await expectSignInRequestSent(page, taskChatId, "portal.example.org");
      });

    test(`a saved sign-in's Sign in again in Secrets starts a new chat at ${viewport.width}x${viewport.height} ${viewport.theme}`,
      async ({ page }, testInfo) => {
        test.setTimeout(120_000);
        const { creates, newStream } = await prepare(page, testInfo, viewport.theme);
        await runAccountMenuAction(page, "Secrets");
        const panel = page.getByTestId("workspace-secrets-panel");
        const list = panel.getByRole("list", { name: "Saved Workspace secrets" });
        const saved = list.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "mail.example.com", exact: true }) });
        const imported = list.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Imported session", exact: true }) });
        await expect(saved).toContainText("Saved by Workspace");
        await expect(imported.getByRole("button", { name: /^Sign in again/u })).toHaveCount(0);
        const signIn = saved.getByRole("button", { name: "Sign in again to mail.example.com", exact: true });
        await expectReachable(page, signIn);
        const [rowBox, buttonBox] = await Promise.all([saved.boundingBox(), signIn.boundingBox()]);
        expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width + 1);
        // Focus order: Sign in again comes before the session's Edit.
        await signIn.focus();
        await page.keyboard.press("Tab");
        await expect(saved.getByRole("button", { name: "Edit mail.example.com", exact: true })).toBeFocused();
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await expectNoHorizontalOverflow(page);
        await shot(page, testInfo, `wave-sign-in-secrets-${viewport.name}`, saved);

        await signIn.click();
        await expect(page.getByTestId("library-v2")).toBeHidden();
        await expect.poll(() => creates.length).toBe(1);
        await newStream.waitForRequestCount(page, 1);
        await expectSignInRequestSent(page, newChatId, "mail.example.com");
        await expectNoHorizontalOverflow(page);
        await shot(page, testInfo, `wave-sign-in-secrets-sent-${viewport.name}`,
          page.getByRole("article", { name: "Sign in again", exact: true }).last());
      });
  });
}
