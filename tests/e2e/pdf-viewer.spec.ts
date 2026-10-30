import { expect, test, type Page } from "@playwright/test";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { captureState } from "./support/capture";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";
import {
  activeContentPdf,
  cidFontPdf,
  damagedPdf,
  jbig2Pdf,
  jpxPdf,
  maliciousFontPdf,
  oversizedPagePdf,
  passwordPdf,
  predefinedCmapPdf
} from "../support/pdfFixtures";

// The in-app viewer on a real server and real pdf.js. Bytes are fulfilled per test because a real upload is not
// the point except in the last test; the viewer's other states are in PdfViewerV2.test.tsx.
const chatId = "pdf-viewer-chat";
const timestamp = "2026-10-30T10:00:00.000Z";
const rareWord = "Синхрофазотрон";
// Enough pages that the last one is far from rendered when the search runs.
const longDocument = cidFontPdf(Array.from({ length: 40 }, (_, index) => [
  `Страница ${index + 1} синтетического отчёта`,
  ...(index === 37 ? [`Здесь спрятано слово ${rareWord}`] : [])
]));

const documents = {
  active: activeContentPdf(),
  cmap: predefinedCmapPdf(),
  damaged: damagedPdf(),
  font: maliciousFontPdf(),
  jbig2: jbig2Pdf(),
  jpx: jpxPdf(),
  long: longDocument,
  missing: null,
  oversized: oversizedPagePdf(),
  password: passwordPdf()
} as const;

type DocumentId = keyof typeof documents;
const label = (id: DocumentId) => `${id}.pdf`;

function fileBlocks() {
  return (Object.keys(documents) as DocumentId[]).map(id => ({ type: "file", attachmentId: `pdf-${id}`, fileName: label(id) }));
}

/**
 * CSP reports in dev (Report-Only) and enforced refusals on a production build both reach the console.
 * Dev's report-only policy allows eval, so only a production build proves the WebAssembly path stays unused.
 */
function collectConsole(page: Page) {
  const csp: string[] = [];
  const errors: string[] = [];
  page.on("console", message => {
    const text = message.text();
    if (/Content Security Policy|Content-Security-Policy|violates the following/iu.test(text)) csp.push(text);
    else if (message.type() === "error") errors.push(text);
  });
  page.on("pageerror", error => errors.push(error.message));
  return { csp, errors };
}

function installChat(page: Page, blocks: readonly Record<string, unknown>[]) {
  return installMatrixCatalogFixture(page, { folders: [], chats: [{
    id: chatId, title: "PDF viewer", activeLeafMessageId: "message", createdAt: timestamp, updatedAt: timestamp,
    defaultProvider: "openai", defaultModelId: "gpt-5.5", folderId: null, pinned: false, messageCount: 1,
    messages: [{
      id: "message", role: "user", status: "complete", parentMessageId: null, createdAt: timestamp, errorMessage: null,
      citationMessageId: null, modelId: null, modelRunId: null, provider: null,
      content: { blocks: [{ type: "text", text: "Synthetic PDF files." }, ...blocks] }
    }]
  }] });
}

async function openChat(page: Page) {
  await installChat(page, fileBlocks());
  await page.route(/\/api\/attachments\/pdf-([a-z0-9]+)\/content$/u, async (route) => {
    const id = /pdf-([a-z0-9]+)\/content$/u.exec(route.request().url())![1] as DocumentId;
    const bytes = documents[id];
    if (!bytes) {
      await route.fulfill({ json: { error: "attachment_not_found" }, status: 404 });
      return;
    }
    await route.fulfill({
      body: Buffer.from(bytes),
      headers: {
        "cache-control": "private, no-store, max-age=0",
        "content-disposition": `attachment; filename="${id}.pdf"`,
        "content-length": String(bytes.length),
        "content-security-policy": "default-src 'none'; sandbox",
        "content-type": "application/pdf",
        "x-content-type-options": "nosniff"
      }
    });
  });
  await signInWithLocalToken(page, `/c/${chatId}`);
  await expect(page.getByRole("list", { name: "Message attachments" })).toBeVisible();
}

