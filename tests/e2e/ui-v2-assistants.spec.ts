import { expect, test, type Locator } from "@playwright/test";
import { captureState } from "./support/capture";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";

async function gridColumns(grid: Locator): Promise<number> {
  return grid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
}

test("Assistant gallery counts, groups and cards stay honest for owners and consumers", async ({ page }, testInfo) => {
  await page.goto("/ui-v2-fixture?fixture=assistants&state=list");
  const gallery = page.getByTestId("assistant-gallery");
  const chips = gallery.getByRole("group", { name: "Filter Assistants" }).getByRole("button");
  await expect(chips).toHaveText(["All 10", "Pinned 4", "Yours 7", "Shared 3", "Featured 3", "Archived 1"]);
  await expect(gallery.getByRole("heading", { level: 3 })).toHaveText(["Featured", "Pinned", "Recently updated"]);
  await expect(gallery.getByRole("region", { name: "Featured" }).getByRole("article").first()).toHaveAttribute("data-testid", "assistant-card-hr-helper");
  await expect(gallery.getByTestId("assistant-card-onboarding-guide")).toHaveCount(0);

  const owner = gallery.getByTestId("assistant-card-hr-helper");
  await expect(owner).toContainText("Yours · Everyone · Gemini 3.8 Flash");
  await expect(owner.getByRole("button", { name: "Start chat with HR Helper" })).toBeEnabled();
  await expect(owner.getByRole("button", { name: "Pin HR Helper" })).toHaveAttribute("aria-pressed", "true");
  await owner.getByRole("button", { name: "More actions for HR Helper" }).click();
  await expect(page.getByRole("menu", { name: "Actions for HR Helper" }).getByRole("menuitem"))
    .toHaveText(["Edit", "Duplicate", "Copy link", "Share…", "Archive", "Delete"]);
  await page.keyboard.press("Escape");
  await expect(owner.getByRole("button", { name: "More actions for HR Helper" })).toBeFocused();

  const shared = gallery.getByTestId("assistant-card-code-reviewer");
  await expect(shared).toContainText("By Ada Analyst · Everyone · Your model");
  await shared.getByRole("button", { name: "More actions for Code reviewer" }).click();
  await expect(page.getByRole("menu", { name: "Actions for Code reviewer" }).getByRole("menuitem"))
    .toHaveText(["Duplicate", "Copy link"]);
  await page.keyboard.press("Escape");

  const attention = gallery.getByTestId("assistant-card-jira-desk");
  await expect(attention).toContainText("Needs attention: Jira isn't available");
  await expect(attention.getByRole("button", { name: "Start chat with Jira desk" })).toBeDisabled();
  await expect(gallery.getByTestId("assistant-card-release-helper")).toContainText("3 dependencies unavailable");
  const consumer = gallery.getByTestId("assistant-card-sales-brief");
  await expect(consumer).toContainText("Not available to you");
  await expect(consumer.getByRole("button", { name: "Start chat with Sales brief" })).toBeDisabled();
  await expect(gallery.getByRole("button", { name: "Why?" })).toHaveCount(0);

  await captureState(page, testInfo, "assistant-gallery", {
    atEachSize: async ({ size }) => {
      const label = `${size.width}x${size.height}`;
      const width = (await gallery.boundingBox())!.width;
      const grid = gallery.getByRole("region", { name: "Recently updated" }).locator(".v2-assistants-grid");
      expect(await gridColumns(grid), label).toBe(width >= 900 ? 3 : width >= 600 ? 2 : 1);
      const phone = size.width < 640 || size.height < 512;
      await expect(owner.getByRole("list", { name: "Capabilities" }), label).toBeVisible({ visible: !phone });
      await expect(owner.getByRole("button", { name: "Start chat with HR Helper" }), label).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });
});

test("Assistant gallery chips, search and archive states are captured", async ({ page }, testInfo) => {
  await page.goto("/ui-v2-fixture?fixture=assistants&state=list-filtered");
  const gallery = page.getByTestId("assistant-gallery");
  await expect(gallery.getByRole("button", { name: "Pinned 3" })).toHaveAttribute("aria-pressed", "true");
  await expect(gallery.getByRole("searchbox", { name: "Search Assistants" })).toHaveValue("the");
  await expect(gallery.getByRole("heading", { name: "Featured" })).toHaveCount(0);
  await expect(gallery.getByRole("article")).toHaveCount(3);
  await captureState(page, testInfo, "assistant-gallery-filtered", { atEachSize: () => expectNoHorizontalOverflow(page) });

  await page.goto("/ui-v2-fixture?fixture=assistants&state=list-archived");
  const archived = page.getByTestId("assistant-card-onboarding-guide");
  await expect(archived).toContainText("Archived");
  await expect(archived.getByRole("button", { name: "Restore Onboarding guide" })).toBeVisible();
  await expect(archived.getByRole("button", { name: "Delete Onboarding guide" })).toBeVisible();
  await captureState(page, testInfo, "assistant-gallery-archived", { atEachSize: () => expectNoHorizontalOverflow(page) });
  await archived.getByRole("button", { name: "Restore Onboarding guide" }).click();
  await expect(page.getByTestId("assistant-gallery-notice")).toContainText("Restored Onboarding guide.");
  await expect(page.getByTestId("assistant-gallery").getByRole("button", { name: "Archived 0" })).toBeVisible();

  await page.goto("/ui-v2-fixture?fixture=assistants&state=empty-search");
  await expect(page.getByText("Nothing matches")).toBeVisible();
  await captureState(page, testInfo, "assistant-gallery-empty-search", { atEachSize: () => expectNoHorizontalOverflow(page) });
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.getByRole("searchbox", { name: "Search Assistants" })).toBeFocused();
  await expect(page.getByRole("searchbox", { name: "Search Assistants" })).toHaveValue("");
  await expect(page.getByText("Nothing matches")).toHaveCount(0);
});

