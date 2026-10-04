import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { Prisma, PrismaClient } from "@prisma/client";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { ChatDetailWire, ChatMessageWire } from "../../lib/contracts/chats";
import { runtimeSecurityHeaders } from "../../lib/server/security/headers";
import { LOCAL_OPERATOR_EMAIL } from "../../prisma/local-seed-auth";
import { matrixCatalog } from "./shell/catalog";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { authenticateWithLocalToken, signInWithLocalToken } from "./support/localAuth";
import { createPeopleFixture } from "./support/people";

/**
 * "PDF" in the chat menu opens a shell-free print page of the whole visible
 * branch, which prints once after highlighting, math, diagrams, images and
 * fonts settle. The chat lives in the database so the server-rendered print
 * page reads it exactly as a user's chat; the opener's shell uses the
 * catalog fixture. The print document is re-served with the production CSP in
 * report-only mode, so policy violations are observed without breaking the
 * dev runtime.
 */
const PRODUCTION_CSP = runtimeSecurityHeaders({
  AIQSA_APP_BASE_URL: "https://aiqsa.example.test",
  NODE_ENV: "production"
})["Content-Security-Policy"]!;

// A document fulfilled by Playwright otherwise loses the dev HMR socket (see mermaid-diagrams.spec.ts).
test.use({ launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] } });
test.describe.configure({ mode: "serial" });

const prisma = new PrismaClient();
const TITLE = "Печать: отчёт о релизе";
const FIRST_TEXT = "Самое первое сообщение: начнём с плана релиза";
const MESSAGE_COUNT = 56; // more than one thread page (50)
const LAST_ANSWER = [
  "Итоговый ответ с формулой, кодом, таблицей и схемой.",
  "",
  "$$",
  String.raw`E = mc^2`,
  "$$",
  "",
  "```ts",
  "export const release = { version: \"1.4.0\", ready: true };",
  "```",
  "",
  "| Этап | Статус |",
  "| --- | --- |",
  "| Миграции | готово |",
  "| Smoke | в работе |",
  "",
  "```mermaid",
  "flowchart LR",
  "  Draft[Черновик] --> Review{Проверка}",
  "  Review --> Release[Релиз]",
  "```"
].join("\n");

/** A solid-color PNG of the given size, built without image libraries. */
function solidPng(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let value = 0xffffffff;
    for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, Buffer.from([0x2b, 0x8a, 0xc4]))]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

type Fixture = { attachmentId: string; chatId: string; lastAnswerId: string; lastQuestionId: string };

let fixture: Fixture | null = null;

async function seedChat(): Promise<Fixture> {
  const owner = await prisma.user.findUniqueOrThrow({ select: { id: true }, where: { email: LOCAL_OPERATOR_EMAIL } });
  const chat = await prisma.chat.create({ data: { memoryMode: "EXCLUDED", title: TITLE, userId: owner.id } });
  const attachmentId = randomUUID();
  const start = Date.now() - MESSAGE_COUNT * 60_000;
  let parentMessageId: string | null = null;
  const ids: string[] = [];
  for (let index = 1; index <= MESSAGE_COUNT; index += 1) {
    const role = index % 2 ? "user" : "assistant";
    const blocks: unknown[] = [{ text: index === 1 ? FIRST_TEXT : index === MESSAGE_COUNT ? LAST_ANSWER : `Сообщение номер ${index}`, type: "text" }];
    if (index === MESSAGE_COUNT - 1) blocks.push({ alt: "Схема склада", attachmentId, type: "image" });
    const created: { id: string } = await prisma.message.create({
      data: { chatId: chat.id, content: { blocks } as Prisma.InputJsonValue, createdAt: new Date(start + index * 60_000), parentMessageId, role },
      select: { id: true }
    });
    ids.push(created.id);
    parentMessageId = created.id;
  }
  await prisma.attachment.create({ data: {
    byteSize: 1, chatId: chat.id, fileName: "warehouse.png", id: attachmentId, kind: "image", messageId: ids[MESSAGE_COUNT - 2]!,
    metadata: {}, mimeType: "image/png", storageKey: `e2e/chat-print/${attachmentId}`, userId: owner.id
  } });
  await prisma.chat.update({ data: { activeLeafMessageId: parentMessageId }, where: { id: chat.id } });
  return { attachmentId, chatId: chat.id, lastAnswerId: ids.at(-1)!, lastQuestionId: ids.at(-2)! };
}

