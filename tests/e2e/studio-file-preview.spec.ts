import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import type { AttachmentLibraryItemWire } from "../../lib/contracts/uploads";
import { authenticateWithLocalToken } from "./support/localAuth";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { expectNoHorizontalOverflow, expectTouchSafe, expectWithinViewport } from "./support/layoutAssertions";

const sizes = [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1200, height: 800 },
  { width: 1356, height: 800 }, { width: 1355, height: 800 }, { width: 768, height: 1024 },
  { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 844, height: 390 }];
const markdown = "# Research notes\n\nA concise record of the decisions behind the release.\n\n" +
  "- Keep original files available\n- Show text safely\n\n| Stage | Status |\n| --- | --- |\n| Review | Complete |\n\n" +
  "[External reference](https://preview-egress.invalid/reference)\n\n![External image](https://preview-egress.invalid/image.png)";
const sources: Record<string, string> = {
  markdown,
  html: '<!doctype html><h1>Uploaded page</h1><script>globalThis.previewExecuted = true</script><iframe src="https://preview-egress.invalid/frame"></iframe>',
  svg: '<svg xmlns="http://www.w3.org/2000/svg" onload="globalThis.previewExecuted=true"><image href="https://preview-egress.invalid/image.png"/></svg>',
  large: "<script>never execute</script>\n".repeat(15_000),
  slow: "Late content must never replace the selected file"
};
const stamp = "2026-09-22T10:00:00.000Z";
const animatedGif = Buffer.from("47494638396101000100800000000000ffffff21f904000a0000002c000000000100010000020244010021f904000a0000002c00000000010001000002024c01003b", "hex");
function catalog(): AttachmentLibraryItemWire[] {
  const file = (id: string, fileName: string, previewKind: AttachmentLibraryItemWire["previewKind"], saved = false,
    status: AttachmentLibraryItemWire["status"] = "ready"): AttachmentLibraryItemWire => ({
    id, fileName, previewKind, status, byteSize: sources[id] ? Buffer.byteLength(sources[id]) : 12800,
    createdAt: stamp, savedAt: saved ? stamp : null, chatId: saved ? null : "preview-chat",
    chatTitle: saved ? null : "Release research", messageId: saved ? null : `message-${id}`
  });
  return [file("picture", "research-chart.png", "image", true), file("animation", "process.gif", "image", true),
    file("markdown", "research-notes.md", "text", true), file("unavailable", "unavailable.txt", "text", true),
    file("slow", "first.txt", "text"), file("html", "uploaded-page.html", "text"), file("svg", "diagram.svg", "text"),
    file("large", "large-log.txt", "text"), file("pdf", "report.pdf", null), file("office", "report.docx", null),
    file("pending", "processing.png", null, false, "processing"), file("failed", "failed.docx", null, false, "failed")];
}

async function imageFixture() {
  return sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600">' +
    '<rect width="900" height="600" fill="#edf5f5"/><path d="M80 450 L80 120 M80 450 H820" stroke="#779a9a" stroke-width="3"/>' +
    '<path d="M100 400 L260 340 L430 365 L600 200 L800 150" fill="none" stroke="#248678" stroke-width="14"/>' +
    '<circle cx="800" cy="150" r="16" fill="#248678"/></svg>')).png().toBuffer();
}

async function prepare(page: Page) {
  await authenticateWithLocalToken(page.request);
  await installMatrixCatalogFixture(page);
  const files = catalog();
  const picture = await imageFixture();
  const thumb = await sharp(picture).resize(160, 160, { fit: "inside" }).webp().toBuffer();
  const external: string[] = [];
  await page.route("https://preview-egress.invalid/**", route => { external.push(route.request().url()); return route.abort(); });
  await page.route("**/api/uploads", route => route.fulfill({ json: { files, nextCursor: null } }));
  await page.route("**/api/attachments/*/content?preview=*", async route => {
    const url = new URL(route.request().url());
    const id = url.pathname.split("/")[3];
    if (id === "unavailable") return route.fulfill({ status: 415, json: { error: "text_preview_unavailable" } });
    if (url.searchParams.get("preview") === "thumb") return route.fulfill({ contentType: "image/webp", body: thumb });
    if (id === "picture" || id === "animation") return route.fulfill({ contentType: id === "picture" ? "image/png" : "image/gif", body: id === "picture" ? picture : animatedGif });
    return route.fulfill({ contentType: "text/plain; charset=utf-8", body: sources[id] ?? "" });
  });
  await page.goto("/?library=files");
  await expect(page.getByRole("button", { name: "View research-chart.png" })).toBeVisible();
  return { files, external };
}