test("Assistant cards open the detail sheet by keyboard and it returns focus", async ({ page }) => {
  await page.goto("/ui-v2-fixture?fixture=assistants&state=list");
  const card = page.getByTestId("assistant-card-hr-helper");
  const heading = card.getByRole("button", { name: "HR Helper", exact: true });
  await heading.focus();
  await page.keyboard.press("Tab");
  await expect(card.getByRole("button", { name: "More actions for HR Helper" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(card.getByRole("button", { name: "Start chat with HR Helper" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(card.getByRole("button", { name: "Pin HR Helper" })).toBeFocused();

  await heading.focus();
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog", { name: "HR Helper" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Close" })).toBeFocused();
  for (let index = 0; index < 40; index += 1) await page.keyboard.press("Tab");
  expect(await sheet.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(heading).toBeFocused();
});

test("Assistant detail sheet shows the owner's and the consumer's view", async ({ page }, testInfo) => {
  await page.goto("/ui-v2-fixture?fixture=assistants&state=detail-owner");
  const owner = page.getByRole("dialog", { name: "HR Helper" });
  await expect(owner).toContainText("Yours · Everyone · Updated");
  await expect(owner.getByRole("button", { name: "Start chat", exact: true })).toBeEnabled();
  await expect(owner.getByRole("button", { name: "Unpin" })).toHaveAttribute("aria-pressed", "true");
  await expect(owner.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  await expect(owner.getByRole("region", { name: "Conversation starters" }).getByRole("button")).toHaveCount(3);
  await expect(owner.getByRole("row")).toHaveCount(6);
  await expect(owner.getByRole("row", { name: /Knowledge/u })).toContainText("HR handbook, Benefits FAQ");
  await expect(owner.getByRole("row", { name: /Knowledge/u })).toContainText("Fixed");
  await expect(owner.getByRole("region", { name: "Sharing" })).toContainText("Everyone in this installation · Groups: Support team · Featured #1");
  await expect(owner.getByRole("region", { name: "Sharing" })).toContainText("Used by Projects: People Ops, 1 other Project");
  await expect(owner.getByRole("region", { name: "Usage" })).toContainText("38 chats in the last 30 days");
  await captureState(page, testInfo, "assistant-detail-owner", {
    atEachSize: async ({ size }) => {
      const label = `${size.width}x${size.height}`;
      const box = (await owner.boundingBox())!;
      if (size.width < 640 || size.height < 512) {
        expect(Math.round(box.width), label).toBe(size.width);
        expect(Math.round(box.height), label).toBe(size.height);
      } else {
        expect(Math.round(box.width), label).toBe(600);
      }
      await expectNoHorizontalOverflow(page);
    }
  });

  await page.goto("/ui-v2-fixture?fixture=assistants&state=detail-consumer");
  const consumer = page.getByRole("dialog", { name: "Sales brief" });
  await expect(consumer).toContainText("By Ada Analyst · 1 group · Updated");
  await expect(consumer.getByRole("button", { name: "Start chat", exact: true })).toBeDisabled();
  await expect(consumer.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  await expect(consumer.getByRole("button", { name: "Manage sharing…" })).toHaveCount(0);
  await expect(consumer.getByRole("region", { name: "Usage" })).toHaveCount(0);
  await expect(consumer.getByRole("row", { name: /Tools/u })).toContainText("1 MCP server you can't access");
  await expect(consumer.getByRole("row", { name: /Tools/u })).toContainText("Not available to you");
  await expect(consumer.getByRole("row", { name: /Model/u })).toContainText("Your default will be used");
  await expect(consumer.getByRole("row", { name: /Knowledge/u })).toContainText("Pricing base · 1 base or document you can't access");
  await captureState(page, testInfo, "assistant-detail-consumer", { atEachSize: () => expectNoHorizontalOverflow(page) });

  await page.goto("/ui-v2-fixture?fixture=assistants&state=detail-instructions");
  const preview = page.getByRole("dialog", { name: "HR Helper" }).getByLabel("Instructions preview");
  await expect(preview).toContainText("You are the HR Helper for Bearstars.");
  await expect(preview).not.toContainText("{local_date}");
  await expect(preview).toContainText("[response reminder omitted]");
  await expect(preview).not.toContainText("Never give legal advice.");
  await captureState(page, testInfo, "assistant-detail-instructions", {
    anchor: preview,
    atEachSize: () => expectNoHorizontalOverflow(page)
  });
});

test("Delete lists its consequences before it removes the card", async ({ page }, testInfo) => {
  await page.goto("/ui-v2-fixture?fixture=assistants&state=delete-loading");
  const loading = page.getByRole("dialog", { name: "Delete “HR Helper”?" });
  await expect(loading.getByRole("status")).toContainText("Checking what deleting it changes…");
  await expect(loading.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
  await captureState(page, testInfo, "assistant-delete-loading", { atEachSize: () => expectNoHorizontalOverflow(page) });

  await page.goto("/ui-v2-fixture?fixture=assistants&state=delete-dialog");
  const dialog = page.getByRole("dialog", { name: "Delete “HR Helper”?" });
  await expect(dialog.getByRole("listitem")).toHaveText([
    "It stops being available to everyone in this installation.",
    "It is unshared from the group Support team.",
    "Projects stop using it: People Ops (its default Assistant), 1 other Project.",
    "38 chats keep their messages and show that the Assistant was deleted."
  ]);
  await captureState(page, testInfo, "assistant-delete-dialog", {
    atEachSize: async () => {
      await expectWithinViewport(page, dialog);
      await expectNoHorizontalOverflow(page);
    }
  });
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("assistant-card-hr-helper")).toHaveCount(0);
  await expect(page.getByTestId("assistant-gallery-notice")).toContainText("Deleted HR Helper.");

  await page.goto("/ui-v2-fixture?fixture=assistants&state=list");
  const more = page.getByRole("button", { name: "More actions for Translator" });
  await more.click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete “Translator”?" });
  await expect(confirm).toContainText("It isn't shared, used by a Project or bound to a chat.");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(more).toBeFocused();
});

test("Assistant editor is an inline, guarded Library subview", async ({ page }) => {
  await page.goto("/ui-v2-fixture?fixture=assistants&state=dirty");

  const editor = page.getByTestId("assistant-editor");
  await expect(editor).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Assistants" })).toHaveCount(0);
  await expect(editor.getByLabel("Name Required")).toHaveValue("Jira desk");
  await expect(editor.getByText("Unsaved changes")).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to Assistants" })).toBeVisible();

  const cancel = editor.getByRole("button", { name: "Cancel" });
  await cancel.click();
  const confirmation = page.getByRole("dialog", { name: "Discard assistant draft changes" });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Keep editing" }).click();
  await expect(cancel).toBeFocused();

  await expect(editor).not.toContainText(/Revision|Publish update|Order \d/u);
  await expect(page.getByTestId("assistant-history")).toHaveCount(0);
});

test("Assistant editor columns, Split and the save bar follow their own containers", async ({ page }, testInfo) => {
  await page.goto("/ui-v2-fixture?fixture=assistants&state=editor");
  const editor = page.getByTestId("assistant-editor");
  await expect(editor).toBeVisible();
  const main = editor.locator(".v2-assistant-editor-main");
  const setup = editor.getByRole("complementary", { name: "Setup" });
  const starters = editor.getByRole("heading", { name: "Conversation starters" });
  const instructions = editor.locator(".v2-assistant-instructions > .v2-markdown-editor");
  const save = editor.getByTestId("assistant-editor-save");

  for (const policy of await editor.getByRole("button", { name: /^(Fixed|Adjustable)$/u }).all()) {
    await expect(policy).toHaveAttribute("aria-pressed", /^(true|false)$/u);
  }
  await expect(editor.getByRole("button", { name: "Tools", exact: true })).toHaveAttribute("aria-expanded", "false");

  await captureState(page, testInfo, "assistant-editor", {
    atEachSize: async ({ size }) => {
      const [pageBox, mainBox, setupBox, startersBox, instructionsBox] = await Promise.all([
        editor.boundingBox(), main.boundingBox(), setup.boundingBox(), starters.boundingBox(), instructions.boundingBox()
      ]);
      const label = `${size.width}x${size.height}`;
      if (pageBox!.width >= 1040) {
        expect(setupBox!.x, label).toBeGreaterThanOrEqual(mainBox!.x + mainBox!.width - 1);
        expect(Math.round(setupBox!.width), label).toBe(360);
      } else {
        expect(setupBox!.y, label).toBeGreaterThan(startersBox!.y);
        expect(Math.abs(setupBox!.x - mainBox!.x), label).toBeLessThanOrEqual(1);
      }
      if (size.width === 1440) {
        expect(pageBox!.width, label).toBeGreaterThanOrEqual(1040);
        expect(instructionsBox!.height, label).toBeGreaterThanOrEqual(480);
      }
      if (size.width === 1024 || size.width === 390) expect(pageBox!.width, label).toBeLessThan(1040);
      expect(instructionsBox!.height, label).toBeGreaterThanOrEqual(319);
      const split = instructions.getByRole("radio", { name: "Split" });
      if (instructionsBox!.width >= 880) await expect(split, label).toBeChecked();
      else {
        await expect(split, label).toHaveCount(0);
        await expect(instructions.getByRole("radio", { name: "Write" }), label).toBeChecked();
      }
      await expect(save, label).toBeInViewport();
      await expectNoHorizontalOverflow(page);
    }
  });
});

test("editor states keep errors, conflicts and Setup rows inside the page", async ({ page }, testInfo) => {
  for (const state of ["editor-new", "editor-errors", "editor-conflict", "editor-setup-open", "editor-skills"] as const) {
    await page.goto(`/ui-v2-fixture?fixture=assistants&state=${state}`);
    const editor = page.getByTestId("assistant-editor");
    await expect(editor).toBeVisible();
    if (state === "editor-new") {
      await expect(editor.getByTestId("assistant-editor-save")).toHaveText("Create");
      await expect(editor.getByRole("button", { name: "Adjustable" })).toHaveCount(6);
      await expect(editor.getByRole("button", { name: "Manage sharing…" })).toBeDisabled();
      await expect(editor.getByText("Save first")).toBeVisible();
    }
    if (state === "editor-errors") {
      await expect(editor.getByLabel("Name Required")).toHaveAttribute("aria-invalid", "true");
      await expect(editor.getByTestId("assistant-setup-row-tools")).toContainText("Choose at least one MCP server, or turn Tools off.");
      await expect(editor.getByTestId("assistant-setup-row-knowledge")).toContainText("Choose a value to fix, or make this row Adjustable.");
    }
    if (state === "editor-conflict") {
      await expect(editor.getByTestId("assistant-editor-conflict")).toContainText("Latest saved version: Jira desk (team)");
    }
    if (state === "editor-setup-open") {
      const tools = editor.getByTestId("assistant-setup-row-tools");
      await expect(tools.getByRole("button", { name: "Tools", exact: true })).toHaveAttribute("aria-expanded", "true");
      await expect(tools.getByRole("button", { name: "Fixed", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(tools.getByRole("checkbox", { name: /Kubernetes/u })).toBeChecked();
      await expect(tools).toContainText("Needs setup");
    }
    if (state === "editor-skills") {
      const skills = editor.getByTestId("assistant-setup-row-skills");
      await expect(skills.getByRole("switch", { name: "Load Skills on demand" })).toBeVisible();
      await expect(skills.getByRole("radiogroup", { name: "Delivery for Issue triage" })).toBeVisible();
      await expect(skills).toContainText("1 always · 2 on demand");
      await expect(skills).not.toContainText(/Order \d/u);
    }
    await captureState(page, testInfo, `assistant-${state}`, {
      anchor: state === "editor-setup-open" ? editor.getByTestId("assistant-setup-row-tools")
        : state === "editor-skills" ? editor.getByTestId("assistant-setup-row-skills") : undefined,
      atEachSize: () => expectNoHorizontalOverflow(page)
    });
  }
});

test("New assistant starts from a template without saving", async ({ page }, testInfo) => {
  await page.goto("/ui-v2-fixture?fixture=assistants&state=new-sheet");
  const sheet = page.getByRole("dialog", { name: "New assistant" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("radio")).toHaveCount(8);
  await captureState(page, testInfo, "assistant-new-sheet", { atEachSize: () => expectNoHorizontalOverflow(page) });

  await sheet.getByText("Code reviewer", { exact: true }).click();
  await expect(sheet.getByRole("radio", { name: "Code reviewer" })).toBeChecked();
  await sheet.getByRole("button", { name: "Continue" }).click();
  const editor = page.getByTestId("assistant-editor");
  await expect(editor.getByLabel("Name Required")).toHaveValue("Code reviewer");
  await expect(editor.getByRole("textbox", { name: "Conversation starter 1", exact: true })).toHaveValue("Review this diff before I merge it");
  await expect(editor.getByRole("textbox", { name: "Instructions" })).toHaveValue(/^# Role/u);
  await expect(editor.getByRole("button", { name: "Adjustable" })).toHaveCount(6);
  await expect(editor.getByTestId("assistant-editor-save")).toHaveText("Create");
});

test("Assistant list states explain themselves and stay bounded on phones", async ({ page }, testInfo) => {
  await page.goto("/ui-v2-fixture?fixture=assistants&state=loading");
  const skeleton = page.getByRole("status", { name: "Loading Assistants" });
  await expect(skeleton).toBeVisible();
  await captureState(page, testInfo, "assistant-gallery-loading", {
    atEachSize: async ({ size }) => {
      // The skeleton has the grid's columns, so the list arrives without a jump.
      const width = (await page.getByTestId("assistant-gallery").boundingBox())!.width;
      expect(await gridColumns(skeleton), `${size.width}x${size.height}`).toBe(width >= 900 ? 3 : width >= 600 ? 2 : 1);
      await expectNoHorizontalOverflow(page);
    }
  });

  await page.goto("/ui-v2-fixture?fixture=assistants&state=error");
  await expect(page.getByRole("alert").filter({ hasText: "The list did not load" }))
    .toContainText("Nothing was changed");
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
  await captureState(page, testInfo, "assistant-gallery-error", { atEachSize: () => expectNoHorizontalOverflow(page) });

  await page.goto("/ui-v2-fixture?fixture=assistants&state=empty");
  await expect(page.getByRole("heading", { name: "No Assistants yet" })).toBeVisible();
  await expect(page.getByText("Create one from a template or from your current chat.")).toBeVisible();
  await expect(page.getByRole("button", { name: "From current chat" })).toBeVisible();
  await captureState(page, testInfo, "assistant-gallery-empty", { atEachSize: () => expectNoHorizontalOverflow(page) });

  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/ui-v2-fixture?fixture=assistants&state=list");
  expect(await gridColumns(page.locator(".v2-assistants-grid").first())).toBe(1);
  const more = page.getByRole("button", { name: "More actions for HR Helper" });
  const start = page.getByRole("button", { name: "Start chat with HR Helper" });
  await expect(more).toBeVisible();
  await expect(start).toBeVisible();
  expect((await more.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  // The Category select itself covers its whole box, so any tap in it opens the list.
  const categorySelect = page.getByRole("combobox", { name: "Category" });
  const selectBox = (await categorySelect.boundingBox())!;
  const categoryBox = (await page.locator(".v2-assistants-category").boundingBox())!;
  expect(selectBox.height).toBeGreaterThanOrEqual(44);
  expect(Math.round(selectBox.width)).toBe(Math.round(categoryBox.width));
  expect(Math.round(selectBox.height)).toBe(Math.round(categoryBox.height));
  await expect(page.getByTestId("assistant-card-hr-helper").getByRole("list", { name: "Capabilities" })).toBeHidden();
  await expectNoHorizontalOverflow(page);

  // The phone menu is a modal sheet; the delete dialog it opens still returns focus to the card's menu button.
  await more.click();
  await page.getByRole("dialog", { name: "Actions for HR Helper sheet" }).getByRole("menuitem", { name: "Delete" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete “HR Helper”?" });
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(more).toBeFocused();
});
