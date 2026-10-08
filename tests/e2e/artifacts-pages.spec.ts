import { randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow, expectTouchSafe, expectWithinViewport } from "./support/layoutAssertions";
import { authenticateWithLocalToken } from "./support/localAuth";

// A small multi-page site written inline: pages link to each other, a script
// reads data.json through fetch() and sets an image src at runtime.
const shell = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{margin:0;font:16px system-ui;background:#f6f4ee;color:#1d2b26}main{max-width:640px;margin:auto;padding:24px;display:grid;gap:16px}
a{color:#0b5d55}output{font-variant-numeric:tabular-nums}</style></head><body><main>${body}</main></body></html>`;
const files = {
  "index.html": shell("Pages home", '<h1>Pages home</h1><a href="about.html">About</a><output id="data">loading</output>' +
    '<script>fetch("data.json").then(response => response.json()).then(value => { document.getElementById("data").textContent = value.greeting; })' +
    '.catch(error => { document.getElementById("data").textContent = "failed: " + error; });</script>'),
  "about.html": shell("About", '<h1>About us</h1><a href="index.html">Home</a><a href="docs/guide.html#part-2">Guide part 2</a>' +
    '<img id="logo" alt="Logo" width="24" height="24"><output id="logo-state">pending</output>' +
    // The path is assembled at runtime, so the bridge, not the renderer, serves it.
    '<script>const logo = document.getElementById("logo"); logo.onload = () => { document.getElementById("logo-state").textContent = "loaded"; };' +
    'logo.onerror = () => { document.getElementById("logo-state").textContent = "failed"; }; logo.src = ["logo", "svg"].join(".");</script>'),
  "docs/guide.html": shell("Guide", '<h1>Guide</h1><div style="height:2400px">Part one</div><h2 id="part-2">Part two</h2><a href="../about.html">Back to about</a>'),
  "data.json": JSON.stringify({ greeting: "Hello from data.json" }),
  "logo.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#0b5d55"/></svg>'
} as const;
const mimeTypes: Record<keyof typeof files, string> = { "index.html": "text/html", "about.html": "text/html", "docs/guide.html": "text/html",
  "data.json": "application/json", "logo.svg": "image/svg+xml" };
const versionHeader = "x-aiqsa-artifact-version";
const preview = (page: Page) => page.frameLocator("iframe.v2-artifact-frame");
const pageBar = (page: Page) => page.getByRole("navigation", { name: "Artifact page" });

/** Bounded ZIP records read independently of the product's exporter; nothing is extracted to disk. */
function zipEntries(bytes: Buffer): Map<string, Buffer> {
  expect(bytes.length).toBeLessThan(1_000_000);
  expect(bytes.readUInt32LE(bytes.length - 22)).toBe(0x06054b50);
  const centralOffset = bytes.readUInt32LE(bytes.length - 6);
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset < centralOffset) {
    expect(bytes.readUInt32LE(offset)).toBe(0x04034b50);
    const compressedSize = bytes.readUInt32LE(offset + 18), size = bytes.readUInt32LE(offset + 22);
    const nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const start = offset + 30 + nameLength + extraLength;
    const body = inflateRawSync(bytes.subarray(start, start + compressedSize), { maxOutputLength: 100_000 });
    expect(body.length).toBe(size); expect(entries.has(name)).toBe(false);
    entries.set(name, body);
    offset = start + compressedSize;
  }
  return entries;
}
function expectSite(entries: Map<string, Buffer>) {
  expect([...entries.keys()].sort()).toEqual(Object.keys(files).sort());
  // Inline files without external references export byte for byte.
  for (const [path, text] of Object.entries(files)) expect(entries.get(path)!.toString("utf8"), path).toBe(text);
}

async function createSite(page: Page) {
  await authenticateWithLocalToken(page.request);
  const title = `Pages site ${randomUUID().slice(0, 8)}`;
  const chat = await page.request.post("/api/chats", { data: { title, memoryMode: "EXCLUDED" } });
  expect(chat.status()).toBe(201);
  const chatId: string = (await chat.json()).chat.id;
  let artifactId: string | null = null;
  async function cleanup() {
    await authenticateWithLocalToken(page.request);
    const statuses: number[] = [];
    for (const path of [...(artifactId ? [`/api/artifacts/${artifactId}`] : []), `/api/chats/${chatId}`]) {
      const response = await page.request.delete(path);
      if (!response.ok() && response.status() !== 404) statuses.push(response.status());
    }
    expect(statuses, "Only owned synthetic artifacts and chats are removed").toEqual([]);
  }
  try {
    const response = await page.request.post("/api/artifacts", { data: { sourceChatId: chatId, operation: {
      intent: "create", kind: "html", title, entrypoint: "index.html",
      files: Object.entries(files).map(([path, text]) => ({ path, mimeType: mimeTypes[path as keyof typeof files], text }))
    } } });
    expect(response.status()).toBe(201);
    const version = (await response.json()).version as { id: string; artifactId: string };
    artifactId = version.artifactId;
    return { title, chatId, artifactId: version.artifactId, versionId: version.id, cleanup,
      contentPath: `/api/artifacts/${version.artifactId}/versions/${version.id}/content`,
      privatePath: `/artifacts/${version.artifactId}/versions/${version.id}` };
  } catch (error) { await cleanup(); throw error; }
}

async function walkPages(page: Page) {
  const frame = preview(page);
  await expect(frame.locator("#data")).toHaveText("Hello from data.json");
  await expect(pageBar(page)).toHaveCount(0);
  await frame.getByRole("link", { name: "About" }).click();
  await expect(frame.getByRole("heading", { name: "About us" })).toBeVisible();
  await expect(frame.locator("#logo-state")).toHaveText("loaded");
  await expect(pageBar(page)).toContainText("about.html");
  await frame.getByRole("link", { name: "Guide part 2" }).click();
  await expect(frame.getByRole("heading", { name: "Part two" })).toBeInViewport();
  await expect(pageBar(page)).toContainText("docs/guide.html");
  await frame.getByRole("link", { name: "Back to about" }).click();
  await expect(frame.getByRole("heading", { name: "About us" })).toBeVisible();
  await pageBar(page).getByRole("button", { name: "Start page" }).click();
  await expect(frame.getByRole("heading", { name: "Pages home" })).toBeVisible();
  await expect(frame.locator("#data")).toHaveText("Hello from data.json");
  await expect(pageBar(page)).toHaveCount(0);
}

test("multi-page artifacts open pages in place in the private and public viewers, export every file, and stop at revocation", async ({ page, browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const site = await createSite(page);
  let anonymous: BrowserContext | undefined;
  try {
    await page.goto(site.privatePath);
    await walkPages(page);

    // Page selection is exact on the owner's route: a missing page is a typed 404, a malformed one a 400.
    const ownPage = await page.request.get(`${site.contentPath}?page=about.html`);
    expect(ownPage.status()).toBe(200);
    expect(ownPage.headers()["x-aiqsa-artifact-page"]).toBe("about.html");
    expect(ownPage.headers()["cache-control"]).toContain("no-store");
    expect(ownPage.headers()["content-security-policy"]).toContain("connect-src 'none'");
    expect(await ownPage.text()).toContain("About us");
    const missing = await page.request.get(`${site.contentPath}?page=missing.html`);
    expect(missing.status()).toBe(404); expect(await missing.json()).toEqual({ error: "artifact_page_not_found" });
    expect((await page.request.get(`${site.contentPath}?page=..%2Fabout.html`)).status()).toBe(400);
    expect((await page.request.get(`${site.contentPath}?page=about.html&download=zip`)).status()).toBe(400);
    const ownZip = await page.request.get(`${site.contentPath}?download=zip`);
    expect(ownZip.status()).toBe(200); expect(ownZip.headers()["content-type"]).toBe("application/zip");
    expectSite(zipEntries(Buffer.from(await ownZip.body())));

    const published = await page.request.post(`/api/artifacts/${site.artifactId}/publish`, { data: { versionId: site.versionId } });
    expect(published.status()).toBe(201);
    const publication = (await published.json()).publication as { id: string; publicPath: string; revision: number };
    const api = `/api/artifact-public/${publication.publicPath.split("/").at(-1)}`;
    anonymous = await browser.newContext({ baseURL, reducedMotion: "reduce" });
    const viewer = await anonymous.newPage();
    await viewer.goto(publication.publicPath);
    await walkPages(viewer);
    const publicPage = await anonymous.request.get(`${api}?page=docs%2Fguide.html`, { headers: { [versionHeader]: "1" } });
    expect(publicPage.status()).toBe(200);
    expect(publicPage.headers()["x-aiqsa-artifact-page"]).toBe("docs/guide.html");
    expect(publicPage.headers()["referrer-policy"]).toBe("no-referrer");
    expect(publicPage.headers()["x-robots-tag"]).toContain("noindex");
    for (const suffix of ["?page=missing.html", "?page=data.json", "?page=docs%2Fguide.html&download=file", "?page=about.html&utm=1"]) {
      const refused = await anonymous.request.get(`${api}${suffix}`);
      expect(refused.status(), suffix).toBe(404); expect(await refused.json()).toEqual({ error: "artifact_not_found" });
    }
    const publicZip = await anonymous.request.get(`${api}?download=zip`, { headers: { [versionHeader]: "1" } });
    expect(publicZip.status()).toBe(200);
    expectSite(zipEntries(Buffer.from(await publicZip.body())));

    // The page bar stays reachable and touch-sized without page-wide overflow.
    await viewer.goto(publication.publicPath);
    await preview(viewer).getByRole("link", { name: "About" }).click();
    await expect(pageBar(viewer)).toContainText("about.html");
    for (const size of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await viewer.setViewportSize(size);
      await expectNoHorizontalOverflow(viewer);
      await expectWithinViewport(viewer, pageBar(viewer).getByRole("button", { name: "Start page" }));
      await viewer.screenshot({ path: testInfo.outputPath(`artifact-pages-public-${size.width}x${size.height}.png`) });
    }

    const revoked = await page.request.post(`/api/artifacts/publications/${publication.id}/revoke`, { data: { expectedRevision: publication.revision } });
    expect(revoked.status()).toBe(200);
    for (const suffix of ["?page=about.html", "", "?download=zip"]) {
      const denied = await anonymous.request.get(`${api}${suffix}`, { headers: { [versionHeader]: "1" } });
      expect(denied.status(), suffix).toBe(404); expect(await denied.json()).toEqual({ error: "artifact_not_found" });
    }
    expect((await viewer.reload())?.status()).toBe(404);
  } finally {
    await anonymous?.close();
    await site.cleanup();
  }
});

test("the page bar is touch safe on phones and tablets in both orientations", async ({ page, browser, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const site = await createSite(page);
  let touch: BrowserContext | undefined;
  try {
    const cookies = await page.context().cookies();
    touch = await browser.newContext({ baseURL, isMobile: true, hasTouch: true, reducedMotion: "reduce", viewport: { width: 390, height: 844 } });
    await touch.addCookies(cookies);
    const target = await touch.newPage();
    await target.goto(site.privatePath);
    await expect(preview(target).locator("#data")).toHaveText("Hello from data.json");
    await preview(target).getByRole("link", { name: "About" }).tap();
    await expect(pageBar(target)).toContainText("about.html");
    for (const size of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 768, height: 1024 }, { width: 1024, height: 768 }]) {
      await target.setViewportSize(size);
      const start = pageBar(target).getByRole("button", { name: "Start page" });
      await expectTouchSafe(start); await expectWithinViewport(target, start); await expectNoHorizontalOverflow(target);
      await target.screenshot({ path: testInfo.outputPath(`artifact-pages-private-touch-${size.width}x${size.height}.png`) });
    }
    await pageBar(target).getByRole("button", { name: "Start page" }).tap();
    await expect(preview(target).getByRole("heading", { name: "Pages home" })).toBeVisible();
    await expect(pageBar(target)).toHaveCount(0);
  } finally {
    await touch?.close();
    await site.cleanup();
  }
});