async function openPdf(page: Page, id: DocumentId) {
  const card = page.getByRole("button", { name: `Open ${label(id)}` });
  await card.click();
  return { card, dialog: page.getByRole("dialog", { name: `File preview: ${label(id)}` }) };
}

const firstPage = (page: Page) => page.locator('.pdfViewer .page[data-page-number="1"] canvas');
const zoomValue = (page: Page) => page.getByRole("button", { name: /^Fit page/u });

async function closePdf(page: Page) {
  await page.getByRole("button", { name: "Close preview" }).click();
  await expect(page.getByTestId("file-preview")).toHaveCount(0);
}

/** A sample of the middle of a rendered page's canvas: [r, g, b]. */
async function centerPixel(page: Page): Promise<number[]> {
  return firstPage(page).evaluate((canvas: HTMLCanvasElement) => [
    ...canvas.getContext("2d")!.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data
  ].slice(0, 3));
}

test.describe("the PDF viewer", () => {
  test.describe.configure({ timeout: 120_000 });

  test("loads pdf.js only when a PDF opens, renders Cyrillic text that can be selected and copied, and returns focus", async ({ context, page }, testInfo) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const seen = collectConsole(page);
    const assets: string[] = [];
    const external: string[] = [];
    const chunks: { url: string; text: Promise<string> }[] = [];
    page.on("response", response => {
      const url = new URL(response.url());
      if (url.origin !== new URL(testInfo.project.use.baseURL!).origin && !url.protocol.startsWith("data") && !url.protocol.startsWith("blob")) external.push(url.origin);
      if (url.pathname.startsWith("/pdfjs/")) {
        assets.push(url.pathname);
        expect(response.ok(), url.pathname).toBe(true);
      }
      if (url.pathname.startsWith("/_next/static/") && url.pathname.endsWith(".js")) chunks.push({ url: url.pathname, text: response.text().catch(() => "") });
    });
    await openChat(page);
    seen.csp.length = 0;

    // The chat loaded none of it: no worker, no asset, and no chunk that holds the library's code.
    expect(assets).toEqual([]);
    for (const chunk of chunks) expect((await chunk.text).includes("GlobalWorkerOptions"), chunk.url).toBe(false);

    const { card, dialog } = await openPdf(page, "long");
    await expect(firstPage(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("1 / 40");
    expect(assets.some(path => path.endsWith("/pdf.worker.min.mjs"))).toBe(true);
    expect(external).toEqual([]);

    const text = page.locator('.pdfViewer .page[data-page-number="1"] .textLayer');
    await expect(text).toContainText("Страница 1 синтетического отчёта");
    await text.locator("span").first().selectText();
    await page.keyboard.press("Control+C");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("Страница 1");

    // A page stays white in the dark theme; the frame around it follows the theme.
    await page.evaluate(() => {
      document.documentElement.setAttribute("data-theme", "dark");
      document.documentElement.setAttribute("data-color-scheme", "dark");
    });
    await expect(page.locator('.pdfViewer .page[data-page-number="1"]')).toHaveCSS("background-color", "rgb(255, 255, 255)");

    await captureState(page, testInfo, "pdf-viewer-open", { anchor: dialog.getByTestId("pdf-viewer"), settleMs: 300, atEachSize: async () => {
      await expectNoHorizontalOverflow(page);
      await expect(dialog.getByRole("button", { name: "Zoom in" })).toBeInViewport();
      await expect(dialog.getByRole("button", { name: "Search in document" })).toBeInViewport();
      await expect(dialog.getByRole("button", { name: "Save to Files" })).toHaveCount(0);
      await expect(dialog.getByRole("link", { name: `Download ${label("long")}` })).toBeInViewport();
    } });

    await closePdf(page);
    await expect(card).toBeFocused();
    expect(seen.csp).toEqual([]);
    expect(seen.errors.filter(message => /pdf/iu.test(message))).toEqual([]);
  });

  test("search finds text on a page that has not rendered and scrolls to it; zoom changes the pages; Escape closes the search first", async ({ page }, testInfo) => {
    const seen = collectConsole(page);
    await openChat(page);
    seen.csp.length = 0;
    const { dialog } = await openPdf(page, "long");
    await expect(firstPage(page)).toBeVisible({ timeout: 30_000 });

    const target = page.locator('.pdfViewer .page[data-page-number="38"]');
    await expect(target.locator("canvas")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Search in document" }).click();
    const input = dialog.getByRole("searchbox", { name: "Search text" });
    await expect(input).toBeFocused();
    await input.fill(rareWord.toLowerCase());
    await expect(page.getByTestId("pdf-search-count")).toHaveText("1 of 1", { timeout: 20_000 });
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("38 / 40");
    await expect(target.locator(".textLayer .highlight")).toBeVisible({ timeout: 15_000 });
    await captureState(page, testInfo, "pdf-viewer-search", { anchor: input, settleMs: 300, atEachSize: async () => {
      await expectNoHorizontalOverflow(page);
      await expect(input).toBeInViewport();
    } });

    await input.fill("нет такого слова");
    await expect(page.getByTestId("pdf-search-count")).toHaveText("No matches", { timeout: 20_000 });
    await input.press("Escape");
    await expect(input).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Search in document" })).toBeFocused();
    await expect(dialog).toBeVisible();

    const before = await zoomValue(page).innerText();
    const widthBefore = (await target.boundingBox())!.width;
    await dialog.getByRole("button", { name: "Zoom in" }).click();
    await expect(zoomValue(page)).not.toHaveText(before);
    await expect.poll(async () => (await target.boundingBox())!.width).toBeGreaterThan(widthBefore);
    await zoomValue(page).click();
    await expect(zoomValue(page)).toHaveText(before);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("file-preview")).toHaveCount(0);
    expect(seen.csp).toEqual([]);
  });

  test("a PDF's script does nothing; its web link waits for the confirmation; its internal link moves", async ({ page }) => {
    const seen = collectConsole(page);
    const popups: string[] = [];
    page.context().on("page", popup => popups.push(popup.url()));
    await openChat(page);
    seen.csp.length = 0;
    const { dialog } = await openPdf(page, "active");
    await expect(firstPage(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("1 / 2");
    const annotation = page.locator('.pdfViewer .page[data-page-number="1"] .annotationLayer a');
    await expect(annotation).toHaveCount(4);

    expect(await page.evaluate(() => (globalThis as { __aiqsaPdfPwned?: unknown }).__aiqsaPdfPwned)).toBeUndefined();
    for (const href of await annotation.evaluateAll(links => links.map(link => link.getAttribute("href")))) {
      expect(href ?? "").not.toMatch(/javascript:|https?:/iu);
    }

    await annotation.nth(1).click();
    const confirmation = page.getByRole("dialog", { name: "Open external link?" });
    await expect(confirmation).toContainText("https://example.test/from-pdf?x=1");
    expect(popups).toEqual([]);
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(dialog).toBeVisible();

    await annotation.nth(2).click();
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("2 / 2");
    expect(popups).toEqual([]);
    expect(seen.csp).toEqual([]);
  });

  test("password-protected, damaged and missing files are visible failures, and Download stays where it means something", async ({ page }, testInfo) => {
    await openChat(page);
    for (const [id, copy, download] of [
      ["password", "password-protected", true],
      ["damaged", "damaged", true],
      ["missing", "unavailable", false]
    ] as const) {
      const { card, dialog } = await openPdf(page, id);
      const alert = dialog.getByRole("alert");
      await expect(alert).toContainText(copy, { timeout: 30_000 });
      await expect(alert.getByRole("link", { name: "Download" })).toHaveCount(download ? 1 : 0);
      await captureState(page, testInfo, `pdf-viewer-failure-${id}`, { anchor: alert, atEachSize: async () => {
        await expectNoHorizontalOverflow(page);
        await expect(alert).toBeInViewport();
      } });
      await closePdf(page);
      await expect(card).toBeFocused();
    }
  });

  test("a hostile font and an oversized page end in a bounded state; a predefined CMap and scans render under the policy", async ({ page }) => {
    const seen = collectConsole(page);
    const cmaps: string[] = [];
    page.on("response", response => {
      if (response.url().includes("/cmaps/")) cmaps.push(`${response.status()}`);
    });
    await openChat(page);
    seen.csp.length = 0;

    for (const id of ["font", "oversized"] as const) {
      await openPdf(page, id);
      await expect(firstPage(page)).toBeVisible({ timeout: 30_000 });
      const pixels = await firstPage(page).evaluate((canvas: HTMLCanvasElement) => canvas.width * canvas.height);
      expect(pixels).toBeLessThanOrEqual(2 ** 25 * 1.01);
      expect(await page.evaluate(() => (globalThis as { __aiqsaPdfPwned?: unknown }).__aiqsaPdfPwned)).toBeUndefined();
      await closePdf(page);
    }

    await openPdf(page, "cmap");
    await expect(page.locator(".pdfViewer .textLayer")).toContainText("日本語", { timeout: 30_000 });
    expect(cmaps.length).toBeGreaterThan(0);
    expect(cmaps.every(status => status === "200" || status === "304")).toBe(true);
    await closePdf(page);

    // JPEG2000 decodes to mid grey and JBIG2 to black: neither stays the white of an unpainted page.
    await openPdf(page, "jpx");
    await expect(firstPage(page)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => centerPixel(page)).not.toEqual([255, 255, 255]);
    await closePdf(page);
    await openPdf(page, "jbig2");
    await expect(firstPage(page)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => centerPixel(page)).not.toEqual([255, 255, 255]);
    await closePdf(page);

    expect(seen.csp).toEqual([]);
    expect(seen.errors.filter(message => /wasm|webassembly/iu.test(message))).toEqual([]);
  });

  test("closing while bytes are still arriving cancels the load", async ({ page }) => {
    let aborted = false;
    await openChat(page);
    await page.route(/\/api\/attachments\/pdf-long\/content$/u, () => undefined);
    page.on("requestfailed", request => { if (request.url().includes("pdf-long")) aborted = true; });
    await openPdf(page, "long");
    await expect(page.getByTestId("pdf-viewer")).toBeVisible({ timeout: 30_000 });
    await closePdf(page);
    await expect.poll(() => aborted).toBe(true);
  });

  test("a real upload opens through the authorized route with its headers intact, and an unknown or signed-out request gets nothing", async ({ page }, testInfo) => {
    await signInWithLocalToken(page, "/");
    const created = await page.request.post("/api/uploads", {
      multipart: { file: { name: "настоящий.pdf", mimeType: "application/pdf", buffer: Buffer.from(cidFontPdf([["Настоящая загрузка"]])) } }
    });
    expect(created.ok()).toBe(true);
    const { attachment } = await created.json() as { attachment: { id: string } };
    await expect.poll(async () => (await (await page.request.get(`/api/uploads/${attachment.id}`)).json()).attachment.status,
      { timeout: 60_000 }).toBe("ready");

    const bytes = await page.request.get(`/api/attachments/${attachment.id}/content`);
    expect(bytes.ok()).toBe(true);
    expect(bytes.headers()["content-disposition"]).toContain("attachment");
    expect(bytes.headers()["content-security-policy"]).toBe("default-src 'none'; sandbox");

    // A foreign attachment resolves the same way as an unknown one (`lib/server/uploads/downloadHandlers.ts`).
    const missing = await page.request.get("/api/attachments/00000000-0000-4000-8000-00000000dead/content");
    expect(missing.status()).toBe(404);
    const signedOut = await page.context().browser()!.newContext({ baseURL: testInfo.project.use.baseURL });
    expect((await signedOut.request.get(`/api/attachments/${attachment.id}/content`)).status()).toBe(401);
    await signedOut.close();

    await installChat(page, [{ type: "file", attachmentId: attachment.id, fileName: "настоящий.pdf" }]);
    await page.goto(`/c/${chatId}`);
    await page.getByRole("button", { name: "Open настоящий.pdf" }).click();
    await expect(page.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText("Настоящая загрузка", { timeout: 30_000 });
    await closePdf(page);
  });
});