test.use({ hasTouch: true });

for (const theme of ["light", "dark"] as const) {
  test(`Files preview uses measured docks and accessible sheets across devices · ${theme}`, async ({ page, context }, info) => {
    test.setTimeout(240_000);
    await context.addCookies([{ name: "aiqsa.theme", value: theme, url: "http://127.0.0.1:3000" }]);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const observed = await prepare(page);
    const files = page.getByTestId("library-files-panel");
    for (const size of sizes) {
      await page.setViewportSize(size);
      const area = await files.boundingBox();
      const compact = area!.width < 1040;
      await files.getByRole("button", { name: "View research-chart.png" }).click();
      const preview = page.getByRole(compact ? "dialog" : "complementary", { name: "File preview: research-chart.png" });
      await expect(preview).toBeVisible();
      await expect(preview.getByRole("button", { name: "Close preview" })).toBeFocused();
      await expect(preview.getByRole("img", { name: "research-chart.png" })).toBeVisible();
      await expect(preview.getByText("Loading preview…")).toHaveCount(0);
      const panel = await preview.boundingBox();
      if (!compact) {
        expect(panel!.width).toBe(520);
        expect((await files.locator(".v2-files-list").boundingBox())!.width).toBeGreaterThanOrEqual(520);
        expect(await files.evaluate(node => !!node.closest("[inert]"))).toBe(false);
      } else {
        expect(panel!.width).toBe(size.width);
        expect(await files.evaluate(node => !!node.closest("[inert]"))).toBe(true);
      }
      await info.attach(`files-geometry-${size.width}-${theme}.json`, { body: JSON.stringify({ area, panel, compact }), contentType: "application/json" });
      await expectWithinViewport(page, preview);
      for (const control of [preview.getByRole("button", { name: "Close preview" }), preview.getByRole("button", { name: "Use in chat" }),
        preview.getByRole("link", { name: "Download research-chart.png" }), preview.getByRole("button", { name: "Next file" })]) {
        await expectWithinViewport(page, control);
        await expectTouchSafe(control);
      }
      await expect(preview.getByText("1 of 4 in Saved")).toBeVisible();
      await expect(preview.getByRole("button", { name: "Previous file" })).toBeDisabled();
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath(`files-image-${theme}-${size.width}x${size.height}.png`) });
      if (compact) {
        await page.keyboard.press("Shift+Tab");
        await expect(preview.getByRole("link", { name: "Download research-chart.png" })).toBeFocused();
      }
      await page.keyboard.press("Escape");
      await expect(preview).toHaveCount(0);
      await expect(files.getByRole("button", { name: "View research-chart.png" })).toBeFocused();
      await files.getByRole("button", { name: "View research-notes.md" }).click();
      const text = page.getByTestId("file-preview");
      await expect(text.getByRole("heading", { name: "Research notes", exact: true })).toBeVisible();
      expect(await text.locator("img, iframe, object, embed, a[href^='https:']").count()).toBe(0);
      await text.getByRole("radio", { name: "Rendered" }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(text.getByRole("radio", { name: "Source" })).toBeFocused();
      await expect(text.locator("code")).toHaveText(markdown);
      await text.getByRole("radio", { name: "Rendered" }).click();
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath(`files-markdown-${theme}-${size.width}x${size.height}.png`) });
      await page.keyboard.press("Escape");
    }
    expect(observed.external).toEqual([]);
    for (const name of ["report.pdf", "report.docx", "processing.png", "failed.docx"]) {
      await expect(files.getByRole("button", { name: `View ${name}` })).toHaveCount(0);
    }
    await expect(files.getByRole("link", { name: "Download report.pdf" })).toHaveAttribute("download");
  });
}

