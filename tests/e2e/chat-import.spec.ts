import { gzipSync } from "node:zlib";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { runAccountMenuAction } from "./shell/page";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { activeChatId, selectFakeModel, sendAndExpect, startNewChat } from "./support/workspace";

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

const PREFIX = "E2E import";

type ExportMessage = {
  id: string;
  parentId: string | null;
  role: "assistant" | "user";
  createdAt: string;
  status: string;
  text: string;
  model?: unknown;
  attachments?: unknown;
};
type ExportDocument = {
  format: "aiqsa.chat";
  version: 1;
  exportedAt: string;
  chat: {
    title: string;
    createdAt: string;
    updatedAt: string;
    archived: boolean;
    pinned: boolean;
    activeLeafId: string | null;
    messages: ExportMessage[];
  };
};
type ChatList = { chats: Array<{ id: string; title: string }> };

/** A first question edited once (two roots) and an answer with a flattened follow-up, as export v1 writes it. */
function syntheticDocument(title: string, answerText = "Synthetic final answer"): ExportDocument {
  return {
    format: "aiqsa.chat",
    version: 1,
    exportedAt: "2026-10-01T00:00:00.000Z",
    chat: {
      activeLeafId: "m4",
      archived: false,
      createdAt: "2026-09-01T09:59:00.000Z",
      messages: [
        { createdAt: "2026-09-01T10:00:00.000Z", id: "m1", parentId: null, role: "user", status: "complete", text: `${title} question` },
        { createdAt: "2026-09-01T10:01:00.000Z", id: "m2", parentId: "m1", role: "assistant", status: "complete", text: "Partial answer before follow-up:\n\nDraft" },
        { createdAt: "2026-09-01T10:03:00.000Z", id: "m3", parentId: "m2", role: "user", status: "complete", text: "Follow-up 1:\n\nPlease add detail" },
        { createdAt: "2026-09-01T10:02:00.000Z", id: "m4", parentId: "m3", role: "assistant", status: "complete", text: answerText },
        { createdAt: "2026-09-01T11:00:00.000Z", id: "m5", parentId: null, role: "user", status: "complete", text: `${title} edited question` }
      ],
      pinned: false,
      title,
      updatedAt: "2026-09-02T10:00:00.000Z"
    }
  };
}

function jsonFile(name: string, value: unknown) {
  return { buffer: Buffer.from(`${JSON.stringify(value, null, 2)}\n`), mimeType: "application/json", name };
}

