import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { memoryConsumerListFixture, memoryConsumerSettingsFixture } from "../support/memoryFixtures";
import { authenticateWithLocalToken } from "./support/localAuth";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { matrixCatalog } from "./shell/catalog";
import { runAccountMenuAction } from "./shell/page";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";

const sizes = [{ width: 1440, height: 900 }, { width: 768, height: 1024 },
  { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 844, height: 390 }];
const resources = ["Assistants", "Knowledge", "Memory"] as const;
type Resource = typeof resources[number];

async function prepare(page: Page) {
  await authenticateWithLocalToken(page.request);
  const timestamp = "2026-09-21T10:00:00.000Z";
  await installMatrixCatalogFixture(page, { folders: [], chats: [{
    id: "studio-navigation-chat", title: "Navigation destination", folderId: null, projectId: null,
    activeLeafMessageId: null, createdAt: timestamp, updatedAt: timestamp, messageCount: 0,
    defaultKnowledgePlan: null, defaultModelId: "gpt-5.5", defaultProvider: "openai", messages: []
  }] });
  await page.route("**/api/me/memory/settings", route => route.fulfill({ json: memoryConsumerSettingsFixture() }));
  await page.route("**/api/me/memories?*", route => route.fulfill({ json: memoryConsumerListFixture([]) }));
  await page.route("**/api/me/knowledge-bases", route => route.request().method() === "GET"
    ? route.fulfill({ json: { knowledgeBases: [], publishableGroups: [], viewer: {
      canCreate: true, canPublishInstallation: false, maxUploadBytes: 50_000_000
    } } }) : route.fallback());
  await page.route("**/api/chats/compact?*", route => route.fulfill({ json: {
    chats: [{ id: "studio-navigation-chat", title: "Navigation destination", folderId: null, activeRun: false, updatedAt: timestamp }],
    folders: [], nextCursor: null
  } }));
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
}

async function openDraft(page: Page, resource: Resource) {
  await runAccountMenuAction(page, resource);
  const library = page.getByTestId("library-v2");
  if (resource === "Assistants") {
    await library.getByRole("button", { name: "New assistant", exact: true }).first().click();
    const input = library.getByLabel("Name Required", { exact: true });
    await input.fill("Unsaved Studio assistant");
    return input;
  }
  if (resource === "Knowledge") {
    await library.getByRole("button", { name: "New base", exact: true }).click();
    const input = library.getByLabel("Name", { exact: true });
    await input.fill("Unsaved Studio base");
    return input;
  }
  await library.getByRole("button", { name: "Add memory", exact: true }).first().click();
  const input = library.getByRole("textbox", { name: "New memory", exact: true });
  await input.fill("I prefer carefully verified examples.");
  return input;
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
}

for (const width of [1440, 390]) {
  test(`Studio protects every existing draft across shell exits at ${width}px`, async ({ page }, info) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await prepare(page);
    const library = page.getByTestId("library-v2");
    const confirmation = page.getByTestId("discard-changes-confirmation");
    const rail = page.getByRole("navigation", { name: "Workspace", exact: true });
    const drawer = page.getByRole("complementary", { name: "Chat navigation" });
    const openDrawer = async () => {
      if (!await drawer.isVisible()) await page.getByRole("button", { name: "Open sidebar" }).click();
    };
    for (const resource of resources) {
      for (const destination of ["tab", "back", "new", "shortcut", "projects", ...(width === 1440 ? ["chats"] : ["chat"])]) {
        const input = await openDraft(page, resource);
        const draft = await input.inputValue();
        if (destination === "tab") {
          const panel = library.getByRole("tabpanel");
          await panel.evaluate(node => { node.scrollTop = 90; });
          const scroll = await panel.evaluate(node => node.scrollTop);
          await runAccountMenuAction(page, "Settings");
          await expect(page.getByTestId("settings-v2")).toBeVisible();
          await screenshot(page, info, `${resource}-settings-${width}`);
          await page.getByRole("button", { name: "Close settings" }).click();
          await expect(input).toHaveValue(draft);
          expect(await panel.evaluate(node => node.scrollTop)).toBe(scroll);
        }
        const navigate = async () => {
          if (destination === "tab") await library.getByRole("tab", { name: "Files", exact: true }).click();
          else if (destination === "back") await library.getByRole("button", { name: resource === "Assistants" ? "Assistants" : resource === "Knowledge" ? "Back to Knowledge" : "Back to chat", exact: true }).click();
          else if (destination === "shortcut") await page.keyboard.press("Control+Shift+O");
          else if (destination === "chat") {
            await openDrawer();
            await drawer.getByRole("treeitem", { name: "Navigation destination", exact: true }).click();
          } else {
            if (width === 390) await openDrawer();
            const owner = width === 390 ? drawer : rail;
            await owner.getByRole("button", { name: destination === "new" ? "New chat" : destination === "chats" ? "Chats" : "Projects", exact: true }).click();
          }
        };
        await navigate();
        await expect(confirmation).toBeVisible();
        await expect(confirmation.getByRole("button", { name: "Keep editing", exact: true })).toBeFocused();
        await screenshot(page, info, `${resource}-${destination}-${width}`);
        await confirmation.getByRole("button", { name: "Keep editing", exact: true }).click();
        await expect(input).toHaveValue(draft);
        await expect(library.getByRole("tab", { name: resource, exact: true })).toHaveAttribute("aria-selected", "true");
        await navigate();
        await confirmation.getByRole("button", { name: /Confirm discard/ }).click();
        await expect(input).toHaveCount(0);
        if (destination === "tab") await expect(library.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true");
        else if (destination !== "back" || resource === "Memory") await expect(library).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
      }
    }
  });
}

