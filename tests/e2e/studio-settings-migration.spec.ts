import { expect, test, type Page } from "@playwright/test";
import type { UserMcpServer } from "../../lib/contracts/mcp";
import { memoryConsumerItemFixture, memoryConsumerListFixture, memoryConsumerSettingsFixture } from "../support/memoryFixtures";
import { authenticateWithLocalToken } from "./support/localAuth";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { runAccountMenuAction } from "./shell/page";
import { expectNoHorizontalOverflow, expectTouchSafe, expectWithinViewport } from "./support/layoutAssertions";

const sizes = [{ width: 1440, height: 900 }, { width: 768, height: 1024 },
  { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 844, height: 390 }];
const resources = ["Instructions", "MCP servers"] as const;
type Resource = typeof resources[number];
const server: UserMcpServer = {
  accountLabel: null, description: "Synthetic personal connection", enabled: true,
  fields: [{ configured: true, label: "Personal API key", minLength: 8, sensitive: true,
    slotKey: "api_key", source: "personal", valueType: "secret" }],
  id: "studio-mcp", knownToolCount: 1, name: "Research service", oauthAvailable: true,
  oauthState: "disconnected", operationalStatus: "inactive", readiness: "needs_authorization", tools: []
};

async function prepare(page: Page) {
  await authenticateWithLocalToken(page.request);
  const timestamp = "2026-09-21T10:00:00.000Z";
  await installMatrixCatalogFixture(page, { folders: [], chats: [{
    id: "migration-chat", title: "Migration destination", folderId: null, projectId: null,
    activeLeafMessageId: null, createdAt: timestamp, updatedAt: timestamp, messageCount: 0,
    defaultKnowledgePlan: null, defaultModelId: "gpt-5.5", defaultProvider: "openai", messages: []
  }] });
  await page.route("**/api/chats/compact?*", route => route.fulfill({ json: { chats: [{
    id: "migration-chat", title: "Migration destination", folderId: null, activeRun: false, updatedAt: timestamp
  }], folders: [], nextCursor: null } }));
  await page.route("**/api/me/instructions", route => route.fulfill({ json: {
    instructions: { activePresetId: null, selectionVersion: 1, presets: [] }
  } }));
  await page.route("**/api/me/mcp", route => route.fulfill({ json: { servers: [server] } }));
  await page.route("**/api/me/memory/settings", route => route.fulfill({ json: memoryConsumerSettingsFixture({
    status: "ON", settings: { useMemoryFacts: true, learnAutomatically: true, referenceChatHistory: true }
  }) }));
  await page.route("**/api/me/memories?*", route => route.fulfill({ json: memoryConsumerListFixture([
    memoryConsumerItemFixture({ statement: "I prefer source-backed explanations." })
  ]) }));
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
}

async function openDraft(page: Page, resource: Resource) {
  await runAccountMenuAction(page, resource);
  const library = page.getByTestId("library-v2");
  if (resource === "MCP servers") {
    const input = library.getByLabel("Personal API key", { exact: true });
    await input.fill("synthetic-studio-value");
    return input;
  }
  if (resource === "Instructions") {
    await library.getByRole("button", { name: "New preset" }).click();
    await library.getByLabel("System instructions", { exact: true }).fill("Use precise examples.");
  }
  const input = library.getByLabel("Name", { exact: true });
  await input.fill(`Unsaved ${resource}`);
  return input;
}

