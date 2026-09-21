import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { ThreadGeneratedArtifact } from "../../lib/contracts/chats";
import { memoryConsumerSettingsFixture } from "../support/memoryFixtures";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { createGatedRunStreamFixture } from "./support/gatedRunStream";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { authenticateWithLocalToken } from "./support/localAuth";

const sizes = [{ width: 1440, height: 900 }, { width: 1280, height: 640 },
  { width: 768, height: 1024 }, { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 844, height: 390 }];

async function fixture(page: Page) {
  await authenticateWithLocalToken(page.request);
  const title = `Reliability notebook ${randomUUID().slice(0, 8)}`;
  const chatResponse = await page.request.post("/api/chats", { data: { title, memoryMode: "EXCLUDED" } });
  expect(chatResponse.ok()).toBe(true);
  const chatId: string = (await chatResponse.json()).chat.id;
  const cleanupIds: string[] = [];
  const cleanup = async (errors: unknown[] = []) => {
    const actions = [
      ...cleanupIds.map(id => async () => {
        const response = await page.request.delete(`/api/artifacts/${id}`);
        expect(response.ok() || response.status() === 404).toBe(true);
      }),
      async () => {
        const response = await page.request.delete(`/api/chats/${chatId}`);
        expect(response.ok() || response.status() === 404).toBe(true);
      }
    ];
    for (const action of actions) {
      try { await action(); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Artifact scenario and fixture cleanup failed");
  };
  const body = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;background:#132934;color:#f3eedc;font:18px system-ui}main{padding:24px;display:grid;gap:20px}h1,p{margin:0}button{font:inherit;padding:14px;color:#132934;background:#bce8d4;border:0;border-radius:8px}</style></head><body><main><h1>A place for small ideas.</h1><p>Body-only fixture marker.</p><button onclick="throw new Error('notebookCounter is not defined')">Trigger error</button></main></body></html>`;
  try {
    const created = await page.request.post("/api/artifacts", { data: { sourceChatId: chatId, operation: {
      intent: "create", kind: "html", title, entrypoint: "index.html", files: [{ path: "index.html", mimeType: "text/html", text: body }]
    } } });
    expect(created.status()).toBe(201);
    const version = (await created.json()).version;
    cleanupIds.push(version.artifactId);
    const artifact: ThreadGeneratedArtifact = { artifactId: version.artifactId, versionId: version.id,
      versionNumber: 1, title, kind: "html", entrypoint: "index.html", byteSize: Buffer.byteLength(body) };
    return { chatId, artifact, body, cleanupIds, cleanup };
  } catch (error) {
    await cleanup([error]);
    throw error;
  }
}

async function installChat(page: Page, value: Awaited<ReturnType<typeof fixture>>) {
  const timestamp = "2026-09-21T00:00:00.000Z";
  const messages = [{ id: "reliability-question", role: "user", parentMessageId: null, text: "Make a notebook." },
    { id: "reliability-answer", role: "assistant", parentMessageId: "reliability-question", text: "Your notebook is ready." }]
    .map(message => ({ id: message.id, role: message.role, parentMessageId: message.parentMessageId, createdAt: timestamp,
      errorMessage: null, status: "complete", content: { blocks: [{ type: "text", text: message.text }] },
      modelId: message.role === "assistant" ? "gpt-5.5" : null, modelRunId: message.role === "assistant" ? "reliability-run" : null,
      provider: message.role === "assistant" ? "openai" : null,
      artifactSummary: message.role === "assistant" ? { citations: [], sources: [], reasoningText: [], generatedArtifacts: [value.artifact] } : null }));
  await page.addInitScript(id => localStorage.setItem("aiqsa.activeChatId", id), value.chatId);
  await installMatrixCatalogFixture(page, { folders: [], chats: [{ id: value.chatId, title: value.artifact.title, messages,
    activeLeafMessageId: "reliability-answer", createdAt: timestamp, updatedAt: timestamp, defaultModelId: "gpt-5.5",
    defaultProvider: "openai", folderId: null, pinned: false, messageCount: messages.length, usageStats: null }] });
  await page.route("**/api/me/memory/settings", route => route.fulfill({ json: memoryConsumerSettingsFixture() }));
  await page.route("**/api/me/mcp", route => route.fulfill({ json: { servers: [] } }));
  await page.route(`**/api/chats/${value.chatId}/active-leaf`, route => route.fulfill({ json: { ok: true } }));
}

test("live artifact code grows as text, survives layout changes and becomes a ready preview", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const value = await fixture(page);
  const errors: unknown[] = [];
  try {
    await installChat(page, value);
    const stream = createGatedRunStreamFixture({ key: "artifact-reliability", abortMessage: "Fixture stopped", notReadyError: "fixture_not_ready" });
    await stream.install(page, value.chatId);
    await page.setViewportSize(sizes[0]);
    await page.goto("/");
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Create artifact/ }).click();
    await composer.fill("Make another notebook");
    await expect(page.getByRole("button", { name: "Remove artifact creation" })).toBeVisible();
    await composer.press("Enter");
    await stream.waitForRequestCount(page, 1);
    await stream.emit(page, "run_start", { modelId: "gpt-5.5", provider: "openai", runId: "reliability-generation", status: "streaming" });
    await stream.emit(page, "message_start", { assistantMessageId: "generation-answer", userMessageId: "generation-question" });
    await expect(page.getByRole("button", { name: "Remove artifact creation" })).toHaveCount(0);
    const emit = (data: object) => stream.emit(page, "artifact_generation", { draftId: "generation-draft", ...data });
    await emit({ phase: "started" });
    await emit({ phase: "metadata", title: "New notebook", kind: "html" });
    await page.getByRole("button", { name: "Open artifact code: New notebook", exact: true }).click();
    const panel = page.locator("[data-artifact-panel]");
    await expect(panel).toContainText("Creating artifact…");
    await expect(panel.locator("iframe")).toHaveCount(0);
    const first = "<!doctype html>\n<h1>Live notebook</h1>\n";
    await emit({ phase: "file", index: 0, path: "index.html", offset: 0, text: first });
    const code = panel.locator(".v2-artifact-generation-code");
    await expect(code).toHaveText(first);
    const second = Array.from({ length: 100 }, (_, index) => `<p>Note ${index + 1}</p>`).join("\n");
    await emit({ phase: "file", index: 0, offset: first.length, text: second });
    await expect(code).toContainText("Note 100");
    await expect.poll(() => code.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(2);
    await code.hover();
    await page.mouse.wheel(0, -200);
    await expect(panel.getByRole("button", { name: "Follow code" })).toBeVisible();
    const scrollTop = await code.evaluate(element => element.scrollTop);
    await emit({ phase: "file", index: 0, offset: first.length + second.length, text: "\n<p>Final note</p>" });
    await expect(code).toContainText("Final note");
    expect(await code.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(scrollTop + 2);
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.dataset.colorScheme = theme; }, theme);
      for (const size of sizes) {
        await page.setViewportSize(size);
        await expectNoHorizontalOverflow(page);
        await expectWithinViewport(page, panel.getByRole("button", { name: "Close artifact", exact: true }));
        await page.screenshot({ path: testInfo.outputPath(`artifact-stream-${theme}-${size.width}x${size.height}.png`) });
      }
    }
    await emit({ phase: "settled", status: "ready", artifact: value.artifact });
    await expect(panel.locator("iframe.v2-artifact-frame")).toHaveAttribute("sandbox", "allow-scripts allow-forms allow-pointer-lock allow-downloads");
    await expect(page.frameLocator("iframe.v2-artifact-frame").getByRole("heading", { name: "A place for small ideas." })).toBeVisible();
    await panel.getByRole("button", { name: "Close artifact", exact: true }).click();
    await page.getByTestId("composer-v2").getByRole("button", { name: "Stop answer", exact: true }).click();
  } catch (error) { errors.push(error); } finally { await value.cleanup(errors); }
});