/** A ustar archive of the given files, gzip-compressed like the bulk export. */
function tarGz(files: ReadonlyArray<{ path: string; content: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const data = Buffer.from(file.content);
    const header = Buffer.alloc(512);
    header.write(file.path, 0, 100, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.fill(0x20, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** What the import must restore: titles, texts, tree shape, active leaf and dates. */
function restoredShape(document: ExportDocument) {
  const positions = new Map(document.chat.messages.map((message, index) => [message.id, index]));
  return {
    activeLeaf: document.chat.activeLeafId === null ? null : positions.get(document.chat.activeLeafId),
    archived: document.chat.archived,
    createdAt: document.chat.createdAt,
    messages: document.chat.messages.map((message) => [
      message.parentId === null ? -1 : positions.get(message.parentId), message.role, message.createdAt, message.text
    ]),
    pinned: document.chat.pinned,
    title: document.chat.title,
    updatedAt: document.chat.updatedAt
  };
}

async function signIn(page: Page) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/u);
  const response = await page.request.post("/api/auth/token", { data: { token: "aiqsa-test-token" } });
  expect(response.ok()).toBe(true);
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
}

async function listChats(page: Page): Promise<ChatList["chats"]> {
  const response = await page.request.get("/api/chats");
  expect(response.ok()).toBe(true);
  return ((await response.json()) as ChatList).chats;
}

async function chatIdByTitle(page: Page, title: string): Promise<string> {
  const chat = (await listChats(page)).find((candidate) => candidate.title === title);
  expect(chat, `imported chat "${title}"`).toBeTruthy();
  return chat!.id;
}

async function exportJson(page: Page, chatId: string): Promise<ExportDocument> {
  const response = await page.request.get(`/api/chats/${chatId}/export?format=json`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as ExportDocument;
}

async function cleanupImportChats(page: Page) {
  const response = await page.request.get("/api/chats");
  if (!response.ok()) return;
  for (const chat of ((await response.json()) as ChatList).chats.filter((candidate) => candidate.title.startsWith(PREFIX))) {
    await deleteOwnedChatPermanently(page.request, chat.id, { timeout: 10_000 });
  }
}

async function openDataSettings(page: Page): Promise<Locator> {
  await runAccountMenuAction(page, "Settings");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { exact: true, name: "Data" }).click();
  await expect(settings.getByTestId("settings-import-chats")).toBeVisible();
  return settings;
}

/** Picks the files in Settings → Data and returns the settled report. */
async function importFiles(page: Page, files: Parameters<Locator["setInputFiles"]>[0]): Promise<Locator> {
  const settings = await openDataSettings(page);
  await settings.getByTestId("settings-import-input").setInputFiles(files);
  const report = settings.getByTestId("chat-import-report");
  await expect(report).toBeVisible({ timeout: 60_000 });
  return report;
}

async function closeSettings(page: Page) {
  await page.getByRole("button", { name: "Close settings" }).click();
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await cleanupImportChats(page);
});

test.afterEach(async ({ page }) => {
  await cleanupImportChats(page);
});

test("export, delete and import restores titles, texts, branches, active leaf and dates", async ({ page }) => {
  // A real chat with an edited first question: two roots, each answered by the fake provider.
  await startNewChat(page);
  await selectFakeModel(page);
  const prompt = `${PREFIX} round trip question`;
  await sendAndExpect(page, prompt, `Fake answer: ${prompt}`);
  const chatId = await activeChatId(page);
  const question = page.locator('article[data-role="user"]').last();
  await question.hover();
  await question.getByRole("button", { name: "Edit question" }).click();
  const editor = question.getByTestId("inline-message-edit-v2").getByRole("textbox", { name: "Edit question" });
  await editor.fill(`${prompt} (edited)`);
  await editor.press("Enter");
  await expect(page.getByTestId("conversation-thread")).toContainText(`Fake answer: ${prompt} (edited)`, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 30_000 });
  const title = `${PREFIX} native chat`;
  expect((await page.request.patch(`/api/chats/${chatId}`, { data: { title } })).ok()).toBe(true);
  const native = await exportJson(page, chatId);
  expect(native.chat.messages.filter((message) => message.parentId === null)).toHaveLength(2);
  await deleteOwnedChatPermanently(page.request, chatId);
  await expect.poll(async () => (await listChats(page)).some((chat) => chat.id === chatId)).toBe(false);

  const followup = syntheticDocument(`${PREFIX} follow-up chat`);
  const files = [jsonFile("native.json", native), jsonFile("follow-up.json", followup)];
  const report = await importFiles(page, files);
  await expect(report).toContainText("Import finished");
  await expect(report).toContainText(`Imported 2 chats (${native.chat.messages.length + followup.chat.messages.length} messages).`);
  await closeSettings(page);

  for (const source of [native, followup]) {
    const imported = await exportJson(page, await chatIdByTitle(page, source.chat.title));
    expect(restoredShape(imported)).toEqual(restoredShape(source));
    expect(imported.chat.messages.every((message) => message.model === undefined)).toBe(true);
  }

  // The same files again create nothing.
  const again = await importFiles(page, files);
  await expect(again).toContainText("No new chats were imported.");
  await expect(again).toContainText("2 chats already imported.");
  expect((await listChats(page)).filter((chat) => chat.title.startsWith(PREFIX))).toHaveLength(2);
});

test("a chat over 1 MiB imports and one over the request limit is reported as too large", async ({ page }) => {
  const large = syntheticDocument(`${PREFIX} large chat`, "L".repeat(700_000));
  large.chat.messages[0]!.text = "Q".repeat(700_000);
  const huge = syntheticDocument(`${PREFIX} huge chat`, "H".repeat(900_000));
  for (const message of huge.chat.messages) message.text = "H".repeat(900_000);
  huge.chat.messages.push(...Array.from({ length: 6 }, (_, index) => ({
    createdAt: "2026-09-01T12:00:00.000Z", id: `x${index}`, parentId: index === 0 ? "m4" : `x${index - 1}`,
    role: (index % 2 ? "assistant" : "user") as "assistant" | "user", status: "complete", text: "H".repeat(900_000)
  })));
  const small = syntheticDocument(`${PREFIX} small chat`);
  const report = await importFiles(page, [jsonFile("large.json", large), jsonFile("huge.json", huge), jsonFile("small.json", small)]);
  await expect(report).toContainText("Imported 2 chats");
  await expect(report.getByTestId("chat-import-failed")).toContainText(`${PREFIX} huge chat — Too large to import (over 8 MB)`);
  await closeSettings(page);
  const imported = await exportJson(page, await chatIdByTitle(page, large.chat.title));
  expect(imported.chat.messages[0]!.text).toHaveLength(700_000);
});

