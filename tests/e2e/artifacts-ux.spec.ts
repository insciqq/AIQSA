import { randomUUID } from "node:crypto";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { ThreadGeneratedArtifact } from "../../lib/contracts/chats";
import { memoryConsumerSettingsFixture } from "../support/memoryFixtures";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { createGatedRunStreamFixture } from "./support/gatedRunStream";
import { expectCenterUnobscured, expectNoHorizontalOverflow, expectTouchSafe, expectWithinViewport } from "./support/layoutAssertions";
import { authenticateWithLocalToken } from "./support/localAuth";

const sizes = [
  { width: 1440, height: 900 }, { width: 1280, height: 640 },
  { width: 768, height: 1024 }, { width: 1024, height: 768 },
  { width: 390, height: 844 }, { width: 844, height: 390 }
];
type Fixture = { chatId: string; artifact: ThreadGeneratedArtifact; cleanup(): Promise<void> };

function counterHtml(version = 1) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Workshop counter</title>
    <style>body{margin:0;background:#142633;color:#f5f6ed;font:18px system-ui}main{min-height:100vh;display:grid;place-content:center;gap:24px;text-align:center;box-sizing:border-box;padding:24px}h1,p{margin:0}small{letter-spacing:.15em;text-transform:uppercase;color:#aac6c2}button{font:inherit;padding:14px 22px;border:0;border-radius:8px;background:#c8ecc7;color:#142633;cursor:pointer}output{display:block;font-size:84px;font-variant-numeric:tabular-nums}.actions{display:flex;justify-content:center;flex-wrap:wrap;gap:10px}</style></head>
    <body><main><small>Workshop · version ${version}</small><h1>Count small wins.</h1><output id="count">0</output><div class="actions"><button onclick="document.getElementById('count').textContent=++window.count">Add one</button><button onclick="location.href='https'+':'+'//artifact-navigation.invalid/blocked'">Try external navigation</button><button onclick="throw new Error('synthetic-runtime-error')">Trigger runtime error</button></div><p>One click, one step forward.</p></main><script>window.count=0;</script></body></html>`;
}

function counterFiles(version = 1) {
  return [{ path: "index.html", mimeType: "text/html", text: counterHtml(version) },
    { path: "settings.json", mimeType: "application/json", text: '{"step":1,"label":"Small wins"}' }];
}

async function createFixture(page: Page): Promise<Fixture> {
  await authenticateWithLocalToken(page.request);
  const title = `Counter for the next workshop ${randomUUID().slice(0, 8)}`;
  const chatResponse = await page.request.post("/api/chats", { data: { title: "Artifact UX fixture", memoryMode: "EXCLUDED" } });
  expect(chatResponse.ok()).toBe(true);
  const chatId = (await chatResponse.json()).chat.id as string;
  const response = await page.request.post("/api/artifacts", { data: { sourceChatId: chatId, operation: {
    intent: "create", kind: "game", title, entrypoint: "index.html",
    files: counterFiles()
  } } });
  expect(response.status()).toBe(201);
  const version = (await response.json()).version;
  const artifact: ThreadGeneratedArtifact = { artifactId: version.artifactId, versionId: version.id,
    versionNumber: version.versionNumber, title, kind: "game", entrypoint: "index.html" };
  return { chatId, artifact, cleanup: async () => {
    const artifactResponse = await page.request.delete(`/api/artifacts/${artifact.artifactId}`, { maxRetries: 2 });
    const chatCleanupResponse = await page.request.delete(`/api/chats/${chatId}`, { maxRetries: 2 });
    expect([artifactResponse, chatCleanupResponse].filter(response => !response.ok() && response.status() !== 404)
      .map(response => response.status()), "Every owned artifact fixture is cleaned up").toEqual([]);
  } };
}

async function updateFixture(page: Page, fixture: Fixture, base: ThreadGeneratedArtifact): Promise<ThreadGeneratedArtifact> {
  const response = await page.request.post("/api/artifacts", { data: { artifactId: base.artifactId, sourceChatId: fixture.chatId, operation: {
    intent: "update", baseVersionId: base.versionId, kind: "game", title: base.title, entrypoint: "index.html",
    files: counterFiles(base.versionNumber + 1)
  } } });
  expect(response.status()).toBe(201);
  const version = (await response.json()).version;
  return { ...base, versionId: version.id, versionNumber: version.versionNumber };
}

async function installChat(page: Page, fixture: Fixture, nextArtifact?: ThreadGeneratedArtifact) {
  const timestamp = "2026-09-20T12:00:00.000Z";
  const messages = [{ id: "artifact-question", role: "user", parentMessageId: null, text: "Build a workshop counter." },
    { id: "artifact-answer", role: "assistant", parentMessageId: "artifact-question", text: "Open the counter to try it." },
    ...nextArtifact ? [
      { id: "artifact-next-question", role: "user", parentMessageId: "artifact-answer", text: "Make another version." },
      { id: "artifact-next-answer", role: "assistant", parentMessageId: "artifact-next-question", text: "The updated counter is ready." }
    ] : []]
    .map(message => ({ id: message.id, role: message.role, parentMessageId: message.parentMessageId,
      createdAt: timestamp, errorMessage: null, status: "complete", content: { blocks: [{ type: "text", text: message.text }] },
      modelId: message.role === "assistant" ? "gpt-5.5" : null,
      modelRunId: message.role !== "assistant" ? null : message.id === "artifact-next-answer" ? "artifact-fixture-run" : "artifact-run",
      provider: message.role === "assistant" ? "openai" : null,
      artifactSummary: message.role === "assistant" ? { citations: [], sources: [], reasoningText: [],
        generatedArtifacts: [message.id === "artifact-next-answer" ? nextArtifact! : fixture.artifact] } : null }));
  await page.addInitScript(id => {
    if (window === window.top) localStorage.setItem("aiqsa.activeChatId", id);
  }, fixture.chatId);
  const chat = { id: fixture.chatId, title: "Artifact UX fixture", messages,
    activeLeafMessageId: nextArtifact ? "artifact-next-answer" : "artifact-answer", createdAt: timestamp, updatedAt: timestamp, defaultModelId: "gpt-5.5",
    defaultProvider: "openai", folderId: null, pinned: false, messageCount: messages.length, usageStats: null,
    contextStats: { approximateActiveBranchInputTokens: 0 } };
  await installMatrixCatalogFixture(page, { folders: [], chats: [chat] });
  await page.route("**/api/me/memory/settings", route => route.fulfill({ json: memoryConsumerSettingsFixture() }));
  await page.route("**/api/me/mcp", route => route.fulfill({ json: { servers: [] } }));
  return chat;
}

async function captureMatrix(page: Page, testInfo: TestInfo, surface: string, assertPageGeometry = false) {
  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => {
      document.documentElement.dataset.theme = value;
      document.documentElement.dataset.colorScheme = value;
    }, theme);
    for (const size of sizes) {
      await page.setViewportSize(size);
      await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(size);
      await expectNoHorizontalOverflow(page);
      const frame = page.locator("iframe.v2-artifact-frame");
      await expect(frame).toBeVisible();
      if (assertPageGeometry) {
        await expect.poll(async () => (await frame.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(size.height * (size.width < 640 || size.height < 480 ? 0.85 : 0.9));
        await expect.poll(async () => (await frame.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(size.width - 2);
        // A portrait height also satisfies the landscape minimum until resize
        // layout completes, so wait for the complete page to fit as well.
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(size.height + 1);
      }
      await page.screenshot({ path: testInfo.outputPath(`${surface}-${theme}-${size.width}x${size.height}.png`) });
    }
  }
}

test("standalone and public artifacts use the viewport and preserve sandbox isolation", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const fixture = await createFixture(page);
  const title = fixture.artifact.title;
  try {
    const { artifact } = fixture;
    const response = await page.goto(`/artifacts/${artifact.artifactId}/versions/${artifact.versionId}`);
    expect(response?.headers()["content-security-policy"]).toContain("frame-src 'none'");
    const frame = page.locator("iframe.v2-artifact-frame");
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-forms allow-pointer-lock allow-downloads");
    await expect(frame).toHaveAttribute("allow", "fullscreen; clipboard-write");
    await page.frameLocator("iframe.v2-artifact-frame").getByRole("button", { name: "Add one", exact: true }).click();
    await expect(page.frameLocator("iframe.v2-artifact-frame").locator("output")).toHaveText("1");
    await expect(page).toHaveTitle(`${title} · AIQSA`);
    await captureMatrix(page, testInfo, "artifact-page", true);
    await page.getByRole("tab", { name: "Code", exact: true }).click();
    await expect(page.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
    await expect(page.locator(".v2-artifact-code-scroll")).toContainText("Count small wins.");
    await page.getByRole("tab", { name: "Preview", exact: true }).click();

    await page.getByRole("button", { name: "Share", exact: true }).click();
    const share = page.getByRole("dialog", { name: `Share “${title}”` });
    await share.getByRole("button", { name: "Publish v1", exact: true }).click();
    const link = share.getByRole("textbox", { name: "Public link" });
    await expect(link).toHaveValue(/\/a\//);
    const publicUrl = await link.inputValue();
    await expect(share.getByText("Game progress is saved in each viewer’s browser.")).toBeVisible();
    await share.getByRole("button", { name: "Close", exact: true }).click();
    await page.goto(publicUrl);
    await expect(page).toHaveTitle(`${title} · AIQSA`);
    await expect(page.getByRole("tab", { name: "Code", exact: true })).toHaveCount(0);
    await captureMatrix(page, testInfo, "artifact-public", true);
    const responsePromise = page.waitForResponse(response => {
      const url = new URL(response.url());
      return /^\/api\/artifact-public\/[^/]+\/?$/u.test(url.pathname) && url.searchParams.get("download") === "zip";
    });
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    const [downloadResponse, download] = await Promise.all([responsePromise, downloadPromise]);
    expect(downloadResponse.headers()["content-type"]).toBe("application/zip");
    expect((await downloadResponse.body()).subarray(0, 2).toString()).toBe("PK");
    expect(download.suggestedFilename()).toMatch(/\.zip$/u);
    expect(await download.failure()).toBeNull();
  } finally { await fixture.cleanup(); }
});

test("chat editing keeps the draft and exact target, with a docked panel or compact sheet", async ({ page, context }, testInfo) => {
  test.setTimeout(180_000);
  const fixture = await createFixture(page);
  const title = fixture.artifact.title;
  try {
    await installChat(page, fixture);
    await page.setViewportSize({ width: 1440, height: 900 });
    const response = await page.goto("/");
    expect(response?.headers()["content-security-policy"]).toContain("frame-src 'none'");
    await expect(page.locator("[data-artifact-panel]")).toHaveCount(0);
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await composer.fill("Keep my unfinished idea");
    const card = page.getByRole("button", { name: `Open artifact: ${title}`, exact: true });
    await card.click();
    const panel = page.locator("[data-artifact-panel]");
    await expect(panel).toBeVisible();
    await expect(composer).toBeFocused();
    expect(context.pages()).toHaveLength(1);
    const outbound: string[] = [];
    page.on("request", request => { if (request.url().startsWith("https://artifact-navigation.invalid/")) outbound.push(request.url()); });
    await page.frameLocator("iframe.v2-artifact-frame").getByRole("button", { name: "Try external navigation" }).click();
    await expect.poll(() => page.frames().some(frame => frame.url().startsWith("https://artifact-navigation.invalid/"))).toBe(false);
    expect(outbound).toEqual([]);
    // A blocked document navigation may replace srcdoc with a browser error
    // document. Reopen the saved preview before exercising the edit flow.
    await panel.getByRole("button", { name: "Close artifact" }).click();
    await card.click();
    const counterButton = page.frameLocator("iframe.v2-artifact-frame").getByRole("button", { name: "Add one", exact: true });
    await counterButton.focus();
    await counterButton.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(card).toBeFocused();
    await card.click();
    await panel.getByRole("button", { name: "Edit with AI", exact: true }).click();
    await expect(page.getByTestId("composer-v2")).toContainText(`Editing “${title}” · v1`);
    await expect(composer).toHaveValue("Keep my unfinished idea");
    let requestBody: unknown;
    await page.route(`**/api/chats/${fixture.chatId}/messages`, route => {
      requestBody = route.request().postDataJSON();
      return route.fulfill({ status: 409, json: { error: "artifact_version_conflict" } });
    });
    await composer.press("Enter");
    await expect.poll(() => requestBody).toMatchObject({ artifactEdit: {
      artifactId: fixture.artifact.artifactId, versionId: fixture.artifact.versionId
    }, content: { blocks: [{ type: "text", text: "Keep my unfinished idea" }] } });
    await expect(composer).toHaveValue("Keep my unfinished idea");
    await expect(page.getByRole("button", { name: "Remove artifact edit" })).toBeVisible();
    await expect(page.locator(".v2-live-composer-error")).toContainText("A newer version exists. Open the current version and choose Edit with AI again.");
    await expect(page.getByText("artifact_version_conflict", { exact: true })).toHaveCount(0);
    await counterButton.click();
    const counter = page.frameLocator("iframe.v2-artifact-frame").locator("output");
    await expect(counter).toHaveText("1");
    await panel.getByRole("tab", { name: "Code", exact: true }).click();
    await panel.getByRole("tab", { name: "settings.json", exact: true }).click();
    await panel.getByRole("button", { name: "Expand artifact" }).click();
    await expect(panel.getByRole("tab", { name: "settings.json", exact: true })).toHaveAttribute("aria-selected", "true");
    await panel.getByRole("button", { name: "Collapse artifact" }).click();
    for (const size of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(size);
      await expect(panel).toHaveAttribute("role", size.width < 896 ? "dialog" : "complementary");
      await expect(panel.getByRole("tab", { name: "Code", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(panel.getByRole("tab", { name: "settings.json", exact: true })).toHaveAttribute("aria-selected", "true");
    }
    await panel.getByRole("tab", { name: "Preview", exact: true }).click();
    await expect(counter).toHaveText("1");
    await captureMatrix(page, testInfo, "artifact-chat");
    await expect(counter).toHaveText("1");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel).toHaveAttribute("aria-modal", "true");
    const inertComposer = page.getByRole("textbox", { name: "Message", exact: true, includeHidden: true });
    await expect.poll(() => inertComposer.evaluate(element => element.closest("[inert]") !== null)).toBe(true);
    await panel.getByRole("button", { name: "Expand artifact" }).click();
    await expect(page.getByRole("button", { name: "Collapse artifact" })).toBeInViewport();
    await expect(counter).toHaveText("1");
    await page.getByRole("button", { name: "Collapse artifact" }).click();
    await expect(counter).toHaveText("1");
    await panel.getByRole("button", { name: "Edit with AI", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Keep my unfinished idea");
    await page.getByRole("button", { name: "Remove artifact edit" }).click();
    await expect(composer).toHaveValue("Keep my unfinished idea");
  } finally { await fixture.cleanup(); }
});

test("one artifact card per answer survives updates, replay and reload while historical selection stays pinned", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const fixture = await createFixture(page);
  const title = fixture.artifact.title;
  try {
    await installChat(page, fixture);
    await page.setViewportSize({ width: 1440, height: 900 });
    const stream = createGatedRunStreamFixture({ key: "artifact-versions", abortMessage: "Artifact fixture cancelled", notReadyError: "artifact_fixture_not_ready" });
    await stream.install(page, fixture.chatId);
    let finished = false;
    await page.route("**/api/model-runs/artifact-fixture-run", route => route.fulfill({
      json: { version: 1, run: { id: "artifact-fixture-run", status: finished ? "complete" : "streaming" } }
    }));
    await page.route(`**/api/chats/${fixture.chatId}/active-leaf`, route => route.fulfill({ json: { ok: true } }));
    await page.goto("/");
    await page.getByRole("button", { name: `Open artifact: ${title}`, exact: true }).click();
    const panel = page.locator("[data-artifact-panel]");
    await expect(panel.getByRole("button", { name: "Version v1", exact: true })).toBeEnabled({ timeout: 30_000 });
    await panel.getByRole("button", { name: "Edit with AI", exact: true }).click();
    await expect(page.getByRole("button", { name: "Remove artifact edit" })).toBeVisible({ timeout: 30_000 });
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await composer.fill("Make another version");
    await composer.press("Enter");
    await stream.waitForRequestCount(page, 1);
    await stream.emit(page, "run_start", { modelId: "gpt-5.5", provider: "openai", runId: "artifact-fixture-run", status: "streaming" });
    await expect(page.getByRole("button", { name: "Remove artifact edit" })).toHaveCount(0);
    await expect(page.getByTestId("composer-v2").getByRole("button", { name: "Stop answer", exact: true })).toBeEnabled();
    await stream.emit(page, "message_start", { assistantMessageId: "artifact-next-answer", userMessageId: "artifact-next-question" });
    const emitSaved = async (artifact: ThreadGeneratedArtifact) => {
      await stream.emit(page, "artifact_generation", { draftId: artifact.versionId, phase: "started" });
      await stream.emit(page, "artifact_generation", { draftId: artifact.versionId, phase: "settled", status: "ready", artifact });
      await stream.emit(page, "artifact", { artifactType: "generated_artifact", payload: artifact });
    };
    const second = await updateFixture(page, fixture, fixture.artifact);
    await composer.fill("Keep my next idea while versions change");
    await composer.focus();
    await emitSaved(second);
    await expect(panel.getByRole("button", { name: "Version v2", exact: true })).toBeVisible();
    await expect(panel.getByRole("status").filter({ hasText: "Updated to v2" })).toHaveText("Updated to v2");
    await expect(composer).toBeFocused();
    const cards = page.getByRole("button", { name: `Open artifact: ${title}`, exact: true });
    await expect(cards).toHaveCount(2);
    await expect(cards.last()).toContainText("v2");
    await panel.getByRole("button", { name: "Version v2", exact: true }).click();
    await page.getByRole("menuitem", { name: /^v1/ }).click();
    await expect(panel.getByRole("button", { name: "Version v1", exact: true })).toBeVisible();
    const third = await updateFixture(page, fixture, second);
    await emitSaved(third);
    await stream.emit(page, "artifact", { artifactType: "generated_artifact", payload: third });
    await stream.emit(page, "artifact", { artifactType: "generated_artifact", payload: second });
    await expect(panel.getByRole("button", { name: "Version v1", exact: true })).toBeVisible();
    await expect(cards).toHaveCount(2);
    await expect(cards.first()).toContainText("v1");
    await expect(cards.last()).toContainText("v3");
    await expect(composer).toHaveValue("Keep my next idea while versions change");
    await panel.getByRole("button", { name: "Version v1", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: /^v[123]/ })).toHaveCount(3);
    await page.getByRole("menuitem", { name: /^v2/ }).click();
    await expect(page.frameLocator("iframe.v2-artifact-frame").getByText("Workshop · version 2", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Close artifact", exact: true }).click();

    // Reload uses a persisted-message fixture; projection parity is covered by artifactSummary.test.
    const chat = await installChat(page, fixture, third);
    finished = true;
    await stream.emit(page, "chat_update", { chat, messages: chat.messages });
    await stream.emit(page, "done", { runId: "artifact-fixture-run", status: "complete" });
    await stream.waitForRequestCount(page, 1);
    await stream.close(page);
    await expect(page.getByRole("button", { name: "Stop answer", exact: true })).toHaveCount(0);
    await expect(cards).toHaveCount(2);
    await expect(cards.last()).toContainText("v3");
    await page.getByRole("button", { name: `Actions for artifact: ${title}`, exact: true }).last().click();
    await page.getByRole("menuitem", { name: "Share…", exact: true }).click();
    const share = page.getByRole("dialog", { name: `Share “${title}”` });
    await expect(share.getByRole("button", { name: "Publish v3", exact: true })).toBeEnabled({ timeout: 30_000 });
    await share.getByRole("button", { name: "Close", exact: true }).click();
    await expect(composer).toHaveValue("Keep my next idea while versions change");
    await page.reload();
    await expect(cards).toHaveCount(2);
    await expect(cards.first()).toContainText("v1");
    await expect(cards.last()).toContainText("v3");
    await composer.fill("Keep my next idea while previews open");
    await cards.last().click();
    await expect(panel.getByRole("button", { name: "Version v3", exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Close artifact", exact: true }).click();
    await expect(composer).toHaveValue("Keep my next idea while previews open");
    for (const theme of ["light", "dark"]) {
      await page.evaluate(value => {
        document.documentElement.dataset.theme = value;
        document.documentElement.dataset.colorScheme = value;
      }, theme);
      for (const size of sizes.filter(size => size.width !== 1280)) {
        await page.setViewportSize(size);
        await cards.last().scrollIntoViewIfNeeded();
        await expectWithinViewport(page, cards.last());
        await expectCenterUnobscured(cards.last());
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath(`artifact-single-card-${theme}-${size.width}x${size.height}.png`) });
      }
    }
    const historyResponse = await page.request.get(`/api/artifacts/${fixture.artifact.artifactId}`);
    expect(historyResponse.ok()).toBe(true);
    expect((await historyResponse.json()).artifact.versions.map((version: { versionNumber: number }) => version.versionNumber).sort())
      .toEqual([1, 2, 3]);
  } finally { await fixture.cleanup(); }
});

test("Library artifact rows support preview, rename, archive confirmation, restore and deletion", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const fixture = await createFixture(page);
  const title = fixture.artifact.title;
  try {
    await installChat(page, fixture);
    const publication = await page.request.post(`/api/artifacts/${fixture.artifact.artifactId}/publish`, { data: { versionId: fixture.artifact.versionId } });
    expect(publication.ok()).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await composer.fill("Keep the draft while I inspect the library");
    let documentRequests = 0;
    page.on("request", request => {
      if (request.resourceType() === "document" && request.frame() === page.mainFrame()) documentRequests += 1;
    });
    const library = page.getByTestId("library-v2");
    const list = page.getByTestId("library-artifacts-panel");
    const openLibrary = async () => {
      await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Studio", exact: true }).click();
      await library.getByRole("tab", { name: "Artifacts", exact: true }).click();
    };
    await openLibrary();
    await list.getByRole("searchbox", { name: "Search artifacts" }).fill(title);
    await list.getByRole("button", { name: `Open ${title}`, exact: true }).click();
    await expect(page.locator("iframe.v2-artifact-frame")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Artifact actions", exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(list.getByRole("button", { name: `Open ${title}`, exact: true })).toBeVisible();
    await list.getByRole("button", { name: `Open ${title}`, exact: true }).click();
    await page.frameLocator("iframe.v2-artifact-frame").getByRole("button", { name: "Add one", exact: true }).press("Escape");
    await expect(list.getByRole("button", { name: `Open ${title}`, exact: true })).toBeVisible();
    await list.getByRole("button", { name: `Open ${title}`, exact: true }).click();
    await page.getByRole("button", { name: "Artifact actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Open source chat", exact: true }).click();
    await expect(composer).toHaveValue("Keep the draft while I inspect the library");
    expect(documentRequests).toBe(0);
    await openLibrary();
    await expect(library.getByRole("tab", { name: "Artifacts", exact: true })).toHaveAttribute("aria-selected", "true");
    await list.getByRole("searchbox", { name: "Search artifacts" }).fill(title);
    for (const theme of ["light", "dark"]) {
      await page.evaluate(value => {
        document.documentElement.dataset.theme = value;
        document.documentElement.dataset.colorScheme = value;
      }, theme);
      for (const size of sizes) {
        await page.setViewportSize(size);
        await expectWithinViewport(page, list.getByRole("button", { name: `Actions for ${title}`, exact: true }));
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath(`artifact-library-${theme}-${size.width}x${size.height}.png`) });
      }
    }
    await list.getByRole("button", { name: `Open ${title}`, exact: true }).click();
    await expect(page.locator("iframe.v2-artifact-frame")).toBeVisible();
    await library.getByRole("button", { name: "Back to artifacts", exact: true }).click();
    await list.getByRole("button", { name: `Actions for ${title}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    const renamed = `${title} — ready`;
    await list.getByRole("textbox", { name: "Artifact title", exact: true }).fill(renamed);
    await list.getByRole("button", { name: "Save title", exact: true }).click();
    await expect(list.getByRole("button", { name: `Open ${renamed}`, exact: true })).toBeVisible();
    await list.getByRole("button", { name: `Actions for ${renamed}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
    await expect(list.getByRole("alert")).toContainText("1 published link will be revoked");
    await list.getByRole("button", { name: "Archive artifact", exact: true }).click();
    await list.getByRole("button", { name: "Archived", exact: true }).click();
    await list.getByRole("button", { name: `Actions for ${renamed}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Restore", exact: true }).click();
    await list.getByRole("button", { name: /^Recent/ }).click();
    await list.getByRole("button", { name: `Actions for ${renamed}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete…", exact: true }).click();
    await expect(list.getByRole("alert")).toContainText("This cannot be undone.");
    await list.getByRole("button", { name: "Delete permanently", exact: true }).click();
    await expect(list.getByRole("button", { name: `Open ${renamed}`, exact: true })).toHaveCount(0);
  } finally { await fixture.cleanup(); }
});

test("touch previews preserve game state and reachable controls across phone and tablet orientations", async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ baseURL, isMobile: true, hasTouch: true,
    reducedMotion: "reduce", viewport: { width: 390, height: 844 } });
  let fixture: Fixture | undefined;
  try {
    const page = await context.newPage();
    fixture = await createFixture(page);
    await installChat(page, fixture);
    await page.goto("/");
    expect(await page.evaluate(() => ({ touch: navigator.maxTouchPoints > 0,
      coarse: matchMedia("(pointer: coarse)").matches, hoverNone: matchMedia("(hover: none)").matches })))
      .toEqual({ touch: true, coarse: true, hoverNone: true });
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await composer.fill("Keep my touch draft");
    await page.getByRole("button", { name: `Open artifact: ${fixture.artifact.title}`, exact: true }).tap();
    const panel = page.locator("[data-artifact-panel]");
    await expect(panel).toHaveAttribute("aria-modal", "true");
    const preview = page.frameLocator("iframe.v2-artifact-frame");
    await preview.getByRole("button", { name: "Add one", exact: true }).tap();
    const counter = preview.locator("output");
    await expect(counter).toHaveText("1");
    const touchSizes = [
      { device: "phone", orientation: "portrait", theme: "light", width: 390, height: 844 },
      { device: "phone", orientation: "landscape", theme: "light", width: 844, height: 390 },
      { device: "tablet", orientation: "portrait", theme: "dark", width: 768, height: 1024 },
      { device: "tablet", orientation: "landscape", theme: "dark", width: 1024, height: 768 }
    ];
    const close = panel.getByRole("button", { name: "Close artifact", exact: true });
    for (const { device, orientation, theme, width, height } of touchSizes) {
      await page.setViewportSize({ width, height });
      await page.evaluate(value => {
        document.documentElement.dataset.theme = value;
        document.documentElement.dataset.colorScheme = value;
      }, theme);
      await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height });
      await expect(counter).toHaveText("1");
      const expand = panel.getByRole("button", { name: "Expand artifact", exact: true });
      await expectTouchSafe(expand);
      await expand.tap();
      await expect(counter).toHaveText("1");
      await expectWithinViewport(page, close);
      await expectCenterUnobscured(close);
      await expectTouchSafe(close);
      await page.screenshot({ path: testInfo.outputPath(`artifact-touch-${device}-${orientation}-expanded.png`) });
      await panel.getByRole("button", { name: "Collapse artifact", exact: true }).tap();
      await expect(counter).toHaveText("1");
      await expectWithinViewport(page, close);
      await expectCenterUnobscured(close);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`artifact-touch-${device}-${orientation}.png`) });
    }
    await close.tap();
    await expect(panel).toHaveCount(0);
    await expect(composer).toHaveValue("Keep my touch draft");
  } finally {
    try { await fixture?.cleanup(); }
    finally { await context.close(); }
  }
});