test("public page transfers its body only through the content endpoint", async ({ page }) => {
  const value = await fixture(page);
  const errors: unknown[] = [];
  try {
    const published = await page.request.post(`/api/artifacts/${value.artifact.artifactId}/publish`, { data: { versionId: value.artifact.versionId } });
    expect(published.status()).toBe(201);
    const path: string = (await published.json()).publication.publicPath;
    const contentResponses: Promise<boolean>[] = [];
    page.on("response", response => {
      if (response.ok() && /^\/api\/artifact-public\/[^/]+\/?$/u.test(new URL(response.url()).pathname)) {
        // Development StrictMode may abort a first fetch before replaying the effect.
        contentResponses.push(response.finished().then(error => error === null, () => false));
      }
    });
    const document = await page.goto(path);
    expect(await document!.text()).not.toContain("Body-only fixture marker.");
    await expect(page.frameLocator("iframe.v2-artifact-frame").getByText("Body-only fixture marker.", { exact: true })).toBeVisible();
    expect((await Promise.all(contentResponses)).filter(Boolean)).toHaveLength(1);
    await page.frameLocator("iframe.v2-artifact-frame").getByRole("button", { name: "Trigger error" }).click();
    await expect(page.getByRole("button", { name: "Fix with AI" })).toHaveCount(0);
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  } catch (error) { errors.push(error); } finally { await value.cleanup(errors); }
});