test("a bulk archive imports with visible progress and reports a malformed chat", async ({ page }, testInfo) => {
  const names = Array.from({ length: 30 }, (_, index) => `chat-${String(index + 1).padStart(2, "0")}`);
  const manifest = {
    format: "aiqsa.chat-archive",
    version: 1,
    exportedAt: "2026-10-01T00:00:00.000Z",
    chats: [...names, "broken"].map((name) => ({
      archived: false, markdownPath: `${name}.md`, path: `${name}.json`, title: `${PREFIX} ${name}`, updatedAt: "2026-09-02T10:00:00.000Z"
    }))
  };
  const archive = tarGz([
    { content: JSON.stringify(manifest), path: "manifest.json" },
    ...names.flatMap((name) => [
      { content: `# ${name}\n`, path: `${name}.md` },
      { content: JSON.stringify(syntheticDocument(`${PREFIX} ${name}`)), path: `${name}.json` }
    ]),
    { content: "{ \"format\": \"aiqsa.chat\", broken", path: "broken.json" }
  ]);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  await page.route("**/api/me/chats/import", async (route) => {
    if (first) {
      first = false;
      await held;
    }
    await route.continue();
  });
  const settings = await openDataSettings(page);
  await settings.getByTestId("settings-import-input").setInputFiles({ buffer: archive, mimeType: "application/gzip", name: "aiqsa-chats.tar.gz" });
  await expect(settings.getByRole("progressbar", { name: "Chats processed" })).toBeVisible({ timeout: 30_000 });
  await expect(settings.getByText(/^Importing chats: \d+ of 31$/u)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("import-progress-desktop.png") });
  release();
  const report = settings.getByTestId("chat-import-report");
  await expect(report).toBeVisible({ timeout: 60_000 });
  await expect(report).toContainText("Imported 30 chats (150 messages).");
  await expect(report.getByTestId("chat-import-failed")).toContainText(`${PREFIX} broken — Not a readable export file`);
  await page.screenshot({ path: testInfo.outputPath("import-report-desktop.png") });
});

test("an imported chat continues with the current model, edits and regenerates, and never uses Memory", async ({ page }) => {
  const title = `${PREFIX} continued chat`;
  const report = await importFiles(page, [jsonFile("continued.json", syntheticDocument(title))]);
  await expect(report).toContainText("Imported 1 chat");
  await closeSettings(page);
  const chatId = await chatIdByTitle(page, title);

  const memory = await page.request.get(`/api/me/chats/${chatId}/memory-mode`);
  expect(await memory.json()).toEqual({ allowedActions: [], archived: false, lockedReason: "IMPORTED", mode: "EXCLUDED", temporaryRetentionDeadline: null });
  const resume = await page.request.patch(`/api/me/chats/${chatId}/memory-mode`, {
    data: { mode: "NORMAL", resumeDisclosureCopyVersion: "memory-confirmation-v1" }
  });
  expect(resume.status()).toBe(409);
  expect(await resume.json()).toEqual({ error: "memory_imported_chat_forbidden" });

  await page.goto(`/c/${chatId}`);
  await expect(page.getByTestId("conversation-thread")).toContainText("Synthetic final answer", { timeout: 30_000 });
  await expect(page.getByTestId("header-import-source")).toHaveText("Imported from AIQSA");
  await page.getByTestId("header-more-trigger").click();
  const memoryItem = page.getByTestId("header-more-menu").getByRole("menuitem", { name: /Resume Memory for this chat/u });
  await expect(memoryItem).toBeDisabled();
  await expect(memoryItem).toContainText("Imported chats don't use Memory");
  await page.keyboard.press("Escape");

  await selectFakeModel(page);
  // Regenerating an imported answer runs the normal pipeline with the current model.
  const answer = page.locator('article[data-role="assistant"]').last();
  await answer.hover();
  await answer.getByRole("button", { name: "Regenerate answer" }).click();
  await expect(page.getByTestId("conversation-thread")).toContainText("Fake answer: Follow-up 1:", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 30_000 });

  const followUp = `${PREFIX} new question in the imported chat`;
  await sendAndExpect(page, followUp, `Fake answer: ${followUp}`);
  expect((await page.request.get(`/api/me/chats/${chatId}/memory-mode`).then((response) => response.json())).mode).toBe("EXCLUDED");
});

for (const viewport of [
  { height: 900, name: "desktop", width: 1440 },
  { height: 1112, name: "tablet", width: 834 },
  { height: 844, name: "phone", width: 390 }
]) {
  test(`the import row, progress and report fit the ${viewport.name} layout`, async ({ page }, testInfo) => {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });
    await page.reload();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/me/chats/import", async (route) => {
      await held;
      await route.continue();
    });
    const settings = await openDataSettings(page);
    await page.screenshot({ path: testInfo.outputPath(`import-row-${viewport.name}.png`) });
    await settings.getByTestId("settings-import-input").setInputFiles([
      jsonFile("one.json", syntheticDocument(`${PREFIX} ${viewport.name} one`)),
      jsonFile("notes.json", { notes: "not an export" })
    ]);
    await expect(settings.getByTestId("chat-import-progress")).toBeVisible({ timeout: 30_000 });
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`import-progress-${viewport.name}.png`) });
    release();
    const report = settings.getByTestId("chat-import-report");
    await expect(report).toBeVisible({ timeout: 60_000 });
    await expect(report).toContainText("Imported 1 chat (5 messages).");
    await expect(report.getByTestId("chat-import-failed")).toContainText("notes.json — Not a supported export file");
    await expectNoHorizontalOverflow(page);
    await report.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`import-report-${viewport.name}.png`) });
    await report.getByRole("button", { name: "Done" }).click();
    await expect(report).toHaveCount(0);
  });
}
