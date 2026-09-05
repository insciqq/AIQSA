import { expect, test } from "@playwright/test";

test("Assistant cards keep owner, shared, and repair actions honest", async ({ page }) => {
  await page.goto("/ui-v2-fixture?fixture=assistants&state=list");

  const owner = page.getByTestId("assistant-card-api-reviewer");
  await expect(owner.getByRole("button", { name: "Use API Reviewer" })).toBeEnabled();
  await expect(owner.getByRole("button", { name: "Edit" })).toBeVisible();
  await owner.getByRole("button", { name: "More actions for API Reviewer" }).click();
  await expect(page.getByRole("menuitem", { name: "Version history" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Unpin" })).toBeVisible();
  await page.keyboard.press("Escape");

  const shared = page.getByTestId("assistant-card-research-editor");
  await expect(shared).toContainText("Shared by Maya Chen");
  await expect(shared.getByRole("button", { name: "Use Research editor" })).toBeEnabled();
  await expect(shared.getByRole("button", { exact: true, name: "Edit" })).toHaveCount(0);

  const unavailable = page.getByTestId("assistant-card-release-helper");
  await expect(unavailable.getByRole("button", { name: "Use Release helper" })).toBeDisabled();
  await expect(unavailable.getByRole("button", { name: "Fix in Settings…" })).toBeVisible();
  await unavailable.getByRole("button", { name: "Why?" }).click();
  await expect(unavailable).toContainText("GitHub is turned off or needs attention.");

  const foreignUnavailable = page.getByTestId("assistant-card-contract-analyst");
  await expect(foreignUnavailable.getByRole("button", { exact: true, name: "Edit" })).toHaveCount(0);
  await expect(foreignUnavailable.getByRole("button", { name: /Fix/u })).toHaveCount(0);
  await foreignUnavailable.getByRole("button", { name: "Why?" }).click();
  await expect(foreignUnavailable).not.toContainText("GitHub");
  await expect(foreignUnavailable).not.toContainText("MCP");
});

test("Assistant editor is an inline, guarded Library subview", async ({ page }) => {
  await page.goto("/ui-v2-fixture?fixture=assistants&state=dirty");

  const editor = page.getByTestId("assistant-editor");
  await expect(editor).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Assistants" })).toHaveCount(0);
  await expect(editor.getByLabel("Name Required")).toHaveValue("API Reviewer");
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  const cancel = editor.getByRole("button", { name: "Cancel" });
  await cancel.click();
  const confirmation = page.getByRole("dialog", { name: "Discard assistant draft changes" });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Keep editing" }).click();
  await expect(cancel).toBeFocused();

  await expect(editor).not.toContainText(/Revision|Publish update/u);
  await expect(page.getByTestId("assistant-history")).toHaveCount(0);
});

test("Assistant list states and mobile actions stay bounded", async ({ page }) => {
  await page.goto("/ui-v2-fixture?fixture=assistants&state=loading");
  await expect(page.getByRole("status", { name: "Loading assistants" })).toBeVisible();

  await page.goto("/ui-v2-fixture?fixture=assistants&state=error");
  await expect(page.getByRole("alert").filter({ hasText: "The list did not load" }))
    .toContainText("Nothing was changed");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

  await page.goto("/ui-v2-fixture?fixture=assistants&state=empty");
  await expect(page.getByRole("heading", { name: "No assistants yet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create from current chat" })).toBeVisible();

  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/ui-v2-fixture?fixture=assistants&state=list");
  const cards = page.locator(".v2-assistant-grid");
  expect(await cards.evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.split(" ").length
  )).toBe(1);
  const more = page.getByRole("button", { name: "More actions for API Reviewer" });
  const use = page.getByRole("button", { name: "Use API Reviewer" });
  await expect(more).toBeVisible();
  await expect(use).toBeVisible();
  expect((await more.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() =>
    document.body.scrollWidth <= window.innerWidth &&
    document.documentElement.scrollWidth <= window.innerWidth
  )).toBe(true);
});