function shellDetail({ chatId, lastAnswerId, lastQuestionId }: Fixture): ChatDetailWire {
  const at = new Date().toISOString();
  const message = (id: string, role: "assistant" | "user", content: string, parentMessageId: string | null): ChatMessageWire => ({
    citationMessageId: null, content, createdAt: at, errorMessage: null, id, modelId: null, modelRunId: null, parentMessageId,
    provider: null, role, status: "complete"
  });
  // The shell shows only the latest turn; the print page must still contain the whole branch.
  const messages = [message(lastQuestionId, "user", "Посмотри картинку", null), message(lastAnswerId, "assistant", "Итоговый ответ", lastQuestionId)];
  return {
    activeLeafMessageId: lastAnswerId, assistant: null, contextStats: { approximateActiveBranchInputTokens: 100 }, createdAt: at,
    defaultModelId: matrixCatalog.models[0]!.modelId, defaultProvider: matrixCatalog.models[0]!.provider, folderId: null, id: chatId,
    messageCount: messages.length, messages, pageInfo: { activeLeafMessageId: lastAnswerId, beforeCursor: null, hasOlder: false, snapshotUpdatedAt: at },
    pinned: false, title: TITLE, updatedAt: at, usageStats: null,
    workspace: { available: false, enabled: false, internetEnabled: false, sessionState: null }
  } as ChatDetailWire;
}

/** Counts `window.print()` calls in every page of the context instead of opening a dialog. */
async function stubPrint(context: BrowserContext) {
  await context.addInitScript(() => {
    const target = window as unknown as { __printCalls: number; __cspViolations: unknown[] };
    target.__printCalls = 0;
    target.__cspViolations = [];
    window.print = () => { target.__printCalls += 1; };
    document.addEventListener("securitypolicyviolation", (event) => {
      target.__cspViolations.push({ blockedURI: event.blockedURI, directive: event.effectiveDirective });
    });
  });
}

async function serveImageAndPolicy(context: BrowserContext, { attachmentId, chatId }: Fixture, externalRequests: string[]) {
  const png = solidPng(480, 320);
  await context.route(`**/api/attachments/${attachmentId}/content*`, (route) =>
    route.fulfill({ body: png, contentType: "image/png", headers: { "cache-control": "private, no-store" } }));
  await context.route(`**/print/c/${chatId}`, async (route) => {
    if (route.request().resourceType() !== "document") return route.fallback();
    const response = await route.fetch({ maxRedirects: 0 });
    const headers: Record<string, string> = { ...response.headers(), "content-security-policy-report-only": PRODUCTION_CSP };
    for (const name of ["content-security-policy", "content-encoding", "content-length", "transfer-encoding"]) delete headers[name];
    await route.fulfill({ headers, response });
  });
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (["http:", "https:"].includes(url.protocol) && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      externalRequests.push(url.origin);
    }
  });
}