for (const width of [1440, 390]) {
  test(`migrated forms retain drafts across every Studio exit at ${width}px`, async ({ page }, info) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await prepare(page);
    const library = page.getByTestId("library-v2");
    const confirm = page.getByTestId("discard-changes-confirmation");
    const rail = page.getByRole("navigation", { name: "Workspace", exact: true });
    const drawer = page.getByRole("complementary", { name: "Chat navigation" });
    for (const resource of resources) {
      for (const destination of ["tab", "back", "new", "shortcut", "projects", width === 1440 ? "chats" : "chat"]) {
        const input = await openDraft(page, resource);
        const draft = await input.inputValue();
        if (destination === "tab") {
          const panel = library.getByRole("tabpanel");
          await panel.evaluate(node => { node.scrollTop = 90; });
          const scroll = await panel.evaluate(node => node.scrollTop);
          await runAccountMenuAction(page, "Settings");
          await page.getByRole("button", { name: "Close settings" }).click();
          await expect(input).toHaveValue(draft);
          expect(await panel.evaluate(node => node.scrollTop)).toBe(scroll);
        }
        const navigate = async () => {
          if (destination === "tab") await library.getByRole("tab", { name: "Files", exact: true }).click();
          else if (destination === "back") await library.getByRole("button", { name: /Back to (?:chat|Instructions)/ }).click();
          else if (destination === "shortcut") await page.keyboard.press("Control+Shift+O");
          else {
            if (width === 390 && !await drawer.isVisible()) await page.getByRole("button", { name: "Open sidebar" }).click();
            if (destination === "chat") await drawer.getByRole("treeitem", { name: "Migration destination", exact: true }).click();
            else await (width === 390 ? drawer : rail).getByRole("button", {
              name: destination === "new" ? "New chat" : destination === "chats" ? "Chats" : "Projects", exact: true
            }).click();
          }
        };
        await navigate();
        await expect(confirm.getByRole("button", { name: "Keep editing", exact: true })).toBeFocused();
        if (destination === "back") await page.screenshot({ path: info.outputPath(`${resource}-${width}-discard.png`) });
        await confirm.getByRole("button", { name: "Keep editing", exact: true }).click();
        await expect(input).toHaveValue(draft);
        await expect(library.getByRole("tab", { name: resource, exact: true })).toHaveAttribute("aria-selected", "true");
        await navigate();
        await confirm.getByRole("button", { name: /Confirm discard/ }).click();
        await expect(input).toHaveCount(0);
        if (destination === "tab") await expect(library.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true");
        else if (destination === "back" && resource === "Instructions") {
          await expect(library.getByRole("button", { name: "New preset" })).toBeVisible();
          await library.getByRole("button", { name: "Back to chat" }).click();
        } else await expect(library).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
      }
    }
  });
}