test("Files source, navigation, request cancellation and existing file actions remain usable", async ({ page }, info) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const observed = await prepare(page);
  const files = page.getByTestId("library-files-panel");
  let release!: () => void;
  let requested = false;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/attachments/slow/content?preview=text", async route => {
    requested = true;
    await delayed;
    await route.fulfill({ contentType: "text/plain", body: sources.slow });
  });
  await files.getByRole("button", { name: "View first.txt" }).click();
  const preview = page.getByTestId("file-preview");
  await expect.poll(() => requested).toBe(true);
  await preview.getByRole("button", { name: "Next file" }).click();
  await expect(preview.locator("code")).toHaveText(sources.html);
  release();
  await expect(preview.getByText("2 of 4 in this chat")).toBeVisible();
  await expect(preview.getByRole("button", { name: "Open chat" })).toBeVisible();
  await expect(preview.getByRole("radio")).toHaveCount(0);
  await preview.getByRole("button", { name: "Next file" }).click();
  await expect(preview.locator("code")).toHaveText(sources.svg);
  expect(await preview.locator("iframe, object, embed, script, img").count()).toBe(0);
  expect(await page.evaluate(() => "previewExecuted" in globalThis)).toBe(false);
  await preview.getByRole("button", { name: "Next file" }).click();
  await expect(preview.locator("code")).toHaveText(sources.large);
  await expect(preview.locator("code > *")).toHaveCount(0);
  await expect(preview.getByRole("button", { name: "Next file" })).toBeDisabled();
  await files.getByRole("searchbox").fill("research-chart");
  await expect(preview).toHaveCount(0);
  await expect(files.getByRole("searchbox")).toBeFocused();
  await files.getByRole("searchbox").fill("");
  await files.getByRole("button", { name: "View process.gif" }).click();
  await expect(preview.getByRole("img", { name: "process.gif" })).toBeVisible();
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect(page.getByRole("dialog", { name: "File preview: process.gif" })).toBeVisible();
  await expect(preview.getByRole("button", { name: "Close preview" })).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("complementary", { name: "File preview: process.gif" })).toBeVisible();
  await expect(preview.getByRole("button", { name: "Close preview" })).toBeFocused();
  await page.keyboard.press("Escape");
  await files.getByRole("button", { name: "View unavailable.txt" }).click();
  await expect(preview.getByText("Preview is unavailable. Download the file instead.")).toBeVisible();
  await expect(preview.getByRole("link", { name: "Download", exact: true })).toHaveAttribute("href", "/api/attachments/unavailable/content");
  await page.screenshot({ path: info.outputPath("files-preview-unavailable.png") });
  await page.keyboard.press("Escape");
  await files.getByRole("button", { name: "View research-notes.md" }).click();
  await page.route("**/api/uploads/markdown/save", async route => {
    expect(route.request().method()).toBe("DELETE");
    observed.files.splice(observed.files.findIndex(file => file.id === "markdown"), 1);
    await route.fulfill({ status: 204 });
  });
  await files.getByRole("button", { name: "More actions for research-notes.md" }).click();
  await page.getByRole("menuitem", { name: "Remove from saved" }).click();
  await expect(preview).toHaveCount(0);
  await expect(files.getByRole("button", { name: "View research-notes.md" })).toHaveCount(0);
  await page.route("**/api/uploads/picture/reuse", route => route.fulfill({ json: { attachment: {
    id: "reused-picture", fileName: "research-chart.png", byteSize: 12800, mimeType: "image/png", kind: "image", status: "ready"
  } } }));
  await files.getByRole("button", { name: "View research-chart.png" }).click();
  await preview.getByRole("button", { name: "Use in chat" }).click();
  await expect(page.getByTestId("library-v2")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Attachments" }).getByText("research-chart.png")).toBeVisible();
  expect(observed.external).toEqual([]);
});

