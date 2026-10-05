import { deflateRawSync } from "node:zlib";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { runAccountMenuAction } from "./shell/page";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { signInWithLocalToken } from "./support/localAuth";

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

const PREFIX = "E2E ChatGPT import";
const T0 = 1_757_000_000;

type ChatList = { chats: Array<{ id: string; title: string }> };
type ExportDocument = {
  chat: {
    activeLeafId: string | null;
    pinned: boolean;
    messages: Array<{ id: string; parentId: string | null; role: string; text: string }>;
  };
};

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/** A deflate zip of the given files, as ChatGPT's export download is. */
function zip(files: ReadonlyArray<{ path: string; content: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const raw = Buffer.from(file.content);
    const data = deflateRawSync(raw);
    const name = Buffer.from(file.path);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
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

function message(role: string, content: Record<string, unknown>, time: number, metadata: Record<string, unknown> = {}) {
  return { author: { role }, content, create_time: T0 + time, id: `msg-${role}-${time}`, metadata, recipient: "all" };
}

const text = (value: string) => ({ content_type: "text", parts: [value] });
const marker = "\ue200cite\ue202turn0search0\ue201";

/** An edited first question (two roots), a regenerated answer and a web citation. */
function branchedConversation() {
  return {
    conversation_id: "e2e-chatgpt-branches",
    create_time: T0,
    current_node: "a1r",
    default_model_slug: "gpt-synthetic",
    id: "e2e-chatgpt-branches",
    is_archived: false,
    is_starred: true,
    mapping: {
      root: { id: "root", message: null, parent: null },
      u1: { id: "u1", message: message("user", text(`${PREFIX} question`), 10), parent: "root" },
      a1: { id: "a1", message: message("assistant", text("First answer"), 11), parent: "u1" },
      a1r: {
        id: "a1r",
        message: message("assistant", text(`Regenerated answer ${marker}.`), 12, {
          content_references: [{
            items: [{ title: "Synthetic source", url: "https://example.com/source" }],
            matched_text: marker,
            start_idx: 19,
            type: "grouped_webpages"
          }]
        }),
        parent: "u1"
      },
      u1b: { id: "u1b", message: message("user", text(`${PREFIX} question, edited`), 20), parent: "root" },
      a1b: { id: "a1b", message: message("assistant", text("Answer to the edited question"), 21), parent: "u1b" }
    },
    title: `${PREFIX} branches`,
    update_time: T0 + 30
  };
}

function imageConversation() {
  return {
    conversation_id: "e2e-chatgpt-image",
    create_time: T0 + 100,
    current_node: "a1",
    id: "e2e-chatgpt-image",
    mapping: {
      root: { id: "root", message: null, parent: null },
      u1: {
        id: "u1",
        message: message("user", {
          content_type: "multimodal_text",
          parts: [{ asset_pointer: "file-service://file-e2e", content_type: "image_asset_pointer" }, "Describe this"]
        }, 101),
        parent: "root"
      },
      a1: { id: "a1", message: message("assistant", text("A synthetic picture"), 102), parent: "u1" }
    },
    title: `${PREFIX} image`,
    update_time: T0 + 110
  };
}

function emptyConversation() {
  return {
    conversation_id: "e2e-chatgpt-empty",
    create_time: T0 + 200,
    id: "e2e-chatgpt-empty",
    mapping: { root: { id: "root", message: null, parent: null } },
    title: `${PREFIX} empty`,
    update_time: T0 + 200
  };
}

function exportZip(): Buffer {
  return zip([
    {
      content: JSON.stringify({
        export_files: [{ path: "conversations-000.json", size_bytes: 1 }, { path: "conversations-001.json", size_bytes: 1 }],
        logical_files: [{ files: ["conversations-000.json", "conversations-001.json"], name: "conversations.json" }],
        version: 1
      }),
      path: "export_manifest.json"
    },
    { content: "<html>synthetic</html>", path: "chat.html" },
    { content: JSON.stringify([branchedConversation(), emptyConversation()]), path: "conversations-000.json" },
    { content: JSON.stringify([imageConversation()]), path: "conversations-001.json" },
    { content: "{}", path: "user.json" }
  ]);
}

async function listChats(page: Page): Promise<ChatList["chats"]> {
  const response = await page.request.get("/api/chats");
  expect(response.ok()).toBe(true);
  return ((await response.json()) as ChatList).chats;
}

async function cleanup(page: Page) {
  for (const chat of (await listChats(page)).filter((candidate) => candidate.title.startsWith(PREFIX))) {
    await deleteOwnedChatPermanently(page.request, chat.id, { timeout: 10_000 });
  }
}

async function importZip(page: Page): Promise<Locator> {
  await runAccountMenuAction(page, "Settings");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { exact: true, name: "Data" }).click();
  await settings.getByTestId("settings-import-input").setInputFiles({ buffer: exportZip(), mimeType: "application/zip", name: "chatgpt-export.zip" });
  const report = settings.getByTestId("chat-import-report");
  await expect(report).toBeVisible({ timeout: 60_000 });
  return report;
}

test.beforeEach(async ({ page }) => {
  await signInWithLocalToken(page);
  await cleanup(page);
});

test.afterEach(async ({ page }) => {
  await cleanup(page);
});

test("a sharded ChatGPT export imports with branches, citation links and counted images, once", async ({ page }) => {
  const report = await importZip(page);
  await expect(report).toContainText("Import finished");
  // Branches: question, two sibling answers (a branch, never merged), edited question, its answer; image chat: 2.
  await expect(report).toContainText("Imported 2 chats (7 messages).");
  await expect(report).toContainText("Not imported, marked in the messages: 1 image, 1 empty chat.");
  await page.getByRole("button", { name: "Close settings" }).click();

  const branched = (await listChats(page)).find((chat) => chat.title === `${PREFIX} branches`);
  expect(branched).toBeTruthy();
  const exported = (await (await page.request.get(`/api/chats/${branched!.id}/export?format=json`)).json()) as ExportDocument;
  const { messages } = exported.chat;
  expect(messages.filter((item) => item.parentId === null)).toHaveLength(2);
  const leaf = messages.find((item) => item.id === exported.chat.activeLeafId);
  expect(leaf?.text).toBe("Regenerated answer ([Synthetic source](https://example.com/source)).");
  expect(messages.every((item) => !/[\ue200-\ue2ff]/u.test(item.text))).toBe(true);
  expect(exported.chat.pinned).toBe(true);

  await page.goto(`/c/${branched!.id}`);
  await expect(page.getByTestId("header-import-source")).toHaveText("Imported from ChatGPT");
  await expect(page.getByTestId("conversation-thread").getByRole("link", { name: "Synthetic source" })).toBeVisible({ timeout: 30_000 });

  // The same archive again creates nothing.
  const again = await importZip(page);
  await expect(again).toContainText("No new chats were imported.");
  await expect(again).toContainText("2 chats already imported.");
  expect((await listChats(page)).filter((chat) => chat.title.startsWith(PREFIX))).toHaveLength(2);
});
