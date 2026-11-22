import { expect, test, type Page } from "@playwright/test";
import type { UserMcpServer } from "../../lib/contracts/mcp";
import { authenticateWithLocalToken } from "./support/localAuth";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { runAccountMenuAction, showSettingsSection } from "./shell/page";
import { expectNoHorizontalOverflow, expectTouchSafe, expectWithinViewport } from "./support/layoutAssertions";

const sizes = [{ width: 1440, height: 900 }, { width: 768, height: 1024 },
  { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 844, height: 390 }];
const resources = ["Instructions"] as const;
type Resource = typeof resources[number] | "MCP servers";
const server: UserMcpServer = {
  accountLabel: null, description: "Synthetic personal connection", enabled: true,
  fields: [{ configured: true, label: "Personal API key", minLength: 8, sensitive: true,
    slotKey: "api_key", source: "personal", valueType: "secret" }],
  id: "studio-mcp", knownToolCount: 1, name: "Research service", oauthAvailable: true,
  oauthState: "disconnected", readiness: "needs_authorization", tools: []
};

async function prepare(page: Page) {
  await authenticateWithLocalToken(page.request);
  const timestamp = "2026-09-21T10:00:00.000Z";
  await installMatrixCatalogFixture(page, { folders: [], chats: [{
    id: "migration-chat", title: "Migration destination", folderId: null,
    activeLeafMessageId: null, createdAt: timestamp, updatedAt: timestamp, messageCount: 0,
    defaultModelId: "gpt-5.5", defaultProvider: "openai", messages: []
  }] });
  await page.route("**/api/chats/compact?*", route => route.fulfill({ json: { chats: [{
    id: "migration-chat", title: "Migration destination", folderId: null, activeRun: false, updatedAt: timestamp,
    assistant: null
  }], folders: [], nextCursor: null } }));
  await page.route("**/api/me/instructions", route => route.fulfill({ json: {
    instructions: { activePresetId: null, selectionVersion: 1, presets: [] }
  } }));
  await page.route("**/api/me/mcp", route => route.fulfill({ json: { servers: [server] } }));
  // Settings › Memory: a saved note, its switches and no earlier memories.
  await page.route("**/api/me/memory/note", route => route.fulfill({ json: {
    text: "I prefer source-backed explanations.", revision: 1, lastChangedBy: "user", updatedAt: timestamp
  } }));
  await page.route("**/api/me/memory/preferences", route => route.fulfill({
    json: { memoryEnabled: true, pastChatSearchEnabled: true, memorySuggestionsEnabled: true } }));
  await page.route(/\/api\/me\/memory\/legacy(?:\?.*)?$/u, route => route.fulfill({ json: { suggestions: [], nextCursor: null } }));
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
}

async function openDraft(page: Page, resource: Resource) {
  await runAccountMenuAction(page, resource);
  const library = page.getByTestId("library-v2");
  if (resource === "MCP servers") {
    await library.getByRole("button", { name: "Open Research service" }).click();
    const input = page.getByTestId("mcp-server-sheet").getByLabel("Personal API key", { exact: true });
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
  test(`migrated forms retain drafts across every Settings exit at ${width}px`, async ({ page }, info) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await prepare(page);
    const library = page.getByTestId("library-v2");
    const confirm = page.getByTestId("discard-changes-confirmation");
    for (const resource of resources) {
      // While Settings is open the chat list and its floating controls are gone at every width, so its exits are
      // another section and Back to chat beside the open editor (both from the side-by-side layout), the editor's
      // own Back and the shortcut.
      for (const destination of [...(width === 1440 ? ["tab", "exit"] : []), "back", "shortcut"]) {
        const input = await openDraft(page, resource);
        const draft = await input.inputValue();
        await expect(page.getByRole("complementary", { name: "Chat navigation" })).toBeHidden();
        await expect(page.getByRole("button", { name: "Open sidebar" })).toHaveCount(0);
        await expect(page.getByRole("link", { name: "New chat", exact: true })).toHaveCount(0);
        const navigate = async () => {
          if (destination === "tab") await library.getByRole("tab", { name: "Files", exact: true }).click();
          else if (destination === "exit") await library.getByRole("button", { name: "Back to chat", exact: true }).click();
          else if (destination === "back") await library.getByRole("button", { name: "Back to Instructions", exact: true }).click();
          else await page.keyboard.press("Control+Shift+O");
        };
        await navigate();
        await expect(confirm.getByRole("button", { name: "Keep editing", exact: true })).toBeFocused();
        if (destination === "back") await page.screenshot({ path: info.outputPath(`${resource}-${width}-discard.png`) });
        await confirm.getByRole("button", { name: "Keep editing", exact: true }).click();
        await expect(input).toHaveValue(draft);
        // Where a section shows alone its row is hidden but stays the selected one.
        await expect(library.getByRole("tab", { name: resource, exact: true, includeHidden: true }))
          .toHaveAttribute("aria-selected", "true");
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
    // The editor's own Back and Back to chat beside it are Settings' exits, both locked; the chat list stays hidden.
    const exits = library.getByRole("button", { name: /^Back to (?:chat|Instructions)$/ });
    await expect(exits).toHaveCount(2);
    for (const exit of await exits.all()) await expect(exit).toBeDisabled();
    await expect(page.getByRole("complementary", { name: "Chat navigation" })).toBeHidden();
    await page.keyboard.press("Control+Shift+O");
    await expect(page.getByTestId("discard-changes-confirmation")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`${resource}-busy.png`) });
    release();
    await expect(library.getByRole("tab", { name: "Files", exact: true })).toBeEnabled();
    await expect(input).not.toHaveValue("");
    await library.getByRole("button", { name: "Back to Instructions", exact: true }).click();
    await page.getByTestId("discard-changes-confirmation").getByRole("button", { name: /Confirm discard/ }).click();
  }
});