test("pending resource mutations block all Studio exits without offering Discard", async ({ page }, info) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  await page.setViewportSize(sizes[0]);
  await prepare(page);
  for (const resource of resources) {
    const input = await openDraft(page, resource);
    const library = page.getByTestId("library-v2");
    const path = resource === "Assistants" ? "assistants" : resource === "Knowledge" ? "knowledge-bases" : "memories";
    let release: (() => void) | undefined;
    let requested = false;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**/api/me/${path}`, async route => {
      if (route.request().method() !== "POST") { await route.fallback(); return; }
      requested = true;
      await pending;
      await route.fulfill({ status: 503, json: { error: { code: "temporarily_unavailable", message: "Try again later." } } });
    });
    if (resource === "Assistants") {
      await library.getByLabel("Model", { exact: true }).selectOption(matrixCatalog.models[0].modelId);
      await library.getByLabel("Assistant instructions").fill("Be precise.");
      await library.getByTestId("assistant-editor-save").click();
    } else await library.getByRole("button", { name: resource === "Memory" ? "Save memory" : "Create knowledge base", exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    for (const tab of await library.getByRole("tab").all()) await expect(tab).toBeDisabled();
    const rail = page.getByRole("navigation", { name: "Workspace", exact: true });
    for (const name of ["Chats", "New chat", "Projects", "Studio"]) await expect(rail.getByRole("button", { name, exact: true })).toBeDisabled();
    await page.keyboard.press("Control+Shift+O");
    await expect(page.getByTestId("discard-changes-confirmation")).toHaveCount(0);
    await screenshot(page, info, `${resource}-busy`);
    release?.();
    await expect(library.getByRole("tab", { name: "Files", exact: true })).toBeEnabled();
    await expect(input).not.toHaveValue("");
    await rail.getByRole("button", { name: "Chats", exact: true }).click();
    await page.getByTestId("discard-changes-confirmation").getByRole("button", { name: /Confirm discard/ }).click();
    await expect(library).toHaveCount(0);
  }
});

test("remembers confirmed sections while explicit links and invalid storage remain predictable", async ({ page }) => {
  await prepare(page);
  const rail = page.getByRole("navigation", { name: "Workspace", exact: true });
  await rail.getByRole("button", { name: "Studio", exact: true }).click();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "Back to chat", exact: true }).click();
  await page.reload();
  await rail.getByRole("button", { name: "Studio", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.goto("/?library=memory&keep=yes#studio");
  await expect(page.getByRole("tab", { name: "Memory", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/\?keep=yes#studio$/);
  await expect(page).toHaveTitle("Studio · AIQSA");
  await page.evaluate(() => localStorage.setItem("aiqsa.studio.section", "unavailable"));
  await page.goto("/?library=invalid&keep=yes");
  await expect(page).toHaveURL(/\?keep=yes$/);
  await rail.getByRole("button", { name: "Studio", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Assistants", exact: true })).toHaveAttribute("aria-selected", "true");
});

for (const theme of ["dark", "light"] as const) {
  test(`ten-section composition retains order, keyboard access and geometry · ${theme}`, async ({ page }, info) => {
    await page.context().addCookies([{ name: "aiqsa.theme", value: theme, url: "http://127.0.0.1:3000" }]);
    await page.goto("/ui-v2-fixture?fixture=library&state=all-sections");
    const names = ["Assistants", "Instructions", "Skills", "Knowledge", "Memory", "Files", "Artifacts", "MCP servers", "Secrets", "Chat defaults"];
    await expect(page.getByRole("tab")).toHaveText(names);
    for (const size of sizes) {
      await page.setViewportSize(size);
      await page.getByRole("tab", { name: "Assistants", exact: true }).click();
      await page.getByRole("tab", { name: "Assistants", exact: true }).press("End");
      await expect(page.getByRole("tab", { name: "Chat defaults", exact: true })).toBeFocused();
      await expect(page.getByRole("tab", { name: "Chat defaults", exact: true })).toBeInViewport();
      await page.getByRole("tab", { name: "Files", exact: true }).click();
      await expectNoHorizontalOverflow(page);
      await screenshot(page, info, `composition-${theme}-${size.width}x${size.height}`);
      await info.attach(`geometry-${size.width}`, { body: JSON.stringify(await page.getByRole("heading", { name: "Files", exact: true }).boundingBox()), contentType: "application/json" });
    }
  });
}
