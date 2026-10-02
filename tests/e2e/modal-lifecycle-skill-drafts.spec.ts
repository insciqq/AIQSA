import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { workingConnection } from "../../components/admin/providers/providerFixtures";
import type { UserMcpServer } from "../../lib/contracts/mcp";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { runAccountMenuAction } from "./shell/page";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { authenticateWithLocalToken, signInWithLocalToken } from "./support/localAuth";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";

type Viewport = Readonly<{ width: number; height: number }>;
const sizes: readonly Viewport[] = [{ width: 1440, height: 900 }, { width: 768, height: 1024 },
  { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 844, height: 390 }];
const desktop = sizes[0]!;
const phone = sizes[3]!;

test.use({ hasTouch: true });

function exactPath(path: string): RegExp {
  return new RegExp(`^[^?#]*//[^/]+${path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u");
}

/** No body child may stay inert, hidden from assistive technology or scroll-locked once every modal closed. */
async function expectPageRestored(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({
    isolated: [...document.body.children].filter((child) =>
      (child as HTMLElement).inert || child.hasAttribute("inert") || child.getAttribute("aria-hidden") === "true")
      .map((child) => child.tagName),
    overflow: document.body.style.overflow
  }))).toEqual({ isolated: [], overflow: "" });
}

async function createChat(page: Page, title: string): Promise<string> {
  const response = await page.request.post("/api/chats", { data: { title, memoryMode: "EXCLUDED" } });
  expect(response.status()).toBe(201);
  return (await response.json()).chat.id as string;
}

async function chooseChat(page: Page, title: string): Promise<void> {
  const navigation = page.getByRole("complementary", { name: "Chat navigation" });
  if (!(await navigation.isVisible())) await page.getByRole("button", { name: "Open sidebar" }).click();
  await navigation.getByRole("treeitem", { name: title, exact: true }).click();
}

async function withTwoChats(page: Page, run: (titles: { alpha: string; beta: string }, ids: { alpha: string; beta: string }) => Promise<void>) {
  const suffix = randomUUID().slice(0, 8);
  const titles = { alpha: `Skill draft alpha ${suffix}`, beta: `Skill draft beta ${suffix}` };
  const ids = { alpha: await createChat(page, titles.alpha), beta: await createChat(page, titles.beta) };
  try {
    await page.goto(`/c/${ids.alpha}`);
    await expect(page.getByTestId("header-title")).toHaveText(titles.alpha);
    await chooseChat(page, titles.beta);
    await expect(page).toHaveURL(exactPath(`/c/${ids.beta}`));
    await expect(page.getByTestId("header-title")).toHaveText(titles.beta);
    await run(titles, ids);
  } finally {
    for (const id of Object.values(ids)) await deleteOwnedChatPermanently(page.request, id).catch(() => undefined);
  }
}

for (const size of sizes) {
  const label = `${size.width}x${size.height}`;
  test(`MCP Discard changes leaves the page interactive at ${label}`, async ({ page }, info) => {
    test.setTimeout(90_000);
    await page.setViewportSize(size);
    const server: UserMcpServer = {
      id: "research", name: "Research", accountLabel: null, description: "Research tools", enabled: false,
      fields: [{ configured: false, label: "Personal API key", sensitive: true, slotKey: "api_key", source: "missing", valueType: "secret" }],
      knownToolCount: 1, oauthAvailable: false, oauthState: null, readiness: "needs_setup", tools: []
    };
    await authenticateWithLocalToken(page.request);
    await installMatrixCatalogFixture(page);
    await page.route("**/api/me/mcp**", async (route) => {
      if (route.request().method() === "GET" && new URL(route.request().url()).pathname === "/api/me/mcp") {
        await route.fulfill({ json: { servers: [server] } });
      } else await route.fulfill({ status: 400, json: { error: "unexpected_test_mutation" } });
    });
    await page.goto("/?library=mcp");
    const library = page.getByTestId("library-v2");
    await library.getByRole("button", { name: "Complete setup for Research" }).click();
    const sheet = page.getByRole("dialog", { name: "Research", exact: true });
    await sheet.getByLabel("Personal API key", { exact: true }).fill("synthetic-personal-token");
    await sheet.getByRole("button", { name: "Cancel" }).click();
    const confirm = page.getByRole("dialog", { name: "Unsaved MCP changes" });
    await expect(confirm.getByRole("button", { name: "Keep editing" })).toBeFocused();
    await expectWithinViewport(page, confirm.getByRole("button", { name: "Confirm discard changes" }));
    await page.screenshot({ path: info.outputPath(`mcp-discard-confirm-${label}.png`) });
    const discard = confirm.getByRole("button", { name: "Confirm discard changes" });
    if (size.width < 1000) await discard.tap();
    else await discard.click();
    await expect(sheet).toHaveCount(0);
    await expectPageRestored(page);
    await expect(library.getByRole("button", { name: "Open Research" })).toBeFocused();
    await library.getByRole("button", { name: "Open Research" }).click();
    await expect(sheet.getByLabel("Personal API key", { exact: true })).toHaveValue("");
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`mcp-discard-restored-${label}.png`) });
  });
}

for (const size of [desktop, phone]) {
  const label = `${size.width}x${size.height}`;
  test(`browser Back from a provider sheet with its JSON dialog open restores the page at ${label}`, async ({ page }, info) => {
    test.setTimeout(90_000);
    await page.setViewportSize(size);
    const connection = workingConnection();
    const model = connection.models[0]!;
    await page.route("**/api/admin/providers**", async (route) => {
      if (route.request().method() === "GET") await route.fulfill({ json: { connections: [connection] } });
      else await route.fulfill({ status: 400, json: { error: "unexpected_test_mutation" } });
    });
    await signInWithLocalToken(page);
    await page.goto("/admin?section=providers");
    const section = page.getByTestId("admin-section-providers");
    await section.getByTestId(`provider-row-${connection.id}`).click();
    await expect(page).toHaveURL(new RegExp(`section=providers&resource=${connection.id}`, "u"));
    const models = page.getByTestId("provider-models");
    await models.getByRole("button", { name: `More actions for ${model.displayName}` }).click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Edit model" });
    await sheet.getByRole("button", { name: "Edit JSON" }).click();
    const json = page.getByRole("dialog", { name: "Default parameters · JSON" });
    await expect(json).toBeVisible();
    await page.goBack();
    await expect(page).not.toHaveURL(/resource=/u);
    await expect(json).toHaveCount(0);
    await expect(sheet).toHaveCount(0);
    await expectPageRestored(page);
    await section.getByTestId(`provider-row-${connection.id}`).click();
    await expect(page).toHaveURL(new RegExp(`resource=${connection.id}`, "u"));
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`provider-json-back-${label}.png`) });
  });
}

for (const size of [desktop, phone]) {
  const label = `${size.width}x${size.height}`;
  test(`a dirty Studio Skill asks before a tab switch, Back to chat and browser Back at ${label}`, async ({ page }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize(size);
    await signInWithLocalToken(page);
    await withTwoChats(page, async (titles, ids) => {
      await runAccountMenuAction(page, "Skills");
      const studio = page.getByTestId("library-v2");
      const library = page.getByTestId("skill-library-section");
      await library.getByRole("button", { name: "New Skill", exact: true }).click();
      const name = library.getByRole("textbox", { name: "Name", exact: true });
      await name.fill("Unsaved Studio Skill");
      const confirmation = page.getByRole("dialog", { name: "Unsaved Skill changes" });

      await studio.getByRole("tab", { name: "Instructions", exact: true }).click();
      await expect(confirmation).toBeVisible();
      await expect(confirmation.getByRole("button", { name: "Keep editing" })).toBeFocused();
      await page.screenshot({ path: info.outputPath(`studio-skill-tab-confirm-${label}.png`) });
      await page.keyboard.press("Escape");
      await expect(confirmation).toHaveCount(0);
      await expect(name).toHaveValue("Unsaved Studio Skill");

      await studio.getByRole("button", { name: "Back to chat", exact: true }).click();
      await expect(confirmation).toBeVisible();
      await confirmation.getByRole("button", { name: "Keep editing" }).click();
      await expect(name).toHaveValue("Unsaved Studio Skill");

      await page.goBack();
      await expect(confirmation).toBeVisible();
      await expect(page).toHaveURL(exactPath(`/c/${ids.beta}`));
      await confirmation.getByRole("button", { name: "Keep editing" }).click();
      await expect(name).toHaveValue("Unsaved Studio Skill");
      await expect(page).toHaveURL(exactPath(`/c/${ids.beta}`));

      await page.goBack();
      await confirmation.getByRole("button", { name: "Confirm discard changes" }).click();
      await expect(page).toHaveURL(exactPath(`/c/${ids.alpha}`));
      await expect(studio).toHaveCount(0);
      await expect(page.getByTestId("header-title")).toHaveText(titles.alpha);
      await expectPageRestored(page);
      await expectNoHorizontalOverflow(page);
    });
  });

  test(`a dirty composer Skill dialog keeps the chat address until it is discarded at ${label}`, async ({ page }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize(size);
    await signInWithLocalToken(page);
    await withTwoChats(page, async (titles, ids) => {
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await page.getByRole("menuitem", { name: /^Skills…/u }).click();
      const picker = page.getByRole("dialog", { name: "Skills", exact: true });
      await picker.getByRole("button", { name: "New Skill", exact: true }).click();
      const name = picker.getByRole("textbox", { name: "Name", exact: true });
      await name.fill("Unsaved composer Skill");
      const confirmation = page.getByRole("dialog", { name: "Unsaved Skill changes" });

      await name.press("Escape");
      await expect(confirmation).toBeVisible();
      await expectWithinViewport(page, confirmation.getByRole("button", { name: "Confirm discard changes" }));
      await page.screenshot({ path: info.outputPath(`composer-skill-escape-confirm-${label}.png`) });
      await confirmation.getByRole("button", { name: "Keep editing" }).click();
      await expect(name).toBeFocused();
      await expect(name).toHaveValue("Unsaved composer Skill");

      await page.goBack();
      await expect(confirmation).toBeVisible();
      await expect(page).toHaveURL(exactPath(`/c/${ids.beta}`));
      await confirmation.getByRole("button", { name: "Keep editing" }).click();
      await expect(picker).toBeVisible();
      await expect(name).toHaveValue("Unsaved composer Skill");
      await expect(page).toHaveURL(exactPath(`/c/${ids.beta}`));

      await page.goBack();
      await confirmation.getByRole("button", { name: "Confirm discard changes" }).click();
      await expect(page).toHaveURL(exactPath(`/c/${ids.alpha}`));
      await expect(page.getByTestId("header-title")).toHaveText(titles.alpha);
      await expect(picker).toHaveCount(0);
      await expectPageRestored(page);

      // A clean editor closes at once.
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await page.getByRole("menuitem", { name: /^Skills…/u }).click();
      await picker.getByRole("button", { name: "New Skill", exact: true }).click();
      await picker.getByRole("button", { name: "Close Skills", exact: true }).click();
      await expect(picker).toHaveCount(0);
      await expect(confirmation).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
    });
  });
}
