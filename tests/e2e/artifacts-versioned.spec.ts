import { createHash, randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { expect, test, type BrowserContext, type Locator, type Page, type TestInfo } from "@playwright/test";
import { expectCenterUnobscured, expectNoHorizontalOverflow, expectTouchSafe, expectWithinViewport } from "./support/layoutAssertions";
import { authenticateWithLocalToken } from "./support/localAuth";

// Keep the normal authentication import: the isolated production qualification
// harness replaces only this helper with its owned password-authenticated user.
// Every fixture and oracle below uses the same public/owner HTTP API in both lanes.
const title = "Field notes · Сад";
const versionHeader = "x-aiqsa-artifact-version";
const viewports = [{ width: 1440, height: 900 }, { width: 768, height: 1024 },
  { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 844, height: 390 }];
const preview = (page: Page) => page.frameLocator("iframe.v2-artifact-frame");
type Version = { id: string; artifactId: string; versionNumber: number };
type PublicationSummary = { id: string; mode: "version_set"; revision: number; defaultVersionId: string;
  versions: Pick<Version, "id" | "versionNumber">[]; status: "READY" | "REVOKED"; expiresAt: string | null };
type Publication = PublicationSummary & { publicPath: string };
type Fixture = { chatId: string; artifactId: string; versions: Version[];
  append(): Promise<Version>; cleanup(): Promise<void> };

function editionHtml(version: number): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Field notes</title>
    <style>*{box-sizing:border-box}body{margin:0;background:#f4f2e9;color:#223a30;font:16px system-ui}main{max-width:680px;margin:auto;padding:20px;display:grid;gap:14px}h1,p{margin:0}h1{font-size:clamp(23px,5vw,34px);line-height:1.15}#edition{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#637c68}.progress{display:flex;align-items:center;gap:24px}#score{font-size:48px;font-variant-numeric:tabular-nums}svg{width:min(220px,55%);height:54px}button,input{font:inherit;border:1px solid #b0beac;border-radius:6px;min-height:44px;padding:10px 14px}button{background:#294d3c;color:#fff;cursor:pointer}label{display:grid;gap:6px;font-size:13px}input{width:100%;background:#fff;color:#223a30}.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:end}.actions label{flex:1;min-width:140px}#note{overflow-wrap:anywhere;font-size:13px;min-height:18px}@media(max-height:480px){main{padding:14px;gap:8px}.progress{gap:16px}#score{font-size:36px}}</style></head>
    <body><main><p id="edition">Edition v${version}</p><h1>Small steps. Shared progress.</h1>
    <div class="progress"><output id="score">0</output><svg viewBox="0 0 220 54" role="img" aria-label="Progress chart"><path d="M2 49H218" stroke="#b0beac"/><path d="M4 44L46 36L88 40L130 23L172 18L216 5" fill="none" stroke="#547d54" stroke-width="4"/></svg><button id="step">Add one step</button></div>
    <div class="actions"><label>Private note<input id="entry" autocomplete="off"></label><button id="save">Save note</button></div><output id="note"></output><span hidden>versioned-source-${version}-only</span>
    </main><script>const el=id=>document.getElementById(id);let score=Number(localStorage.getItem('steps')||0);el('score').textContent=String(score);el('note').textContent=localStorage.getItem('note')||'';el('step').onclick=()=>{el('score').textContent=String(++score);localStorage.setItem('steps',String(score));};el('save').onclick=()=>{localStorage.setItem('note',el('entry').value);el('note').textContent=el('entry').value;};</script></body></html>`;
}

async function createFixture(page: Page): Promise<Fixture> {
  await authenticateWithLocalToken(page.request);
  const chatResponse = await page.request.post("/api/chats", { data: {
    title: `Versioned artifact fixture ${randomUUID().slice(0, 8)}`, memoryMode: "EXCLUDED"
  } });
  expect(chatResponse.status()).toBe(201);
  const chatId = (await chatResponse.json()).chat.id as string;
  let artifactId: string | null = null;
  const versions: Version[] = [];
  async function cleanup() {
    const statuses: number[] = [];
    for (const path of [...(artifactId ? [`/api/artifacts/${artifactId}`] : []), `/api/chats/${chatId}`]) {
      const response = await page.request.delete(path);
      if (!response.ok() && response.status() !== 404) statuses.push(response.status());
    }
    expect(statuses, "Only owned synthetic artifacts and chats are removed").toEqual([]);
  }
  async function append(): Promise<Version> {
    const number = versions.length + 1;
    const response = await page.request.post("/api/artifacts", { data: {
      sourceChatId: chatId, ...(artifactId ? { artifactId } : {}), operation: {
        intent: artifactId ? "update" : "create", ...(artifactId ? { baseVersionId: versions.at(-1)!.id } : {}),
        kind: "game", title, entrypoint: "index.html", files: [
          { path: "index.html", mimeType: "text/html", text: editionHtml(number) },
          { path: "edition.json", mimeType: "application/json", text: JSON.stringify({ edition: number }) }
        ]
      }
    } });
    expect(response.status()).toBe(201);
    const version = (await response.json()).version as Version;
    expect(version.versionNumber).toBe(number);
    artifactId = version.artifactId; versions.push(version);
    return version;
  }
  try {
    for (let index = 0; index < 5; index++) await append();
    return { chatId, artifactId: artifactId!, versions, append, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

async function publishSet(page: Page, fixture: Fixture, numbers = [1, 3, 5], defaultNumber = 3): Promise<Publication> {
  const response = await page.request.post(`/api/artifacts/${fixture.artifactId}/publish`, { data: {
    mode: "version_set", versionIds: numbers.map(number => fixture.versions[number - 1].id),
    defaultVersionId: fixture.versions[defaultNumber - 1].id, expiresInDays: 7
  } });
  expect(response.status()).toBe(201);
  return (await response.json()).publication as Publication;
}

async function loadSet(page: Page, publication: Pick<Publication, "id">): Promise<PublicationSummary> {
  const response = await page.request.get(`/api/artifacts/publications/${publication.id}`);
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(Object.hasOwn(body.publication, "publicPath")).toBe(false);
  return body.publication as PublicationSummary;
}

async function changeSet(page: Page, publication: Pick<Publication, "id">,
  change: { action: "add" | "reorder"; versionIds: string[] } | { action: "remove" | "set_default"; versionId: string }): Promise<PublicationSummary> {
  const before = await loadSet(page, publication);
  const response = await page.request.patch(`/api/artifacts/publications/${publication.id}`, { data: {
    expectedRevision: before.revision, ...change
  } });
  expect(response.status()).toBe(200);
  const after = (await response.json()).publication as PublicationSummary;
  expect(after.revision).toBe(before.revision + 1);
  return after;
}

function gate(): { promise: Promise<void>; release(): void } {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

async function expectGate(signal: ReturnType<typeof gate>, label: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([signal.promise, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`The expected ${label} was not observed`)), 15_000);
    })]);
  } finally { clearTimeout(timeout); }
}

function publicApi(publicPath: string): string {
  expect(/^\/a\/[A-Za-z0-9_-]{32,128}$/u.test(publicPath), "A publication returns a bounded bearer path").toBe(true);
  return publicPath.replace(/^\/a\//u, "/api/artifact-public/");
}

function privacyHeaders(headers: Record<string, string>): void {
  expect(headers["cache-control"]).toContain("no-store");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["x-robots-tag"]).toContain("noindex");
}

function containsPrivateIdentity(text: string, fixture: Fixture): boolean {
  return [fixture.artifactId, fixture.chatId, ...fixture.versions.map(version => version.id)]
    .some(value => text.includes(value));
}

async function expectEdition(page: Page, number: number): Promise<void> {
  await expect(page.getByRole("button", { name: `Version v${number}`, exact: true })).toBeVisible();
  await expect(preview(page).locator("#edition")).toHaveText(`Edition v${number}`);
  await expect(page.getByRole("button", { name: "Download", exact: true })).toBeEnabled();
}

async function chooseEdition(page: Page, number: number, keyboard = false): Promise<void> {
  const trigger = page.getByRole("button", { name: /^Version v\d+$/u });
  if (keyboard) { await trigger.focus(); await trigger.press("Enter"); }
  else await trigger.click();
  const option = page.getByRole("menu", { name: "Published versions", exact: true })
    .getByRole("menuitem", { name: `v${number}`, exact: true });
  if (keyboard) { await option.focus(); await option.press("Enter"); }
  else await option.click();
}

async function expectOptions(page: Page, numbers: number[]): Promise<void> {
  await page.getByRole("button", { name: /^Version v\d+$/u }).click();
  const options = page.getByRole("menu", { name: "Published versions", exact: true }).getByRole("menuitem");
  await expect(options).toHaveCount(numbers.length);
  for (let index = 0; index < numbers.length; index++) await expect(options.nth(index)).toHaveAccessibleName(`v${numbers[index]}`);
  await page.keyboard.press("Escape");
}

// Read bounded ZIP records independently of the product's exporter. No archive is
// extracted to disk; both the local entries and central-directory count must fit.
function zipEntries(bytes: Buffer): Map<string, Buffer> {
  expect(bytes.length).toBeLessThan(1_000_000);
  expect(bytes.readUInt32LE(bytes.length - 22)).toBe(0x06054b50);
  const count = bytes.readUInt16LE(bytes.length - 12);
  const centralOffset = bytes.readUInt32LE(bytes.length - 6);
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset < centralOffset) {
    expect(bytes.readUInt32LE(offset)).toBe(0x04034b50);
    expect(bytes.readUInt16LE(offset + 8)).toBe(8);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const size = bytes.readUInt32LE(offset + 22);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    expect(/^(?:index\.html|edition\.json)$/u.test(name)).toBe(true);
    expect(entries.has(name)).toBe(false);
    const start = offset + 30 + nameLength + extraLength;
    expect(start + compressedSize).toBeLessThanOrEqual(centralOffset);
    const body = inflateRawSync(bytes.subarray(start, start + compressedSize), { maxOutputLength: 100_000 });
    expect(body.length).toBe(size); entries.set(name, body);
    offset = start + compressedSize;
  }
  expect(offset).toBe(centralOffset);
  expect(entries.size).toBe(count);
  expect([...entries.keys()].sort()).toEqual(["edition.json", "index.html"]);
  expect(bytes.readUInt32LE(centralOffset)).toBe(0x02014b50);
  return entries;
}

async function downloadEdition(page: Page, publication: Publication, number: number, fixture: Fixture): Promise<Buffer> {
  const path = publicApi(publication.publicPath);
  const responsePromise = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === path && url.searchParams.get("download") === "zip";
  });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const [response, download] = await Promise.all([responsePromise, downloadPromise]);
  expect(response.status()).toBe(200); privacyHeaders(response.headers());
  expect(await response.request().headerValue(versionHeader)).toBe(String(number));
  expect(response.headers()[versionHeader]).toBe(String(number));
  expect(new URL(response.url()).search).toBe("?download=zip");
  expect(response.headers()["content-type"]).toBe("application/zip");
  expect(response.headers()["content-disposition"]).toContain("filename*=UTF-8''");
  expect(download.suggestedFilename()).toContain("Сад");
  expect(await download.failure()).toBeNull();
  // Read the saved file: Chromium's response.body() fallback can refetch an
  // attachment without its version-selector header.
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  const files = zipEntries(bytes);
  expect(JSON.parse(files.get("edition.json")!.toString())).toEqual({ edition: number });
  const html = files.get("index.html")!.toString();
  expect(html).toContain(`versioned-source-${number}-only`);
  expect(containsPrivateIdentity(html, fixture)).toBe(false);
  return bytes;
}

async function openShare(page: Page, fixture: Fixture): Promise<Locator> {
  await page.goto(`/artifacts/${fixture.artifactId}/versions/${fixture.versions.at(-1)!.id}`);
  await expect(preview(page).locator("#edition")).toHaveText(`Edition v${fixture.versions.length}`);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Share “${title}”`, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function screenshotMatrix(page: Page, testInfo: TestInfo, surface: string, dialog?: Locator): Promise<void> {
  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; document.documentElement.dataset.colorScheme = value; }, theme);
    for (const size of viewports) {
      await page.setViewportSize(size);
      await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(size);
      await expectNoHorizontalOverflow(page);
      if (dialog) {
        await expectWithinViewport(page, dialog);
        await expect.poll(() => dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        await dialog.getByRole("button", { name: "Close", exact: true }).scrollIntoViewIfNeeded();
        await expectCenterUnobscured(dialog.getByRole("button", { name: "Close", exact: true }));
      } else {
        await expectWithinViewport(page, page.getByRole("button", { name: /^Version v\d+$/u }));
        await expectWithinViewport(page, page.getByRole("button", { name: "Download", exact: true }));
        await expectWithinViewport(page, page.locator("iframe.v2-artifact-frame"));
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(size.height + 1);
      }
      await page.screenshot({ path: testInfo.outputPath(`${surface}-${theme}-${size.width}x${size.height}.png`),
        ...(dialog ? { mask: [dialog.getByRole("textbox", { name: "Public link", exact: true })] } : {}) });
      if (dialog && (size.width === 390 || size.height === 390)) {
        const membership = dialog.getByRole("region", { name: "Published versions", exact: true });
        const reorder = membership.getByRole("button", { name: "Move v3 up", exact: true });
        await reorder.scrollIntoViewIfNeeded(); await expectWithinViewport(page, reorder); await expectCenterUnobscured(reorder);
        await page.screenshot({ path: testInfo.outputPath(`${surface}-members-${theme}-${size.width}x${size.height}.png`) });
      }
    }
  }
}