for (const theme of ["dark", "light"] as const) {
  test(`Memory, Chat defaults and the list of Settings sections fit every device · ${theme}`, async ({ page }, info) => {
    test.setTimeout(180_000);
    await page.context().addCookies([{ name: "aiqsa.theme", value: theme, url: "http://127.0.0.1:3000" }]);
    await prepare(page);
    for (const size of sizes) {
      await page.setViewportSize(size);
      // No touch here: the list and a section take turns exactly below 1024px.
      const narrow = size.width < 1024;
      await runAccountMenuAction(page, "Chat defaults");
      const library = page.getByTestId("library-v2");
      await expect(library.getByRole("button", { name: "Default model", exact: true })).toBeEnabled();
      await expect(library.getByRole("button", { name: "Active instructions" })).toHaveCount(0);
      await expect(library.getByRole("radiogroup", { name: "MCP tools default" })).toBeVisible();
      await expect(library.getByRole("radiogroup", { name: "Skills default" })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath(`defaults-${theme}-${size.width}x${size.height}.png`) });
      await library.getByRole("tabpanel").getByRole("button", { name: "MCP servers", exact: true }).click();
      await expect(library.getByRole("tab", { name: "MCP servers", exact: true, includeHidden: true }))
        .toHaveAttribute("aria-selected", "true");
      await expect(library).toHaveAttribute("data-view", "section");
      await showSettingsSection(page, "Memory");
      const memory = library.getByTestId("settings-memory");
      await expect(memory.getByRole("textbox", { name: "Memory note", exact: true })).toHaveValue("I prefer source-backed explanations.");
      await expect(memory.getByRole("switch")).toHaveCount(3);
      await expectWithinViewport(page, memory.getByRole("switch", { name: "Use Memory in answers" }));
      await expect(library.getByText("Temporary chats neither read nor change the note.", { exact: true })).toHaveCount(1);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath(`memory-${theme}-${size.width}x${size.height}.png`) });
      // The list of sections: beside the section from 1024px, in its place below (Back to Settings).
      const sectionList = library.getByRole("tablist", { name: "Settings sections" });
      if (narrow) {
        await expect(sectionList).toBeHidden();
        await library.getByRole("button", { name: "Back to Settings", exact: true }).click();
        await expect(library).toHaveAttribute("data-view", "list");
        await expect(library.getByRole("tabpanel")).toBeHidden();
        await expect(library.getByRole("tab", { name: "Memory", exact: true })).toBeFocused();
      }
      await expect(sectionList).toBeVisible();
      // Computers and Telegram depend on the installation; every other section is always offered, in this order.
      const names = (await sectionList.getByRole("tab").allTextContents()).map(name => name.trim())
        .filter(name => name !== "Computers" && name !== "Telegram");
      expect(names).toEqual(["General", "Account", "Data", "Assistants", "Instructions", "Skills", "Sub-agents",
        "Automations", "Chat defaults", "Memory", "Files", "Artifacts", "MCP servers", "Secrets", "Proxies",
        "Claude Code & Codex"]);
      await expect(library.getByRole("button", { name: "Back to chat", exact: true })).toHaveCount(1);
      await expectWithinViewport(page, library.getByRole("button", { name: "Back to chat", exact: true }));
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath(`settings-${theme}-${size.width}x${size.height}.png`) });
      if (narrow) {
        // A section from the list shows it alone again.
        await library.getByRole("tab", { name: "Memory", exact: true }).click();
        await expect(library).toHaveAttribute("data-view", "section");
        await expect(memory).toBeVisible();
      }
      await library.getByRole("button", { name: "Back to chat", exact: true }).click();
      await expect(library).toHaveCount(0);
    }
  });
}

