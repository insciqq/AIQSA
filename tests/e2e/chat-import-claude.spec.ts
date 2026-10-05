import { crc32 } from "node:zlib";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  editedConversation,
  exportIndex,
  regeneratedConversation
} from "../../features/chat-import/converters/claudeExport.testFixtures";
import { runAccountMenuAction } from "./shell/page";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { signInWithLocalToken } from "./support/localAuth";

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

const PREFIX = "E2E Claude import";

type ExportedChat = {
  chat: {
    activeLeafId: string | null;
    messages: Array<{ id: string; parentId: string | null; role: string; text: string }>;
  };
};
type ChatList = { chats: Array<{ id: string; title: string }> };

/** A stored (uncompressed) zip, the layout of Claude's conversations part. */
function storedZip(files: ReadonlyArray<{ path: string; content: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path);
    const data = Buffer.from(file.content);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const editedTitle = `${PREFIX} edited`;
const regeneratedTitle = `${PREFIX} regenerated`;
const conversationsPart = {
  buffer: storedZip([{
    content: JSON.stringify([
      { ...editedConversation, name: editedTitle },
      { ...regeneratedConversation, name: regeneratedTitle }
    ]),
    path: "conversations.json"
  }]),
  mimeType: "application/zip",
  name: "conversations-000.zip"
};

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

async function exportJson(page: Page, chatId: string): Promise<ExportedChat> {
  const response = await page.request.get(`/api/chats/${chatId}/export?format=json`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as ExportedChat;
}

async function cleanup(page: Page) {
  const response = await page.request.get("/api/chats");
  if (!response.ok()) return;
  for (const chat of ((await response.json()) as ChatList).chats.filter((candidate) => candidate.title.startsWith(PREFIX))) {
    await deleteOwnedChatPermanently(page.request, chat.id, { timeout: 10_000 });
  }
}

/** Picks the files in Settings → Data and returns the settled report. */
async function importFiles(page: Page, files: Parameters<Locator["setInputFiles"]>[0]): Promise<Locator> {
  await runAccountMenuAction(page, "Settings");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { exact: true, name: "Data" }).click();
  await settings.getByTestId("settings-import-input").setInputFiles(files);
  const report = settings.getByTestId("chat-import-report");
  await expect(report).toBeVisible({ timeout: 60_000 });
  return report;
}

async function closeSettings(page: Page) {
  await page.getByRole("button", { name: "Close settings" }).click();
}

test.beforeEach(async ({ page }) => {
  await signInWithLocalToken(page);
  await cleanup(page);
});

test.afterEach(async ({ page }) => {
  await cleanup(page);
});

test("the conversations part of a Claude export imports with its branches, links and notes", async ({ page }) => {
  const report = await importFiles(page, [conversationsPart]);
  await expect(report).toContainText("Import finished");
  await expect(report).toContainText("Imported 2 chats (8 messages).");
  await expect(report).toContainText("Not imported, marked in the messages: 1 attachment, 1 image, 6 tool activities, 1 artifact.");
  await closeSettings(page);

  // A regenerated answer is a sibling branch, and the newest answer is the one shown.
  const regeneratedId = await chatIdByTitle(page, regeneratedTitle);
  const regenerated = await exportJson(page, regeneratedId);
  const [question] = regenerated.chat.messages;
  expect(regenerated.chat.messages.filter((message) => message.parentId === question!.id).map((message) => message.text))
    .toEqual(["Blue.", "Green."]);
  expect(regenerated.chat.messages.find((message) => message.id === regenerated.chat.activeLeafId)?.text).toBe("Green.");

  // An edited first question is a second root; its answer is the open branch.
  const editedId = await chatIdByTitle(page, editedTitle);
  const edited = await exportJson(page, editedId);
  expect(edited.chat.messages.filter((message) => message.parentId === null)).toHaveLength(2);
  expect(edited.chat.messages.map((message) => message.text).join("\n"))
    .toContain("[example.org](https://www.example.org/sky)");

  await page.goto(`/c/${editedId}`);
  const thread = page.getByTestId("conversation-thread");
  await expect(thread).toContainText("Water, mostly.", { timeout: 30_000 });
  await expect(thread).toContainText("Tool activity not imported: bash_tool ×2");
  await expect(thread).toContainText("Artifact not imported: Sea plan");
  await expect(thread).toContainText("Files not included in the Claude export: sea_photo.png, report.pdf");
  await expect(page.getByTestId("header-import-source")).toHaveText("Imported from Claude");

  // The same part again creates nothing.
  const again = await importFiles(page, [conversationsPart]);
  await expect(again).toContainText("No new chats were imported.");
  await expect(again).toContainText("2 chats already imported.");
});

test("a lone export index says where the chats are and imports nothing", async ({ page }) => {
  const report = await importFiles(page, [{
    buffer: Buffer.from(`${JSON.stringify(exportIndex, null, 2)}\n`),
    mimeType: "application/json",
    name: "claude.json"
  }]);
  await expect(report).toContainText("No new chats were imported.");
  await expect(report.getByTestId("chat-import-failed")).toContainText(
    "claude.json — This is the export index; download the conversations part from the links in the export email (they expire after 24 hours)"
  );
  expect((await listChats(page)).filter((chat) => chat.title.startsWith(PREFIX))).toHaveLength(0);
});