test("pending migrated mutations block exits, then preserve the draft on failure", async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize(sizes[0]);
  await prepare(page);
  for (const resource of resources) {
    const input = await openDraft(page, resource);
    const path = resource === "Instructions" ? "instructions" : "mcp/studio-mcp";
    let release!: () => void;
    let requested = false;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**/api/me/${path}`, async route => {
      if (route.request().method() === "GET") return route.fallback();
      requested = true;
      await pending;
      await route.fulfill({ status: 503, json: { error: "temporarily_unavailable" } });
    });
    const library = page.getByTestId("library-v2");
    await library.getByRole("button", { name: resource === "Instructions" ? "Save" : "Save personal values", exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    for (const tab of await library.getByRole("tab").all()) await expect(tab).toBeDisabled();
    const rail = page.getByRole("navigation", { name: "Workspace", exact: true });
    for (const name of ["Chats", "New chat", "Projects", "Studio"]) await expect(rail.getByRole("button", { name, exact: true })).toBeDisabled();
    await page.keyboard.press("Control+Shift+O");
    await expect(page.getByTestId("discard-changes-confirmation")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`${resource}-busy.png`) });
    release();
    await expect(library.getByRole("tab", { name: "Files", exact: true })).toBeEnabled();
    await expect(input).not.toHaveValue("");
    await library.getByRole("button", { name: /Back to (?:chat|Instructions)/ }).click();
    await page.getByTestId("discard-changes-confirmation").getByRole("button", { name: /Confirm discard/ }).click();
  }
});

for (const theme of ["dark", "light"] as const) {
  test(`Memory, Chat defaults and reduced Settings fit every device · ${theme}`, async ({ page }, info) => {
    test.setTimeout(180_000);
    await page.context().addCookies([{ name: "aiqsa.theme", value: theme, url: "http://127.0.0.1:3000" }]);
    await prepare(page);
    for (const size of sizes) {
      await page.setViewportSize(size);
      await runAccountMenuAction(page, "Chat defaults");
      const library = page.getByTestId("library-v2");
      await expect(library.getByRole("button", { name: "Default model", exact: true })).toBeEnabled();
      await expect(library.getByRole("button", { name: "Active instructions" })).toHaveCount(0);
      await expect(library.getByRole("radiogroup", { name: "MCP tools default" })).toBeVisible();
      await expect(library.getByRole("radiogroup", { name: "Skills default" })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath(`defaults-${theme}-${size.width}x${size.height}.png`) });
      await library.getByRole("tabpanel").getByRole("button", { name: "MCP servers", exact: true }).click();
      await expect(library.getByRole("tab", { name: "MCP servers", exact: true })).toHaveAttribute("aria-selected", "true");
      await library.getByRole("tab", { name: "Memory", exact: true }).click();
      const card = page.getByRole("complementary", { name: "How Memory works" });
      const disclosure = card.getByRole("button", { name: /^How Memory works/ });
      if (size.width === 1440) {
        await expect(disclosure).toBeHidden();
        const cardBox = await card.boundingBox();
        expect(cardBox?.width).toBe(320);
        const switchBox = await card.getByRole("switch").first().boundingBox();
        expect(switchBox!.x).toBeGreaterThan(cardBox!.x + cardBox!.width - 70);
      } else {
        await expect(disclosure).toHaveAttribute("aria-expanded", "false");
        await expect(disclosure).toContainText("Memory is on");
        await disclosure.click();
      }
      await expect(card.getByRole("switch")).toHaveCount(5);
      await expect(library.getByText(/Temporary chats never read or write Memory/)).toHaveCount(1);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath(`memory-${theme}-${size.width}x${size.height}.png`) });
      await runAccountMenuAction(page, "Settings");
      const settings = page.getByTestId("settings-v2");
      await expect(settings.getByRole("navigation", { name: "Settings sections" }).getByRole("button")).toHaveText([
        "General", "Account", "Connected apps", "Data"
      ]);
      if (size.width === 1440) {
        await expect.poll(async () => {
          const box = await settings.boundingBox();
          return { width: Math.round(box?.width ?? 0), height: Math.round(box?.height ?? 0) };
        }).toEqual({ width: 864, height: 609 });
      }
      await expectWithinViewport(page, settings);
      await page.screenshot({ path: info.outputPath(`settings-${theme}-${size.width}x${size.height}.png`) });
      await settings.getByRole("button", { name: "Close settings" }).click();
      await library.getByRole("button", { name: "Back to chat" }).click();
    }
  });
}

test("Memory retains focused controls when its own container crosses 1000px", async ({ page }) => {
  await page.setViewportSize(sizes[0]);
  await prepare(page);
  await runAccountMenuAction(page, "Memory");
  const panel = page.getByRole("tabpanel");
  const contentWidth = await panel.evaluate(node => {
    const style = getComputedStyle(node);
    return node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  });
  const width = 1440 + 1000 - contentWidth;
  await page.setViewportSize({ width, height: 900 });
  const card = page.getByRole("complementary", { name: "How Memory works" });
  const disclosure = card.getByRole("button", { name: /^How Memory works/ });
  await expect(disclosure).toBeHidden();
  const first = card.getByRole("switch").first();
  await first.focus();
  await page.setViewportSize({ width: width - 1, height: 900 });
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await expect(first).toBeFocused();
  await expect(first).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("OAuth is blocked by personal drafts and promptly recovers from prevented navigation", async ({ page }) => {
  await prepare(page);
  const input = await openDraft(page, "MCP servers");
  const link = page.getByRole("link", { name: "Connect", exact: true });
  await expect(link).toHaveAttribute("aria-disabled", "true");
  await expect(link).not.toHaveAttribute("href");
  await expect(page.getByText("Save or clear your personal values first", { exact: true })).toBeVisible();
  await input.fill("");
  await expect(link).toHaveAttribute("href", "/api/me/mcp/studio-mcp/oauth/connect");
  await link.evaluate(node => node.addEventListener("click", event => event.preventDefault(), { once: true }));
  await link.click();
  await expect(link).toHaveAttribute("href", "/api/me/mcp/studio-mcp/oauth/connect");
  await expect(page.getByRole("link", { name: "Authorizing", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.includes("studio-mcp")))).toEqual([]);
});

test("Memory reset removes the draft and search and fences an older search response", async ({ page }, info) => {
  await page.setViewportSize(sizes[0]);
  await prepare(page);
  let release!: () => void;
  let searchRequested = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/me/memories/search", async route => {
    searchRequested = true;
    await pending;
    await route.fulfill({ json: memoryConsumerListFixture([memoryConsumerItemFixture({ statement: "Stale search result" })]) });
  });
  await page.route("**/api/me/memory/reset", async route => {
    await page.route("**/api/me/memories?*", read => read.fulfill({ json: memoryConsumerListFixture([]) }));
    await route.fulfill({ json: { status: "COMPLETE" } });
  });
  await runAccountMenuAction(page, "Memory");
  const library = page.getByTestId("library-v2");
  const search = library.getByRole("searchbox", { name: "Search memories" });
  await search.fill("old");
  await search.press("Enter");
  await expect.poll(() => searchRequested).toBe(true);
  await library.getByRole("button", { name: "Forget everything…" }).click();
  await page.getByRole("alertdialog", { name: "Forget everything?" }).getByRole("button", { name: "Forget everything", exact: true }).click();
  await expect(library.getByText("Personal Memory was reset.", { exact: true })).toBeVisible();
  const lateResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/me/memories/search");
  release();
  await (await lateResponse).finished();
  await expect(search).toHaveValue("");
  await expect(library.getByText("Stale search result", { exact: true })).toHaveCount(0);
  await library.getByRole("button", { name: "Add memory", exact: true }).first().click();
  await library.getByRole("textbox", { name: "New memory", exact: true }).fill("Discard this reset draft");
  await library.getByRole("button", { name: "Forget everything…" }).click();
  await page.getByRole("alertdialog", { name: "Forget everything?" }).getByRole("button", { name: "Forget everything", exact: true }).click();
  await expect(library.getByRole("textbox", { name: "New memory", exact: true })).toHaveCount(0);
  await expect(search).toHaveValue("");
  await expect(library.getByRole("button", { name: "Add memory", exact: true }).first()).toBeEnabled();
  await page.screenshot({ path: info.outputPath("memory-reset-cleared.png") });
  await library.getByRole("button", { name: "Back to chat" }).click();
  await expect(page.getByTestId("discard-changes-confirmation")).toHaveCount(0);
});

test("an unconfirmed Memory reset reloads the actual list and unlocks its controls", async ({ page }) => {
  await page.setViewportSize(sizes[0]);
  await prepare(page);
  let reads = 0;
  await page.route("**/api/me/memories?*", route => {
    reads += 1;
    return route.fulfill({ json: memoryConsumerListFixture([
      memoryConsumerItemFixture({ statement: reads === 1 ? "Before reset" : "Still saved on the server" })
    ]) });
  });
  await page.route("**/api/me/memory/reset", route => route.fulfill({ status: 503, json: { error: "temporarily_unavailable" } }));
  await runAccountMenuAction(page, "Memory");
  const library = page.getByTestId("library-v2");
  await expect(library.getByText("Before reset", { exact: true })).toBeVisible();
  await library.getByRole("button", { name: "Forget everything…" }).click();
  const confirmation = page.getByRole("alertdialog", { name: "Forget everything?" });
  await confirmation.getByRole("button", { name: "Forget everything", exact: true }).click();
  await expect(library.getByRole("alert")).toContainText("The reset could not be confirmed.");
  await expect(library.getByText("Still saved on the server", { exact: true })).toBeVisible();
  await confirmation.getByRole("button", { name: "Keep my memories", exact: true }).click();
  await expect(library.getByRole("button", { name: "Add memory", exact: true }).first()).toBeEnabled();
  await expect(library.getByText("Before reset", { exact: true })).toHaveCount(0);
});

test("Account guards reverted and unsaved fields and blocks close during a save", async ({ page }, info) => {
  await prepare(page);
  const user = { displayName: "Synthetic owner", email: "account@example.test", role: "user", hasPassword: true };
  let release!: () => void;
  let saving = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/me", async route => {
    if (route.request().method() === "PATCH") {
      saving = true;
      await pending;
      await route.fulfill({ status: 503, json: { error: "temporarily_unavailable" } });
    } else await route.fulfill({ json: { user } });
  });
  await runAccountMenuAction(page, "Settings");
  const settings = page.getByTestId("settings-v2");
  await settings.getByRole("button", { name: "Account", exact: true }).click();
  const name = settings.getByRole("textbox", { name: "Display name" });
  await expect(name).toHaveValue(user.displayName);
  await name.fill("Unsaved name");
  await settings.getByRole("button", { name: "General", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "Unsaved account changes" });
  const keep = confirm.getByRole("button", { name: "Keep editing", exact: true });
  await expect(keep).toBeFocused();
  await keep.press("Shift+Tab");
  await expect(confirm.getByRole("button", { name: "Discard changes" })).toBeFocused();
  await confirm.press("Escape");
  await expect(name).toHaveValue("Unsaved name");
  await name.fill(user.displayName);
  await settings.getByRole("button", { name: "Change…", exact: true }).click();
  await settings.getByLabel("Current password", { exact: true }).fill("synthetic-unsaved");
  await settings.getByRole("button", { name: "Close settings" }).click();
  await expect(confirm).toBeVisible();
  await page.screenshot({ path: info.outputPath("account-password-discard.png") });
  await keep.click();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await name.fill("Pending name");
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => saving).toBe(true);
  await expect(settings.getByRole("button", { name: "Close settings" })).toBeDisabled();
  await settings.press("Escape");
  await expect(settings).toBeVisible();
  await expect(confirm).toHaveCount(0);
  release();
  await expect(settings.getByRole("button", { name: "Close settings" })).toBeEnabled();
  await expect(name).toHaveValue("Pending name");
  await settings.getByRole("button", { name: "Close settings" }).click();
  await confirm.getByRole("button", { name: "Discard changes" }).click();
  await expect(settings).toHaveCount(0);
});

test.describe("touch controls", () => {
  test.use({ hasTouch: true });
  test("Chat defaults and Memory keep touch targets usable in both phone orientations", async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await prepare(page);
    for (const size of [sizes[3], sizes[4]]) {
      await page.setViewportSize(size);
      await runAccountMenuAction(page, "Chat defaults");
      const library = page.getByTestId("library-v2");
      await expectTouchSafe(library.getByRole("button", { name: "Default model", exact: true }));
      for (const radio of await library.getByRole("radio").all()) await expectTouchSafe(radio);
      await page.screenshot({ path: info.outputPath(`defaults-touch-${size.width}x${size.height}.png`) });
      await library.getByRole("tab", { name: "Memory", exact: true }).click();
      const card = page.getByRole("complementary", { name: "How Memory works" });
      await expectTouchSafe(card.getByRole("button", { name: /^How Memory works/ }));
      await card.getByRole("button", { name: /^How Memory works/ }).click();
      for (const control of await card.getByRole("switch").all()) await expectTouchSafe(control);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath(`memory-touch-${size.width}x${size.height}.png`) });
      await library.getByRole("button", { name: "Back to chat" }).click();
    }
  });
});