test("real upload content keeps original image bytes, static thumbnails and inert UTF-8 source", async ({ page }) => {
  test.setTimeout(180_000);
  await authenticateWithLocalToken(page.request);
  const savedIds: string[] = [];
  const picture = await imageFixture();
  try {
    for (const format of ["png", "jpeg", "webp", "gif"] as const) {
      const original = format === "gif" ? animatedGif : await sharp(picture)[format]().toBuffer();
      if (format === "gif") expect((await sharp(original, { animated: true }).metadata()).pages).toBe(2);
      const upload = await page.request.post("/api/uploads", { multipart: {
        // Import animated bytes as an opaque Workspace file. The original
        // image/gif MIME still controls preview; model-facing .gif admission
        // deliberately rejects animation and is outside this preview contract.
        ...(format === "gif" ? { scope: "workspace" } : {}),
        file: { name: format === "gif" ? "preview-oracle.gif.bin" : `preview-oracle.${format}`, mimeType: `image/${format}`, buffer: original }
      } });
      expect(upload.ok(), await upload.text()).toBe(true);
      const { attachment } = await upload.json();
      await expect.poll(async () => (await (await page.request.get(`/api/uploads/${attachment.id}`)).json()).attachment.status,
        { timeout: 30_000 }).toBe("ready");
      const save = await page.request.post(`/api/uploads/${attachment.id}/save`);
      expect(save.ok()).toBe(true);
      const saved = (await save.json()).attachment;
      savedIds.push(saved.id);
      const href = `/api/attachments/${saved.id}/content`;
      const image = await page.request.get(`${href}?preview=image`);
      expect(image.status()).toBe(200);
      expect((await image.body()).equals(original)).toBe(true);
      expect(image.headers()["cache-control"]).toContain("no-store");
      expect(image.headers()["x-content-type-options"]).toBe("nosniff");
      expect(image.headers()["content-disposition"]).toBe("inline");
      expect(image.headers()["content-security-policy"]).toContain("sandbox");
      const download = await page.request.get(href);
      expect((await download.body()).equals(original)).toBe(true);
      expect(download.headers()["content-disposition"]).toMatch(/^attachment;/);
      const thumbnail = await page.request.get(`${href}?preview=thumb`);
      expect(thumbnail.status()).toBe(200);
      const bytes = await thumbnail.body();
      expect(bytes.equals(original)).toBe(false);
      const metadata = await sharp(bytes, { animated: true }).metadata();
      expect(metadata.format).toBe("webp");
      expect(metadata.pages ?? 1).toBe(1);
      expect(metadata.width).toBeLessThanOrEqual(160);
      expect(metadata.height).toBeLessThanOrEqual(160);
      expect((await page.request.get(`${href}?preview=text`)).status()).toBe(415);
      expect((await page.request.get(`${href}?preview=unknown`)).status()).toBe(400);
      const list = await page.request.get("/api/uploads");
      const projection = (await list.json()).files.find((file: AttachmentLibraryItemWire) => file.id === saved.id);
      expect(projection.previewKind).toBe("image");
      for (const privateField of ["mimeType", "storageKey", "kind", "origin"]) expect(projection).not.toHaveProperty(privateField);
    }
    const upload = await page.request.post("/api/uploads", { multipart: {
      scope: "workspace",
      file: { name: "preview-source.svg", mimeType: "image/svg+xml", buffer: Buffer.from(`\uFEFF${sources.svg}`) }
    } });
    expect(upload.ok(), await upload.text()).toBe(true);
    const id = (await upload.json()).attachment.id;
    await expect.poll(async () => (await (await page.request.get(`/api/uploads/${id}`)).json()).attachment.status,
      { timeout: 30_000 }).toBe("ready");
    const response = await page.request.get(`/api/attachments/${id}/content?preview=text`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe(sources.svg);
  } finally {
    for (const id of savedIds) expect((await page.request.delete(`/api/uploads/${id}/save`)).status()).toBe(204);
  }
});
