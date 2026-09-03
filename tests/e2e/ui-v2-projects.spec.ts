import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";

test("Projects owns the second column and drills into one shared workspace", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto("/ui-v2-fixture?fixture=projects&state=landing");

  const shell = page.locator(".v2-workspace-shell");
  const navigation = page.getByRole("complementary", { name: "Project navigation" });
  await expect(shell).toHaveAttribute("data-shell-section", "projects");
  await expect(page.getByRole("button", { name: "Projects" })).toHaveAttribute("aria-current", "page");
  await expect(navigation.getByRole("searchbox", { name: "Filter projects" })).toBeVisible();
  await expect(page.getByRole("tree", { name: "Personal chats" })).toHaveCount(0);
  await expect(page.getByTestId("projects-landing-page").getByRole("heading", {
    level: 1,
    name: "Projects"
  })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search projects" })).toHaveCount(0);

  await navigation.getByRole("button", { exact: true, name: "Ingest pipeline" }).click();
  const overview = page.getByTestId("project-overview-page");
  await expect(overview.getByRole("heading", { level: 1, name: "Ingest pipeline" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "All projects" })).toBeVisible();
  await expect(navigation.getByRole("searchbox", { name: "Filter chats" })).toBeVisible();
  const projectComposer = page.getByTestId("project-composer-fixture");
  await expect(projectComposer).toBeVisible();
  const send = projectComposer.getByRole("button", { name: "Send" });
  await expect(send).toBeDisabled();
  const sendBox = await send.boundingBox();
  expect(sendBox?.width).toBeGreaterThanOrEqual(32);
  expect(sendBox?.height).toBeGreaterThanOrEqual(32);
  await page.getByRole("textbox", { name: "Message" }).fill("Draft the rollback plan");
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("Draft the rollback plan");
  await expect(send).toBeEnabled();

  await overview.getByRole("button", { name: "Back to chat" }).click();
  await expect(page.getByRole("heading", { name: "Back in Chats" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Chat navigation" })).toBeVisible();
});

test("Project Manager can move chats and complete one-level folder CRUD", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto("/ui-v2-fixture?fixture=projects&state=overview");

  const navigation = page.getByRole("complementary", { name: "Project navigation" });
  const folderActions = navigation.getByRole("button", { name: "Folder actions: Specs" });
  const folderChat = navigation.getByRole("button", { name: "New chat in Specs" });
  const chatActions = navigation.getByRole("button", { name: "Actions: Parser metrics" });
  await expect(folderActions).toBeVisible();
  await expect(folderChat).toBeVisible();
  await expect(chatActions).toBeVisible();
  await expect(chatActions).toHaveCSS("opacity", "1");
  await expect(folderActions).toHaveCSS("opacity", "1");

  await chatActions.click();
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  const destinations = page.getByLabel("Move to…");
  expect(await destinations.getByRole("menuitem").allTextContents()).toEqual([
    "Project root",
    "Specs",
    "New folder…"
  ]);
  await destinations.getByRole("menuitem", { name: "Specs" }).click();
  await expect(
    navigation.locator('[data-project-folder-id="folder-specs"]')
      .getByRole("treeitem", { name: "Parser metrics" })
  ).toBeVisible();

  await navigation.getByRole("button", { name: "New folder" }).click();
  const cancelledName = navigation.getByRole("textbox", { name: "New folder name" });
  await cancelledName.fill("Discard me");
  await cancelledName.press("Escape");
  await expect(navigation.getByRole("treeitem", { name: /Discard me/u })).toHaveCount(0);

  await navigation.getByRole("button", { name: "New folder" }).click();
  const newName = navigation.getByRole("textbox", { name: "New folder name" });
  await newName.fill("Operations");
  await newName.press("Enter");
  await expect(navigation.getByRole("treeitem", { name: "Operations, 0 chats" })).toBeVisible();

  await navigation.getByRole("button", { name: "Folder actions: Operations" }).click();
  await page.getByRole("menuitem", { name: "Rename folder" }).click();
  const renamedName = navigation.getByRole("textbox", { name: "Folder name" });
  await renamedName.fill("Runbooks");
  await renamedName.press("Enter");
  await expect(navigation.getByRole("treeitem", { name: "Runbooks, 0 chats" })).toBeVisible();

  await navigation.getByRole("button", { name: "Folder actions: Runbooks" }).click();
  await page.getByRole("menuitem", { name: "Delete folder…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete folder Runbooks" });
  await expect(dialog.getByRole("heading", { name: "Delete “Runbooks”?" })).toBeVisible();
  await expect(dialog).toContainText("move to Project root");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(navigation.getByRole("button", { name: "Folder actions: Runbooks" })).toBeFocused();

  await navigation.getByRole("button", { name: "Folder actions: Runbooks" }).click();
  await page.getByRole("menuitem", { name: "Delete folder…" }).click();
  await page.getByRole("button", { name: "Delete folder Runbooks" }).click();
  await expect(navigation.getByRole("treeitem", { name: /Runbooks/u })).toHaveCount(0);
});

test("Project Contributor can start folder chats without Manager controls", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto("/ui-v2-fixture?fixture=projects&state=contributor");

  const navigation = page.getByRole("complementary", { name: "Project navigation" });
  await expect(navigation.getByRole("button", { name: "New shared chat" })).toBeEnabled();
  await expect(navigation.getByRole("button", { name: "New chat in Specs" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "New folder" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: /Actions:/u })).toHaveCount(0);

  await navigation.getByRole("button", { name: "Folder actions: Specs" }).click();
  await expect(page.getByRole("menuitem", { name: "New chat in folder" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Rename folder" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Delete folder…" })).toHaveCount(0);
});

test("Project Viewer and setup-required states expose reasons without write affordances", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.goto("/ui-v2-fixture?fixture=projects&state=viewer");

  await expect(page.getByRole("button", { name: "Start shared chat" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "New shared chat" })).toBeDisabled();
  await expect(page.getByText(/Writing needs Contributor access/u)).toBeVisible();
  await expect(page.getByRole("button", { name: "Change" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Manage" })).toHaveCount(0);
  await expect(page.getByTestId("project-composer-fixture")).toHaveCount(0);
  const viewerNavigation = page.getByRole("complementary", { name: "Project navigation" });
  await expect(viewerNavigation.getByRole("button", { name: "New folder" })).toHaveCount(0);
  await expect(viewerNavigation.getByRole("button", { name: /Folder actions:/u })).toHaveCount(0);
  await expect(viewerNavigation.getByRole("button", { name: /Actions:/u })).toHaveCount(0);

  await page.goto("/ui-v2-fixture?fixture=projects&state=setup");
  await expect(page.getByRole("button", { name: "Start shared chat" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "New shared chat" })).toBeDisabled();
  await expect(page.getByText("Setup required", { exact: true })).toBeVisible();
  await expect(page.getByText(/active shared installation credential/u)).toBeVisible();
  await expect(page.getByText("Default model unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("No default model", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("project-composer-fixture")).toHaveCount(0);
});

test("Project mobile first paint hides the desktop rail before hydration", async ({ browser }) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { height: 844, width: 390 }
  });
  const page = await context.newPage();
  try {
    await page.goto("/ui-v2-fixture?fixture=projects&state=overview", {
      waitUntil: "domcontentloaded"
    });

    const rail = page.getByTestId("workspace-rail");
    await expect(rail).toHaveCount(1);
    await expect(rail).toBeHidden();
    await expect(page.getByTestId("project-overview-page")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  } finally {
    await context.close();
  }
});

for (const viewport of [
  { height: 844, name: "mobile", width: 390 },
  { height: 720, name: "compact", width: 880 }
] as const) {
  test(`Project overview stays contained with reachable controls · ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });
    await page.goto("/ui-v2-fixture?fixture=projects&state=overview");

    const overview = page.getByTestId("project-overview-page");
    await expect(overview).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectWithinViewport(page, overview.getByRole("button", { name: "Back to chat" }));
    if (viewport.width < 768) {
      await expect(page.getByTestId("workspace-rail")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible();
      const mobileChats = overview.locator(".v2-project-mobile-workspace");
      await expect(mobileChats.getByRole("heading", { name: "Chats" })).toBeVisible();
      await expect(mobileChats.getByRole("button", { name: "Specs, 1 chat" })).toBeVisible();
      await expect(mobileChats.getByRole("button", { name: /Parser metrics/u })).toBeVisible();
      await expect(overview.getByRole("heading", { name: "Shared setup" })).toBeHidden();
      const startBox = await overview.getByRole("button", { name: "Start shared chat" }).boundingBox();
      const detailsBox = await overview.getByRole("button", { name: "Ingest pipeline details" }).boundingBox();
      expect(startBox?.height).toBeGreaterThanOrEqual(44);
      expect(detailsBox?.height).toBeGreaterThanOrEqual(44);
      expect(detailsBox?.width).toBeGreaterThanOrEqual(44);

      const composer = page.getByTestId("project-composer-fixture");
      await composer.scrollIntoViewIfNeeded();
      const mobileChatsBox = await mobileChats.boundingBox();
      const composerBox = await composer.boundingBox();
      expect(composerBox?.y).toBeGreaterThanOrEqual(
        (mobileChatsBox?.y ?? 0) + (mobileChatsBox?.height ?? 0)
      );
    } else {
      await expect(page.getByTestId("workspace-rail")).toBeVisible();
    }
  });
}
