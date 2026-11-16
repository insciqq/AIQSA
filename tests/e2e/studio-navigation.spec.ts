import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { memoryConsumerListFixture, memoryConsumerSettingsFixture } from "../support/memoryFixtures";
import { authenticateWithLocalToken } from "./support/localAuth";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { runAccountMenuAction } from "./shell/page";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";

const sizes = [{ width: 1440, height: 900 }, { width: 768, height: 1024 },
  { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 844, height: 390 }];
const resources = ["Assistants", "Memory"] as const;
type Resource = typeof resources[number];

async function prepare(page: Page) {
  await authenticateWithLocalToken(page.request);
  const timestamp = "2026-09-21T10:00:00.000Z";
  await installMatrixCatalogFixture(page, { folders: [], chats: [{
    id: "studio-navigation-chat", title: "Navigation destination", folderId: null,
    activeLeafMessageId: null, createdAt: timestamp, updatedAt: timestamp, messageCount: 0,
    defaultModelId: "gpt-5.5", defaultProvider: "openai", messages: []
  }] });
  await page.route("**/api/me/memory/settings", route => route.fulfill({ json: memoryConsumerSettingsFixture() }));
  await page.route("**/api/me/memories?*", route => route.fulfill({ json: memoryConsumerListFixture([]) }));
  await page.route("**/api/chats/compact?*", route => route.fulfill({ json: {
    chats: [{ id: "studio-navigation-chat", title: "Navigation destination", folderId: null, activeRun: false, updatedAt: timestamp,
      assistant: null }],
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
    // The New assistant sheet starts on Blank; choosing saves nothing.
    const sheet = page.getByRole("dialog", { name: "New assistant", exact: true });
    await expect(sheet.getByRole("radio", { name: "Blank", exact: true })).toBeChecked();
    await sheet.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    const input = library.getByLabel("Name Required", { exact: true });
    await expect(input).toBeFocused();
    await input.fill("Unsaved Settings assistant");
    return input;
  }
  await library.getByRole("button", { name: "Add memory", exact: true }).first().click();
  const input = library.getByRole("textbox", { name: "New memory", exact: true });
  await input.fill("I prefer carefully verified examples.");
  return input;
}

/** The selected section, also while the list of sections is hidden. */
function selectedSection(library: Locator): Locator {
  return library.locator('[role="tab"][aria-selected="true"]');
}

/**
 * While Settings is open the chat list and the floating controls are absent
 * at every width, and the list shortcuts (Ctrl+K, Ctrl+Shift+S) do nothing.
 * Checked on a section without an editor: an editor may keep shortcuts of
 * its own (the Assistant editor saves on Ctrl+S).
 */
async function expectSettingsOwnsTheShell(page: Page) {
  const navigation = page.getByRole("complementary", { name: "Chat navigation" });
  await expect(navigation).toBeHidden();
  await expect(page.getByRole("button", { name: "Open sidebar" })).toHaveCount(0);
  await expect(page.locator(".v2-sidebar-floats")).toHaveCount(0);
  await page.keyboard.press("Control+k");
  await page.keyboard.press("Control+Shift+S");
  await expect(navigation).toBeHidden();
  await expect(page.getByTestId("discard-changes-confirmation")).toHaveCount(0);
  await expect(page.getByTestId("library-v2")).toBeVisible();
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
}

for (const width of [1440, 390]) {
  test(`Settings protects every existing draft across its exits at ${width}px`, async ({ page }, info) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await prepare(page);
    const library = page.getByTestId("library-v2");
    const confirmation = page.getByTestId("discard-changes-confirmation");
    const backToSettings = library.getByRole("button", { name: "Back to Settings", exact: true });
    await runAccountMenuAction(page, "General");
    await expectSettingsOwnsTheShell(page);
    for (const resource of resources) {
      // The narrow Assistant editor is a sub-view: its own Back is the way
      // to another section there, so only the wide layout switches directly.
      const destinations = width === 390 && resource === "Assistants"
        ? ["back", "shortcut"]
        : ["tab", "back", "shortcut"];
      for (const destination of destinations) {
        const input = await openDraft(page, resource);
        const draft = await input.inputValue();
        if (destination === "tab" && width === 390) {
          // The list keeps the section mounted underneath: going to the list
          // and back keeps the draft and the scroll position, with no guard.
          const panel = library.locator('[role="tabpanel"]');
          await panel.evaluate(node => { node.scrollTop = 90; });
          const scroll = await panel.evaluate(node => node.scrollTop);
          await backToSettings.click();
          await expect(library).toHaveAttribute("data-view", "list");
          await expect(confirmation).toHaveCount(0);
          await screenshot(page, info, `${resource}-list-${width}`);
          await library.getByRole("tab", { name: resource, exact: true }).click();
          await expect(library).toHaveAttribute("data-view", "section");
          await expect(input).toHaveValue(draft);
          expect(await panel.evaluate(node => node.scrollTop)).toBe(scroll);
        }
        const navigate = async () => {
          if (destination === "tab") {
            if (await backToSettings.isVisible()) await backToSettings.click();
            await library.getByRole("tab", { name: "Files", exact: true }).click();
          } else if (destination === "back") {
            await library.getByRole("button", { name: resource === "Assistants" ? "Back to Assistants" : "Back to chat", exact: true }).click();
          } else await page.keyboard.press("Control+Shift+O");
        };
        await navigate();
        await expect(confirmation).toBeVisible();
        await expect(confirmation.getByRole("button", { name: "Keep editing", exact: true })).toBeFocused();
        await screenshot(page, info, `${resource}-${destination}-${width}`);
        await confirmation.getByRole("button", { name: "Keep editing", exact: true }).click();
        await expect(input).toHaveValue(draft);
        await expect(selectedSection(library)).toHaveText(resource);
        await navigate();
        await confirmation.getByRole("button", { name: /Confirm discard/ }).click();
        await expect(input).toHaveCount(0);
        if (destination === "tab") await expect(selectedSection(library)).toHaveText("Files");
        else if (destination !== "back" || resource === "Memory") await expect(library).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
      }
    }
  });
}

test("pending resource mutations block all Settings exits without offering Discard", async ({ page }, info) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  await page.setViewportSize(sizes[0]);
  await prepare(page);
  for (const resource of resources) {
    const input = await openDraft(page, resource);
    const library = page.getByTestId("library-v2");
    const path = resource === "Assistants" ? "assistants" : "memories";
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
      await library.getByRole("textbox", { name: "Instructions", exact: true }).fill("Be precise.");
      await library.getByTestId("assistant-editor-save").click();
    } else await library.getByRole("button", { name: "Save memory", exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    for (const tab of await library.getByRole("tab").all()) await expect(tab).toBeDisabled();
    // Settings' Back is its one exit: the Assistant editor's own Back, or Back to chat.
    const exit = library.getByRole("button", { name: resource === "Assistants" ? "Back to Assistants" : "Back to chat", exact: true });
    await expect(exit).toBeDisabled();
    await expect(page.locator(".v2-sidebar-floats")).toHaveCount(0);
    await page.keyboard.press("Control+Shift+O");
    await expect(page.getByTestId("discard-changes-confirmation")).toHaveCount(0);
    await screenshot(page, info, `${resource}-busy`);
    release?.();
    await expect(library.getByRole("tab", { name: "Files", exact: true })).toBeEnabled();
    await expect(input).not.toHaveValue("");
    await expect(exit).toBeEnabled();
    await page.keyboard.press("Control+Shift+O");
    await page.getByTestId("discard-changes-confirmation").getByRole("button", { name: /Confirm discard/ }).click();
    await expect(library).toHaveCount(0);
  }
});

test("remembers confirmed sections while explicit links and invalid storage remain predictable", async ({ page }) => {
  await prepare(page);
  await runAccountMenuAction(page, "Files");
  await page.getByRole("button", { name: "Back to chat", exact: true }).click();
  await page.reload();
  await runAccountMenuAction(page, "Settings");
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.goto("/?library=memory&keep=yes#studio");
  await expect(page.getByRole("tab", { name: "Memory", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/\?keep=yes#studio$/);
  await expect(page).toHaveTitle("Settings · AIQSA");
  await page.evaluate(() => localStorage.setItem("aiqsa.studio.section", "unavailable"));
  await page.goto("/?library=invalid&keep=yes");
  await expect(page).toHaveURL(/\?keep=yes$/);
  await runAccountMenuAction(page, "Settings");
  // Nothing usable is remembered: the gear opens General.
  await expect(page.getByRole("tab", { name: "General", exact: true })).toHaveAttribute("aria-selected", "true");
});

for (const theme of ["dark", "light"] as const) {
  test(`nine-section composition retains order, keyboard access and geometry · ${theme}`, async ({ page }, info) => {
    await page.context().addCookies([{ name: "aiqsa.theme", value: theme, url: "http://127.0.0.1:3000" }]);
    await page.goto("/ui-v2-fixture?fixture=library&state=all-sections");
    const names = ["Assistants", "Instructions", "Skills", "Chat defaults", "Memory", "Files", "Artifacts", "MCP servers", "Secrets"];
    const list = page.getByRole("tablist", { name: "Settings sections" });
    await expect(list.getByRole("tab")).toHaveText(names);
    for (const size of sizes) {
      await page.setViewportSize(size);
      // Where the list and a section take turns, the list is reached with Back to Settings.
      if (!(await list.isVisible())) await page.getByRole("button", { name: "Back to Settings", exact: true }).click();
      const assistants = list.getByRole("tab", { name: "Assistants", exact: true });
      await assistants.focus();
      await assistants.press("End");
      await expect(list.getByRole("tab", { name: "Secrets", exact: true })).toBeFocused();
      await expect(list.getByRole("tab", { name: "Secrets", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(list.getByRole("tab", { name: "Secrets", exact: true })).toBeInViewport();
      await list.getByRole("tab", { name: "Files", exact: true }).click();
      await expect(page.getByTestId("library-v2")).toHaveAttribute("data-view", "section");
      await expect(page.getByRole("tabpanel", { name: "Files" })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await screenshot(page, info, `composition-${theme}-${size.width}x${size.height}`);
      await info.attach(`geometry-${size.width}`, { body: JSON.stringify(await page.getByRole("heading", { name: "Files", exact: true }).boundingBox()), contentType: "application/json" });
    }
  });
}