test("OAuth is blocked by personal drafts and promptly recovers from a failed start", async ({ page }) => {
  await prepare(page);
  const starts: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/me/mcp/studio-mcp/oauth/connect*", async route => {
    starts.push(route.request().method());
    await held;
    await route.fulfill({ status: 503, json: { error: "mcp_oauth_unavailable" } });
  });
  const input = await openDraft(page, "MCP servers");
  const button = page.getByRole("button", { name: "Connect", exact: true });
  await expect(button).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByText("Save or clear your personal values first", { exact: true })).toBeVisible();
  // aria-disabled keeps focus; force the press to prove it still starts nothing.
  await button.click({ force: true });
  expect(starts).toEqual([]);
  await input.fill("");
  await expect(button).not.toHaveAttribute("aria-disabled");
  await button.click();
  const authorizing = page.getByRole("button", { name: "Authorizing", exact: true });
  await expect(authorizing).toHaveAttribute("aria-busy", "true");
  await authorizing.click({ force: true });
  release();
  await expect(page.getByTestId("mcp-server-sheet").getByRole("alert"))
    .toHaveText("Authorization for Research service could not be started. Try again.");
  await expect(button).not.toHaveAttribute("aria-disabled");
  expect(starts).toEqual(["POST"]);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.includes("studio-mcp")))).toEqual([]);
});

test("Account guards reverted and unsaved fields and blocks leaving Settings during a save", async ({ page }, info) => {
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
  await runAccountMenuAction(page, "Account");
  const settings = page.getByTestId("library-v2");
  const leave = settings.getByRole("button", { name: "Back to chat", exact: true });
  const name = settings.getByRole("textbox", { name: "Display name" });
  await expect(name).toHaveValue(user.displayName);
  await name.fill("Unsaved name");
  await settings.getByRole("tab", { name: "General", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Unsaved account changes" });
  const keep = confirm.getByRole("button", { name: "Keep editing", exact: true });
  await expect(keep).toBeFocused();
  await keep.press("Shift+Tab");
  await expect(confirm.getByRole("button", { name: "Confirm discard changes" })).toBeFocused();
  await confirm.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(settings.getByRole("tab", { name: "Account", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(name).toHaveValue("Unsaved name");
  await name.fill(user.displayName);
  await settings.getByRole("button", { name: "Change…", exact: true }).click();
  await settings.getByLabel("Current password", { exact: true }).fill("synthetic-unsaved");
  await leave.click();
  await expect(confirm).toBeVisible();
  await page.screenshot({ path: info.outputPath("account-password-discard.png") });
  await keep.click();
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await name.fill("Pending name");
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => saving).toBe(true);
  // A save in flight holds Settings: no way out, and Escape changes nothing.
  await expect(leave).toBeDisabled();
  for (const tab of await settings.getByRole("tab").all()) await expect(tab).toBeDisabled();
  await settings.press("Escape");
  await expect(settings).toBeVisible();
  await expect(confirm).toHaveCount(0);
  release();
  await expect(leave).toBeEnabled();
  await expect(name).toHaveValue("Pending name");
  await leave.click();
  await confirm.getByRole("button", { name: "Confirm discard changes" }).click();
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
      await showSettingsSection(page, "Memory");
      const memory = library.getByTestId("settings-memory");
      await expect(memory.getByRole("switch")).toHaveCount(3);
      for (const control of await memory.getByRole("switch").all()) await expectTouchSafe(control);
      await expectTouchSafe(memory.getByRole("button", { name: "Save", exact: true }));
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath(`memory-touch-${size.width}x${size.height}.png`) });
      await library.getByRole("button", { name: "Back to chat" }).click();
    }
  });
});