test("runtime repair carries details through tab storage, and duplicate thumbnails remain inert", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const value = await fixture(page);
  const errors: unknown[] = [];
  try {
    await installChat(page, value);
    await page.setViewportSize(sizes[0]);
    await page.goto(`/artifacts/${value.artifact.artifactId}/versions/${value.artifact.versionId}`);
    await page.frameLocator("iframe.v2-artifact-frame").getByRole("button", { name: "Trigger error" }).click();
    await expect(page.getByRole("tabpanel", { name: "Preview", exact: true }).getByRole("alert")).toContainText("notebookCounter is not defined");
    await page.getByRole("button", { name: "Fix with AI", exact: true }).click();
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(composer).toHaveValue(/Fix the runtime error.*notebookCounter is not defined/);
    expect(page.url()).not.toContain("notebookCounter");
    expect(await page.evaluate(versionId => sessionStorage.getItem(`aiqsa.artifactFix.${versionId}`), value.artifact.versionId)).toBeNull();
    await page.getByRole("button", { name: "Remove artifact edit" }).click();
    const close = page.getByRole("button", { name: "Close artifact", exact: true });
    if (await close.isVisible()) await close.click();
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Studio", exact: true }).click();
    const library = page.getByTestId("library-v2");
    await library.getByRole("tab", { name: "Artifacts", exact: true }).click();
    const list = page.getByTestId("library-artifacts-panel");
    await list.getByRole("searchbox", { name: "Search artifacts" }).fill(value.artifact.title);
    await expect(list.locator("iframe.v2-artifact-thumbnail-frame").first()).toBeVisible();
    await expect(list.locator("iframe.v2-artifact-thumbnail-frame").first()).toHaveAttribute("sandbox", "");
    await expect(list.locator("iframe.v2-artifact-thumbnail-frame").first()).toHaveAttribute("tabindex", "-1");
    const duplicated = page.waitForResponse(response => response.url().endsWith(`/api/artifacts/${value.artifact.artifactId}/duplicate`) && response.request().method() === "POST");
    await list.getByRole("button", { name: `Actions for ${value.artifact.title}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
    const result = await duplicated;
    expect(result.status()).toBe(201);
    const copy = (await result.json()).artifact;
    value.cleanupIds.push(copy.id);
    await expect(list.getByRole("status")).toContainText(`Duplicated as “${copy.title}”`);
    await expect(list.getByRole("button", { name: `Open ${copy.title}`, exact: true })).toBeVisible();
    for (const size of sizes) {
      await page.setViewportSize(size);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`artifact-thumbnails-${size.width}x${size.height}.png`) });
    }
  } catch (error) { errors.push(error); } finally { await value.cleanup(errors); }
});
