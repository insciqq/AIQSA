import { expect, test } from "@playwright/test";
import { fixtureCheck, fixtureCredential, workingConnection } from "../../components/admin/providers/providerFixtures";
import { signInWithLocalToken } from "./support/localAuth";

test("model JSON preserves local drafts, native undo, nested focus and viewport access", async ({ page }) => {
  let connection = workingConnection();
  const model = connection.models[0]!;
  connection.credentials.push(fixtureCredential({ id: "research", label: "Research diagnostics with a long key label" }));
  connection.activeChecks = [fixtureCheck({ credentialId: "research", providerModelId: model.id })];
  const mutations: Record<string, unknown>[] = [];
  let catalogReads = 0;
  await page.route("**/api/admin/providers**", async (route) => {
    if (route.request().method() === "GET") {
      catalogReads += 1;
      await route.fulfill({ json: { connections: [connection] } });
      return;
    }
    mutations.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ json: { error: "provider_draft_stale" }, status: 409 });
  });
  await signInWithLocalToken(page);
  await page.goto(`/admin?section=providers&resource=${connection.id}`);
  const models = page.getByTestId("provider-models");
  await models.getByRole("combobox", { name: "Check results for key" }).selectOption("research");
  await models.getByRole("button", { name: `More actions for ${model.displayName}` }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Edit model" });
  await expect(sheet).toContainText("with key Research diagnostics with a long key label");
  await expect(sheet).toContainText("Test & Save uses key Primary.");
  await expect(sheet.getByText(/^Advanced/)).toHaveCount(0);
  await sheet.getByLabel("Display name").fill("Local model settings survive the JSON dialog and background refresh");
  await sheet.getByLabel("Response timeout (seconds)").fill("125");
  const trigger = sheet.getByRole("button", { name: "Edit JSON" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Default parameters · JSON" });
  const editor = dialog.getByRole("textbox", { name: "Default parameters JSON" });
  await editor.fill('{"x":1}');
  await dialog.getByRole("button", { name: "Format", exact: true }).click();
  await expect(editor).toHaveValue('{\n  "x": 1\n}');
  await editor.press("ControlOrMeta+z");
  await expect(editor).toHaveValue('{"x":1}');
  await editor.press("ControlOrMeta+Shift+z");
  await expect(editor).toHaveValue('{\n  "x": 1\n}');

  const value = JSON.stringify({ provider: { settings: Array.from({ length: 40 }, (_, index) => ({ index, enabled: true })), longValue: "long-parameter-".repeat(80) } }, null, 2);
  await editor.fill(value);
  await editor.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(2, 2));
  await editor.press("Tab");
  await expect(editor).toHaveValue(value.slice(0, 2) + "  " + value.slice(2));
  await editor.press("ControlOrMeta+z");
  await expect(editor).toHaveValue(value);
  await editor.press("Control+m");
  await editor.press("Tab");
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await dialog.getByRole("button", { name: "Apply to model" }).focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close JSON editor" })).toBeFocused();

  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((selected) => { document.documentElement.dataset.theme = selected; }, theme);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 420 }, { width: 390, height: 844 }, { width: 390, height: 420 }]) {
      await page.setViewportSize(viewport);
      await expect(dialog.getByRole("button", { name: "Apply to model" })).toBeInViewport();
      await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport();
      const geometry = await editor.boundingBox();
      expect(geometry!.height).toBeGreaterThan(80);
      expect(geometry!.x).toBeGreaterThanOrEqual(0);
      expect(geometry!.x + geometry!.width).toBeLessThanOrEqual(viewport.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await expect(editor).toHaveValue(value);
    }
  }

  const previousReads = catalogReads;
  connection = structuredClone(connection);
  connection.models[0]!.draftVersion += 1;
  connection.models[0]!.displayName = "Saved elsewhere";
  connection.activeChecks[0]!.latestRefreshError = { code: "provider_refresh_failed", version: 1 };
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => catalogReads).toBeGreaterThan(previousReads);
  await expect(editor).toHaveValue(value);
  await editor.press("Escape");
  const discard = page.getByRole("dialog", { name: "Discard JSON changes" });
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Keep editing" }).press("Escape");
  await expect(discard).toHaveCount(0);
  await expect(editor).toHaveValue(value);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Apply to model" }).click();
  await expect(trigger).toBeFocused();
  await expect(sheet.getByLabel("Display name")).toHaveValue("Local model settings survive the JSON dialog and background refresh");
  await expect(sheet.getByLabel("Response timeout (seconds)")).toHaveValue("125");
  await expect(sheet).toContainText("Earlier results were kept.");
  expect(mutations).toEqual([]);

  await trigger.click();
  await editor.fill('{\n  "broken":\n}');
  await dialog.getByRole("button", { name: "Format", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Line 3, column 1");
  await dialog.getByRole("button", { name: "Apply to model" }).click();
  await expect(editor).toHaveValue('{\n  "broken":\n}');
  await dialog.getByRole("button", { name: "Close JSON editor" }).click();
  await discard.getByRole("button", { name: "Confirm discard json changes" }).click();
  await expect(trigger).toBeFocused();
  await sheet.getByRole("button", { name: "Test & Save" }).click();
  await expect(sheet.getByRole("alert")).toContainText("changed in another window");
  expect(mutations).toEqual([expect.objectContaining({ expectedDraftVersion: 1, configuration: expect.objectContaining({ defaultParams: JSON.parse(value), responseTimeoutSeconds: 125 }) })]);
  await trigger.click();
  await expect(editor).toHaveValue(value);
});