test("versioned public links bind permanent fragments, history and downloads to explicit membership", async ({ page, browser, baseURL }) => {
  test.setTimeout(150_000);
  const fixture = await createFixture(page);
  const anonymous = await browser.newContext({ baseURL });
  try {
    const publication = await publishSet(page, fixture);
    await fixture.append(); // Creating v6 after publication must not change its membership or default.
    const viewer = await anonymous.newPage();
    const document = await viewer.goto(publication.publicPath);
    expect(document?.status()).toBe(200); privacyHeaders(document!.headers());
    expect(document!.headers()["content-security-policy"]).toContain("frame-src 'none'");
    expect(containsPrivateIdentity(await document!.text(), fixture)).toBe(false);
    await expectEdition(viewer, 3);
    await expectOptions(viewer, [1, 3, 5]);
    await expect(viewer.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(viewer.locator("iframe.v2-artifact-frame")).toHaveAttribute("sandbox", "allow-scripts allow-forms allow-pointer-lock allow-downloads");
    await chooseEdition(viewer, 5, true); await expectEdition(viewer, 5);
    await expect.poll(() => new URL(viewer.url()).hash).toBe("#v5");
    await chooseEdition(viewer, 1); await expectEdition(viewer, 1);
    await viewer.goBack(); await expectEdition(viewer, 5);
    await viewer.goForward(); await expectEdition(viewer, 1);
    await viewer.reload(); await expectEdition(viewer, 1);
    const copiedLocation = await anonymous.newPage();
    await copiedLocation.goto(viewer.url()); await expectEdition(copiedLocation, 1);
    await copiedLocation.close();
    await downloadEdition(viewer, publication, 1, fixture);

    // The same neutral fallback covers private, unknown and malformed fragments.
    for (const fragment of ["#v6", "#v99999", "#not-a-version"]) {
      await viewer.goto(publication.publicPath + fragment);
      await expectEdition(viewer, 3);
      await expect(viewer.getByRole("status")).toContainText("Requested version is unavailable. Showing v3.");
      await expect.poll(() => new URL(viewer.url()).hash).toBe("#v3");
    }
    const api = publicApi(publication.publicPath);
    const manifest = await anonymous.request.get(`${api}/manifest`);
    expect(manifest.status()).toBe(200); privacyHeaders(manifest.headers());
    expect(await manifest.json()).toEqual({ publication: { mode: "version_set", title, kind: "game",
      expiresAt: expect.any(String), defaultVersionNumber: 3,
      versions: [1, 3, 5].map(versionNumber => ({ versionNumber, title, kind: "game" })) } });
    for (const selector of ["2", "4", "6", "0", "-1", "03", "3,5", "2147483648", fixture.versions[2].id]) {
      const response = await anonymous.request.get(api, { headers: { [versionHeader]: selector } });
      expect(response.status()).toBe(404); privacyHeaders(response.headers());
      expect(await response.json()).toEqual({ error: "artifact_not_found" });
    }
    const privateDownload = await anonymous.request.get(`${api}?download=zip`, { headers: { [versionHeader]: "6" } });
    expect(privateDownload.status()).toBe(404); privacyHeaders(privateDownload.headers());
    expect(await privateDownload.json()).toEqual({ error: "artifact_not_found" });
    const selected = await anonymous.request.get(api, { headers: { [versionHeader]: "3" } });
    expect(selected.status()).toBe(200); privacyHeaders(selected.headers());
    expect(selected.headers()[versionHeader]).toBe("3");
    const selectedBody = await selected.text();
    expect(selectedBody).toContain("versioned-source-3-only");
    expect(containsPrivateIdentity(selectedBody, fixture)).toBe(false);
    for (const number of [2, 4, 6]) expect(selectedBody.includes(`versioned-source-${number}-only`)).toBe(false);

    const singleResponse = await page.request.post(`/api/artifacts/${fixture.artifactId}/publish`, { data: { versionId: fixture.versions[0].id } });
    expect(singleResponse.status()).toBe(201);
    const single = (await singleResponse.json()).publication as { publicPath: string };
    const unchangedSingle = await anonymous.request.get(publicApi(single.publicPath));
    expect(unchangedSingle.status()).toBe(200);
    expect(await unchangedSingle.text()).toContain("versioned-source-1-only");
  } finally { await anonymous.close(); await fixture.cleanup(); }
});

test("versioned owners manage membership and guard link rotation against lost responses and revocation", async ({ page, context, browser, baseURL }) => {
  test.setTimeout(180_000);
  const fixture = await createFixture(page);
  const anonymous = await browser.newContext({ baseURL });
  const releaseReissue = gate();
  const releaseSuccessfulReissue = gate();
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(baseURL!).origin });
    await page.addInitScript(() => {
      if (window !== window.top) return;
      const write = navigator.clipboard.writeText.bind(navigator.clipboard);
      let attempts = 0;
      Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: (text: string) => {
        if (attempts++ === 0) return Promise.reject(new DOMException("Synthetic clipboard denial", "NotAllowedError"));
        return write(text);
      } });
    });
    let dialog = await openShare(page, fixture);
    await expect(dialog.getByRole("radio", { name: "Single version", exact: true })).toBeChecked();
    await expect(dialog.getByRole("button", { name: "Publish v5", exact: true })).toBeVisible();
    await dialog.getByRole("radio", { name: "Version set", exact: true }).check();
    await dialog.getByRole("checkbox", { name: "Include v5", exact: true }).uncheck();
    for (let number = 1; number <= 5; number++) {
      await dialog.getByRole("checkbox", { name: `Include v${number}`, exact: true }).setChecked([1, 3, 5].includes(number));
    }
    await dialog.getByRole("combobox", { name: "Default version", exact: true }).selectOption(fixture.versions[2].id);
    await dialog.getByRole("combobox", { name: "Link expires", exact: true }).selectOption("7");
    const publishResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/artifacts/${fixture.artifactId}/publish` && response.request().method() === "POST");
    await dialog.getByRole("button", { name: "Publish versions", exact: true }).click();
    const created = await publishResponse;
    expect(created.status()).toBe(201);
    const publication = (await created.json()).publication as Publication;
    const publicLink = dialog.getByRole("textbox", { name: "Public link", exact: true });
    await expect(publicLink).toBeVisible();
    await expect(dialog.getByRole("status")).toContainText("Copy the link now");
    const originalUrl = await publicLink.inputValue();
    expect(new URL(originalUrl).pathname === publication.publicPath).toBe(true);
    await dialog.getByRole("button", { name: "Copy link", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("Link copied");
    expect(await page.evaluate(async url => (await navigator.clipboard.readText()) === url, originalUrl)).toBe(true);
    expect(await page.evaluate(url => {
      const token = new URL(url).pathname.split("/").at(-1)!;
      return JSON.stringify(Object.entries(localStorage)).includes(token);
    }, originalUrl)).toBe(false);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await fixture.append();
    dialog = await openShare(page, fixture);
    await expect(dialog.getByRole("textbox", { name: "Public link", exact: true })).toHaveCount(0);
    const row = dialog.getByTestId(`artifact-publication-${publication.id}`);
    await row.getByRole("button", { name: "Manage versions", exact: true }).click();
    const manager = row.getByRole("region", { name: "Published versions", exact: true });
    await expect(manager.getByRole("button", { name: "Remove v3", exact: true })).toBeDisabled();
    const before = await loadSet(page, publication);
    expect(before.versions.map(version => version.versionNumber)).toEqual([1, 3, 5]);
    const forbidden = await page.request.patch(`/api/artifacts/publications/${publication.id}`, { data: {
      expectedRevision: before.revision, action: "remove", versionId: fixture.versions[2].id
    } });
    expect(forbidden.status()).toBe(409);
    expect(await forbidden.json()).toEqual({ error: "artifact_publication_default_required" });
    await manager.getByRole("button", { name: "Make v1 default", exact: true }).click();
    await expect(manager.getByRole("button", { name: "Remove v1", exact: true })).toBeDisabled();
    await manager.getByRole("button", { name: "Remove v3", exact: true }).click();
    await expect(manager.getByRole("listitem", { name: "v3", exact: true })).toHaveCount(0);
    const retained = await page.request.get(`/api/artifacts/${fixture.artifactId}/versions/${fixture.versions[2].id}/content`);
    expect(retained.status()).toBe(200);
    expect(await retained.text()).toContain("versioned-source-3-only");
    await manager.getByRole("combobox", { name: "Add a version", exact: true }).selectOption(fixture.versions[2].id);
    await manager.getByRole("button", { name: "Add version", exact: true }).click();
    await expect(manager.getByRole("listitem", { name: "v3", exact: true })).toBeVisible();
    await manager.getByRole("button", { name: "Move v5 up", exact: true }).click();
    await expect(manager.getByRole("listitem").first()).toHaveAccessibleName("v5");
    await manager.getByRole("button", { name: "Make v3 default", exact: true }).click();
    await expect(manager.getByRole("button", { name: "Remove v3", exact: true })).toBeDisabled();
    await expect(manager.getByRole("button", { name: "Remove v1", exact: true })).toBeEnabled();
    const frozen = await loadSet(page, publication);
    expect(frozen.versions.map(version => version.versionNumber)).toEqual([5, 1, 3]);
    expect(frozen.defaultVersionId === fixture.versions[2].id).toBe(true);
    expect(typeof frozen.expiresAt).toBe("string");
    const singleton = await publishSet(page, fixture, [1], 1);
    const removeLast = await page.request.patch(`/api/artifacts/publications/${singleton.id}`, { data: {
      expectedRevision: singleton.revision, action: "remove", versionId: fixture.versions[0].id
    } });
    expect(removeLast.status()).toBe(409);
    expect(await removeLast.json()).toEqual({ error: "artifact_publication_empty" });
    const viewer = await anonymous.newPage();
    await viewer.goto(publication.publicPath + "#v3"); await expectEdition(viewer, 3);
    await expectOptions(viewer, [5, 1, 3]);

    const reissuePath = `/api/artifacts/publications/${publication.id}/reissue`;
    let lost: Publication | undefined;
    let lostRequests = 0;
    await page.route(url => url.pathname === reissuePath, async route => {
      lostRequests++;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      lost = (await response.json()).publication as Publication;
      await route.abort("failed"); // The mutation commits; only its one-time secret response is lost.
    });
    await row.getByRole("button", { name: "Reissue link", exact: true }).click();
    await expect(row.getByText("The old link will stop working. Published versions and the expiry date stay the same.", { exact: true })).toBeVisible();
    await expect(row).toContainText("The new link starts with fresh saved state in each viewer’s browser. Progress from the old link is not transferred.");
    await row.getByRole("button", { name: "Reissue link", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("The new link could not be retrieved");
    await expect(dialog.getByRole("alert")).toContainText("cannot be recovered");
    expect(lostRequests).toBe(1);
    expect(Boolean(lost)).toBe(true);
    await expect(dialog.getByRole("textbox", { name: "Public link", exact: true })).toHaveCount(0);
    expect((await anonymous.request.get(publicApi(publication.publicPath))).status()).toBe(404);
    expect((await anonymous.request.get(publicApi(lost!.publicPath))).status()).toBe(200);
    await page.unrouteAll({ behavior: "wait" });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    dialog = await openShare(page, fixture);
    const currentRow = dialog.getByTestId(`artifact-publication-${publication.id}`);
    await expect(dialog.getByRole("textbox", { name: "Public link", exact: true })).toHaveCount(0);
    await currentRow.getByRole("button", { name: "Reissue link", exact: true }).click();
    let explicitRequests = 0;
    await page.route(url => url.pathname === reissuePath, async route => {
      explicitRequests++;
      const response = await route.fetch();
      await releaseSuccessfulReissue.promise;
      await route.fulfill({ response });
    });
    const recoveredResponse = page.waitForResponse(response => new URL(response.url()).pathname === reissuePath);
    await currentRow.getByRole("button", { name: "Reissue link", exact: true }).dblclick({ delay: 10 });
    releaseSuccessfulReissue.release();
    const recovered = (await (await recoveredResponse).json()).publication as Publication;
    await expect(dialog.getByRole("textbox", { name: "Public link", exact: true })).toBeVisible();
    expect(explicitRequests).toBe(1);
    expect(recovered.revision).toBe(frozen.revision + 2);
    expect(recovered.versions.map(version => version.versionNumber)).toEqual([5, 1, 3]);
    expect(recovered.defaultVersionId === frozen.defaultVersionId).toBe(true);
    expect(recovered.expiresAt).toBe(frozen.expiresAt);
    expect((await anonymous.request.get(publicApi(lost!.publicPath))).status()).toBe(404);
    await viewer.goto(recovered.publicPath); await expectEdition(viewer, 3);
    await page.unrouteAll({ behavior: "wait" });

    // Another owner tab revokes after confirmation, before this tab's mutation.
    await currentRow.getByRole("button", { name: "Reissue link", exact: true }).click();
    const reachedReissue = gate();
    await page.route(url => url.pathname === reissuePath, async route => {
      reachedReissue.release(); await releaseReissue.promise; await route.continue();
    });
    await currentRow.getByRole("button", { name: "Reissue link", exact: true }).click();
    await expectGate(reachedReissue, "concurrent reissue request");
    const revoked = await page.request.post(`/api/artifacts/publications/${publication.id}/revoke`, { data: { expectedRevision: recovered.revision } });
    expect(revoked.status()).toBe(200);
    releaseReissue.release();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Public link", exact: true })).toHaveCount(0);
    expect((await loadSet(page, publication)).status).toBe("REVOKED");
    expect((await anonymous.request.get(publicApi(recovered.publicPath))).status()).toBe(404);
  } finally { releaseReissue.release(); releaseSuccessfulReissue.release(); await anonymous.close(); await fixture.cleanup(); }
});

test("versioned public state follows tokens across versions and never enters downloaded files", async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  const fixture = await createFixture(page);
  const anonymous = await browser.newContext({ baseURL });
  try {
    const first = await publishSet(page, fixture);
    const second = await publishSet(page, fixture);
    const viewer = await anonymous.newPage();
    await viewer.goto(first.publicPath + "#v3"); await expectEdition(viewer, 3);
    const originalZip = await downloadEdition(viewer, first, 3, fixture);
    await chooseEdition(viewer, 1); await expectEdition(viewer, 1);
    const note = `This browser alone ${randomUUID()}`;
    await preview(viewer).getByRole("textbox", { name: "Private note", exact: true }).fill(note);
    await preview(viewer).getByRole("button", { name: "Save note", exact: true }).click();
    await preview(viewer).getByRole("button", { name: "Add one step", exact: true }).click();
    await preview(viewer).getByRole("button", { name: "Add one step", exact: true }).click();
    await expect(preview(viewer).locator("#score")).toHaveText("2");
    await chooseEdition(viewer, 3); await expectEdition(viewer, 3);
    await expect(preview(viewer).locator("#score")).toHaveText("2");
    await expect(preview(viewer).locator("#note")).toHaveText(note);
    await viewer.reload(); await expectEdition(viewer, 3);
    await expect(preview(viewer).locator("#score")).toHaveText("2");
    const statefulZip = await downloadEdition(viewer, first, 3, fixture);
    expect(createHash("sha256").update(statefulZip).digest("hex")).toBe(createHash("sha256").update(originalZip).digest("hex"));
    expect([...zipEntries(statefulZip).values()].some(bytes => bytes.toString().includes(note))).toBe(false);
    const serverCopy = await page.request.get(`/api/artifacts/${fixture.artifactId}/versions/${fixture.versions[2].id}/content?download=zip`);
    expect(serverCopy.status()).toBe(200);
    expect(createHash("sha256").update(await serverCopy.body()).digest("hex")).toBe(createHash("sha256").update(originalZip).digest("hex"));

    const other = await anonymous.newPage();
    await other.goto(second.publicPath + "#v3"); await expectEdition(other, 3);
    await expect(preview(other).locator("#score")).toHaveText("0");
    await expect(preview(other).locator("#note")).toHaveText("");
    await preview(other).getByRole("button", { name: "Add one step", exact: true }).click();
    await expect(preview(other).locator("#score")).toHaveText("1");
    await expect.poll(() => viewer.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("aiqsa.artifact.state.pub.")).length)).toBe(2);
    expect(await viewer.evaluate(paths => {
      const stored = JSON.stringify(Object.entries(localStorage));
      return paths.some(path => stored.includes(path.split("/").at(-1)!));
    }, [first.publicPath, second.publicPath])).toBe(false);
    await expect(preview(viewer).locator("#score")).toHaveText("2");
    await viewer.getByRole("button", { name: "Artifact actions", exact: true }).click();
    await viewer.getByRole("menuitem", { name: "Reset saved state", exact: true }).click();
    await expect(preview(viewer).locator("#score")).toHaveText("0");
    await expect(preview(viewer).locator("#note")).toHaveText("");
    await expect(preview(other).locator("#score")).toHaveText("1");
    await preview(viewer).getByRole("button", { name: "Add one step", exact: true }).click();
    await expect(preview(viewer).locator("#score")).toHaveText("1");
    const revision = (await loadSet(page, first)).revision;
    const rotatedResponse = await page.request.post(`/api/artifacts/publications/${first.id}/reissue`, { data: { expectedRevision: revision } });
    expect(rotatedResponse.ok()).toBe(true);
    const rotated = (await rotatedResponse.json()).publication as Publication;
    await viewer.goto(rotated.publicPath + "#v1"); await expectEdition(viewer, 1);
    await expect(preview(viewer).locator("#score")).toHaveText("0");
    await expect(preview(viewer).locator("#note")).toHaveText("");
    await other.reload(); await expectEdition(other, 3);
    await expect(preview(other).locator("#score")).toHaveText("1");
    expect((await anonymous.request.get(publicApi(first.publicPath))).status()).toBe(404);
  } finally { await anonymous.close(); await fixture.cleanup(); }
});

test("versioned public loading, delayed switches and failures preserve selected content authority", async ({ page, browser, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const fixture = await createFixture(page);
  const anonymous = await browser.newContext({ baseURL });
  const releaseInitial = gate();
  const releaseLate = gate();
  try {
    const publication = await publishSet(page, fixture);
    const api = publicApi(publication.publicPath);
    const viewer = await anonymous.newPage();
    const initialArrived = gate();
    await viewer.route(url => url.pathname === api, async route => {
      const response = await route.fetch();
      initialArrived.release(); await releaseInitial.promise;
      await route.fulfill({ response });
    });
    await viewer.goto(publication.publicPath + "#v3"); await expectGate(initialArrived, "initial content request");
    await expect(viewer.getByRole("main").getByRole("status")).toContainText("Loading artifact");
    await expect(viewer.locator("iframe.v2-artifact-frame")).toHaveCount(0);
    await expect(viewer.getByRole("button", { name: "Download", exact: true })).toBeDisabled();
    await viewer.screenshot({ path: testInfo.outputPath("versioned-public-loading.png") });
    releaseInitial.release(); await expectEdition(viewer, 3);
    await viewer.unrouteAll({ behavior: "wait" });

    const lateArrived = gate();
    const lateFinished = gate();
    let delayNextOne = true;
    await viewer.route(url => url.pathname === api, async route => {
      if (route.request().headers()[versionHeader] !== "1" || !delayNextOne) return route.continue();
      delayNextOne = false;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      lateArrived.release(); await releaseLate.promise;
      // The old browser request may already be aborted by the new selection.
      try { await route.fulfill({ response }); } catch { /* An aborted stale request is the desired outcome. */ }
      finally { lateFinished.release(); }
    });
    await chooseEdition(viewer, 1); await expectGate(lateArrived, "delayed content request");
    await expect(viewer.getByRole("button", { name: "Version v1", exact: true })).toBeVisible();
    await expect(viewer.getByRole("button", { name: "Download", exact: true })).toBeDisabled();
    await expect(viewer.locator("iframe.v2-artifact-frame")).toHaveCount(0);
    await chooseEdition(viewer, 5); await expectEdition(viewer, 5);
    releaseLate.release(); await expectGate(lateFinished, "late content settlement");
    await expectEdition(viewer, 5);
    await expect.poll(() => new URL(viewer.url()).hash).toBe("#v5");
    await downloadEdition(viewer, publication, 5, fixture);
    await viewer.unrouteAll({ behavior: "wait" });
    // A seeded walk makes arbitrary rapid actions reproducible in the report.
    let seed = 42;
    for (let index = 0; index < 6; index++) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      await chooseEdition(viewer, [1, 3, 5][seed % 3]);
    }
    await chooseEdition(viewer, 5);
    await expectEdition(viewer, 5);

    let failNetwork = true;
    await viewer.route(url => url.pathname === api, route => {
      if (failNetwork) { failNetwork = false; return route.abort("failed"); }
      return route.continue();
    });
    await chooseEdition(viewer, 1);
    await expect(viewer.getByRole("main").getByRole("alert")).toBeVisible();
    await expect(viewer.locator("iframe.v2-artifact-frame")).toHaveCount(0);
    await expect(viewer.getByRole("button", { name: "Download", exact: true })).toBeDisabled();
    await viewer.getByRole("button", { name: "Try again", exact: true }).click();
    await expectEdition(viewer, 1);
    await viewer.unrouteAll({ behavior: "wait" });

    let rateLimited = true;
    await viewer.route(url => url.pathname === api, route => {
      if (!rateLimited) return route.continue();
      rateLimited = false;
      return route.fulfill({ status: 429, json: { error: "rate_limit_exceeded" }, headers: {
        "retry-after": "1", "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow, noarchive"
      } });
    });
    await chooseEdition(viewer, 3);
    await expect(viewer.getByRole("main").getByRole("alert")).toContainText("Too many requests. Wait a moment and try again.");
    await viewer.screenshot({ path: testInfo.outputPath("versioned-public-rate-limited.png") });
    await viewer.getByRole("button", { name: "Try again", exact: true }).click();
    await expectEdition(viewer, 3);
    await viewer.unrouteAll({ behavior: "wait" });

    // A corrupt selected snapshot has the same 404 as an unavailable body.
    // Its fresh, real manifest still includes v5, so it must NOT show v3.
    await viewer.route(url => url.pathname === api, route => route.fulfill({ status: 404,
      json: { error: "artifact_not_found" }, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex" } }));
    await chooseEdition(viewer, 5);
    await expect(viewer.getByRole("main").getByRole("alert")).toBeVisible();
    await expect(viewer.getByRole("button", { name: "Version v5", exact: true })).toBeVisible();
    await expect(viewer.locator("iframe.v2-artifact-frame")).toHaveCount(0);
    await expect(viewer.getByText(/Requested version is unavailable/u)).toHaveCount(0);
    await viewer.screenshot({ path: testInfo.outputPath("versioned-public-corrupt-selected.png") });
    await viewer.unrouteAll({ behavior: "wait" });
    await viewer.getByRole("button", { name: "Try again", exact: true }).click(); await expectEdition(viewer, 5);

    await chooseEdition(viewer, 1); await expectEdition(viewer, 1);
    await changeSet(page, publication, { action: "remove", versionId: fixture.versions[0].id });
    await viewer.reload(); await expectEdition(viewer, 3);
    await expect(viewer.getByRole("status")).toContainText("Requested version is unavailable. Showing v3.");
    await expect.poll(() => new URL(viewer.url()).hash).toBe("#v3");
    const removed = await anonymous.request.get(api, { headers: { [versionHeader]: "1" } });
    expect(removed.status()).toBe(404);
    expect(await removed.json()).toEqual({ error: "artifact_not_found" });
    await changeSet(page, publication, { action: "set_default", versionId: fixture.versions[4].id });
    await viewer.goto(publication.publicPath); await expectEdition(viewer, 5);
    await viewer.goto(publication.publicPath + "#v99999"); await expectEdition(viewer, 5);
    await expect(viewer.getByRole("status")).toContainText("Requested version is unavailable. Showing v5.");
    const current = await loadSet(page, publication);
    const revoke = await page.request.post(`/api/artifacts/publications/${publication.id}/revoke`, { data: { expectedRevision: current.revision } });
    expect(revoke.status()).toBe(200);
    const revokedDocument = await viewer.reload();
    expect(revokedDocument?.status()).toBe(404); privacyHeaders(revokedDocument!.headers());
    await expect(viewer.locator("iframe.v2-artifact-frame")).toHaveCount(0);
    await expect(viewer.getByText(/Requested version is unavailable/u)).toHaveCount(0);
    for (const suffix of ["/manifest", "", "?download=zip"]) {
      const denied = await anonymous.request.get(api + suffix, { headers: { [versionHeader]: "3" } });
      expect(denied.status()).toBe(404); privacyHeaders(denied.headers());
      expect(await denied.json()).toEqual({ error: "artifact_not_found" });
    }
  } finally { releaseInitial.release(); releaseLate.release(); await anonymous.close(); await fixture.cleanup(); }
});

test("versioned Share and public controls fit desktop, tablet and phone with light, dark and touch", async ({ page, browser, baseURL }, testInfo) => {
  test.setTimeout(240_000);
  const fixture = await createFixture(page);
  const anonymous = await browser.newContext({ baseURL, reducedMotion: "reduce" });
  let touch: BrowserContext | undefined;
  try {
    const publication = await publishSet(page, fixture);
    const dialog = await openShare(page, fixture);
    await dialog.getByTestId(`artifact-publication-${publication.id}`).getByRole("button", { name: "Manage versions", exact: true }).click();
    await screenshotMatrix(page, testInfo, "versioned-share", dialog);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    const viewer = await anonymous.newPage();
    await viewer.goto(publication.publicPath + "#v3"); await expectEdition(viewer, 3);
    await chooseEdition(viewer, 1, true); await expectEdition(viewer, 1);
    await screenshotMatrix(viewer, testInfo, "versioned-public");

    touch = await browser.newContext({ baseURL, isMobile: true, hasTouch: true, reducedMotion: "reduce", viewport: { width: 390, height: 844 } });
    const mobile = await touch.newPage();
    await mobile.goto(publication.publicPath + "#v3"); await expectEdition(mobile, 3);
    expect(await mobile.evaluate(() => navigator.maxTouchPoints > 0)).toBe(true);
    let steps = 0;
    for (const theme of ["light", "dark"]) {
      await mobile.evaluate(value => { document.documentElement.dataset.theme = value; document.documentElement.dataset.colorScheme = value; }, theme);
      for (const size of viewports.slice(1)) {
        await mobile.setViewportSize(size);
        await expect.poll(() => mobile.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(size);
        const trigger = mobile.getByRole("button", { name: /^Version v\d+$/u });
        await expectTouchSafe(trigger); await expectCenterUnobscured(trigger); await trigger.tap();
        const menu = mobile.getByRole("menu", { name: "Published versions", exact: true });
        await expectWithinViewport(mobile, menu);
        const number = steps % 2 === 0 ? 1 : 5;
        const option = menu.getByRole("menuitem", { name: `v${number}`, exact: true });
        await expectTouchSafe(option); await option.tap(); await expectEdition(mobile, number);
        await preview(mobile).getByRole("button", { name: "Add one step", exact: true }).tap();
        await expect(preview(mobile).locator("#score")).toHaveText(String(++steps));
        await expectTouchSafe(mobile.getByRole("button", { name: "Download", exact: true }));
        await expectNoHorizontalOverflow(mobile);
        await expectWithinViewport(mobile, mobile.locator("iframe.v2-artifact-frame"));
        await mobile.screenshot({ path: testInfo.outputPath(`versioned-public-touch-${theme}-${size.width}x${size.height}.png`) });
      }
    }
    await mobile.setViewportSize({ width: 390, height: 844 });
    await mobile.getByRole("button", { name: /^Version v\d+$/u }).tap();
    await mobile.screenshot({ path: testInfo.outputPath("versioned-public-menu-touch-dark-390x844.png") });
    await mobile.keyboard.press("Escape");
    await mobile.getByRole("button", { name: "Artifact actions", exact: true }).tap();
    const reset = mobile.getByRole("menuitem", { name: "Reset saved state", exact: true });
    await expectTouchSafe(reset); await reset.tap();
    await expect(preview(mobile).locator("#score")).toHaveText("0");
  } finally { await touch?.close(); await anonymous.close(); await fixture.cleanup(); }
});