async function expectCompletePrintPage(page: Page) {
  const printPage = page.getByTestId("chat-print-page");
  await expect(printPage).toHaveAttribute("data-print-state", "ready", { timeout: 30_000 });
  await expect(printPage).toHaveAttribute("data-print-settle", "settled");
  await expect(page.getByRole("heading", { exact: true, level: 1, name: TITLE })).toBeVisible();
  const turns = page.getByTestId("chat-print-thread").getByRole("article");
  await expect(turns).toHaveCount(MESSAGE_COUNT);
  await expect(turns.first()).toContainText(FIRST_TEXT);
  await expect(turns.last()).toContainText("Итоговый ответ с формулой");
  const image = turns.nth(MESSAGE_COUNT - 2).getByRole("img", { exact: true, name: "Схема склада" });
  await expect(image).toBeVisible();
  expect(await image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(480);
  const answer = turns.last();
  await expect(answer.locator(".katex")).toHaveCount(1);
  await expect(answer.locator(".shiki")).toHaveCount(1);
  await expect(answer.getByRole("table")).toContainText("Миграции");
  await expect(answer.locator('[data-mermaid-state="rendered"] [data-testid="mermaid-diagram-scroll"] > svg')).toBeVisible();
  await expect(page.locator("[data-render-pending], [data-mermaid-state=\"pending\"]")).toHaveCount(0);
  // The page proposes the export base name as the PDF file name.
  expect(await page.title()).toMatch(/^печать-отчёт-о-релизе-\d{4}-\d{2}-\d{2}$/u);
}

test.afterAll(async ({ browser }) => {
  try {
    if (fixture) {
      await prisma.attachment.deleteMany({ where: { id: fixture.attachmentId } });
      const context = await browser.newContext();
      try {
        await authenticateWithLocalToken(context.request);
        await deleteOwnedChatPermanently(context.request, fixture.chatId, { timeout: 15_000 });
      } finally {
        await context.close();
      }
      fixture = null;
    }
  } finally {
    await prisma.$disconnect();
  }
});

test("the chat menu opens a print page of the whole branch that prints once and saves as a PDF", async ({ context, page }, testInfo) => {
  test.setTimeout(120_000);
  fixture = await seedChat();
  const externalRequests: string[] = [];
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubPrint(context);
  await serveImageAndPolicy(context, fixture, externalRequests);
  await installMatrixCatalogFixture(page, { chats: [shellDetail(fixture)], folders: [] });
  await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));
  await page.route("**/api/me/chats/*/memory-mode", (route) => route.fulfill({ json: {
    allowedActions: ["EXCLUDE"], archived: false, mode: "NORMAL", temporaryRetentionDeadline: null
  } }));
  await signInWithLocalToken(page, `/c/${fixture.chatId}`);

  await page.getByTestId("header-more-trigger").click();
  await page.getByRole("menuitem", { exact: true, name: "Export" }).click();
  const popupPromise = context.waitForEvent("page");
  await page.getByRole("menuitem", { exact: true, name: "PDF" }).click();
  const popup = await popupPromise;
  await popup.setViewportSize({ width: 1440, height: 900 });
  expect(new URL(popup.url()).pathname).toBe(`/print/c/${fixture.chatId}`);
  expect(await popup.evaluate(() => window.opener)).toBeNull();

  await expectCompletePrintPage(popup);
  await expect.poll(() => popup.evaluate(() => (window as unknown as { __printCalls: number }).__printCalls)).toBe(1);
  await popup.waitForTimeout(500);
  expect(await popup.evaluate(() => (window as unknown as { __printCalls: number }).__printCalls)).toBe(1);
  await expect(popup.getByRole("button", { exact: true, name: "Print / Save as PDF" })).toBeVisible();
  await expectNoHorizontalOverflow(popup);
  await popup.screenshot({ path: testInfo.outputPath("chat-print-desktop-screen.png") });

  // On paper: no toolbar, buttons or code/diagram chrome; code wraps.
  await popup.emulateMedia({ media: "print" });
  await expect(popup.getByRole("button", { exact: true, name: "Print / Save as PDF" })).toBeHidden();
  await expect(popup.getByRole("button", { exact: true, name: "Copy code" })).toBeHidden();
  expect(await popup.locator(".shiki").first().evaluate((element) => getComputedStyle(element).whiteSpace)).toBe("pre-wrap");
  await popup.getByTestId("mermaid-block").scrollIntoViewIfNeeded();
  await popup.screenshot({ path: testInfo.outputPath("chat-print-desktop-print-media.png") });
  await popup.emulateMedia({ media: null });

  const pdf = await popup.pdf({ format: "A4" });
  expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  await testInfo.attach("chat-print.pdf", { body: pdf, contentType: "application/pdf" });
  const { extractText } = await import("unpdf");
  const { text, totalPages } = await extractText(new Uint8Array(pdf), { mergePages: true });
  expect(totalPages).toBeGreaterThan(1);
  // Text runs may be joined with or without spaces; compare without whitespace.
  const compact = (value: string) => value.replace(/\s+/gu, "");
  expect(compact(text)).toContain(compact(FIRST_TEXT));
  expect(compact(text)).toContain(compact("Итоговый ответ с формулой"));
  expect(compact(text)).toContain("Миграции");

  const violations = await popup.evaluate(() => (window as unknown as { __cspViolations: Array<{ directive: string }> }).__cspViolations);
  // The dev runtime's own eval is outside this check; nothing else may break the production policy.
  expect(violations.filter((violation) => !violation.directive.startsWith("script-src"))).toEqual([]);
  expect(externalRequests).toEqual([]);
});

test("the print page fits a phone and shows the same branch", async ({ context, page }, testInfo) => {
  test.setTimeout(90_000);
  expect(fixture).not.toBeNull();
  await page.setViewportSize({ width: 390, height: 844 });
  await stubPrint(context);
  await serveImageAndPolicy(context, fixture!, []);
  await authenticateWithLocalToken(page.request);
  const response = await page.goto(`/print/c/${fixture!.chatId}`);
  expect(response?.status()).toBe(200);
  const printPage = page.getByTestId("chat-print-page");
  await expect(printPage).toHaveAttribute("data-print-state", "ready", { timeout: 30_000 });
  await expect(page.getByTestId("chat-print-thread").getByRole("article")).toHaveCount(MESSAGE_COUNT);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("chat-print-phone-screen.png") });
  await page.getByTestId("mermaid-block").scrollIntoViewIfNeeded();
  await page.emulateMedia({ media: "print" });
  await page.screenshot({ path: testInfo.outputPath("chat-print-phone-print-media.png") });
});

test("a user without access gets the same not-found page as for a missing chat", async ({ browser }) => {
  expect(fixture).not.toBeNull();
  const people = createPeopleFixture(prisma);
  try {
    const stranger = await people.user("Print stranger");
    const { page } = await people.signIn(browser, stranger);
    const hidden = await page.goto(`/print/c/${fixture!.chatId}`);
    expect(hidden?.status()).toBe(404);
    const hiddenText = await page.getByTestId("chat-print-unavailable").innerText();
    const hiddenTitle = await page.title();
    const missing = await page.goto(`/print/c/${randomUUID()}`);
    expect(missing?.status()).toBe(404);
    expect(await page.getByTestId("chat-print-unavailable").innerText()).toBe(hiddenText);
    expect(await page.title()).toBe(hiddenTitle);
    expect(hiddenText).not.toContain(TITLE);
    expect(hiddenText).toContain("Chat not found");
  } finally {
    await people.cleanup();
  }
});
