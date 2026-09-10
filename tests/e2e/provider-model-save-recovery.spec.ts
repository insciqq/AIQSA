import { expect, test } from "@playwright/test";
import type { AdminProviderModelConfiguration } from "../../lib/contracts/adminProviders";
import { fixtureConnection, fixtureModel } from "../../components/admin/providers/providerFixtures";
import { signInWithLocalToken } from "./support/localAuth";

for (const mode of ["name", "configuration", "partial", "draft_failure"] as const) {
  test(`model save recovery keeps confirmed fields clean and unsaved fields protected: ${mode}`, async ({ page }) => {
    const original = fixtureModel({ connectionId: "save-recovery", id: "recovery-model", displayName: "Original model" });
    let model = original;
    const mutations: Record<string, unknown>[] = [];
    await page.route("**/api/admin/providers**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ json: { connections: [fixtureConnection({ id: original.connectionId, displayName: "Recovery provider", models: [model] })] } });
        return;
      }
      const body = route.request().postDataJSON() as Record<string, unknown>;
      mutations.push(body);
      expect(body.action).toBe(mode === "name" ? "rename" : "update");
      model = { ...model, displayName: String(body.displayName), updatedAt: "2026-09-10T12:00:00.000Z",
        ...(mode !== "name" && mode !== "partial" ? { draftConfig: body.configuration as AdminProviderModelConfiguration, draftVersion: 2 } : {}),
        ...(mode === "configuration" ? { activeConfig: body.configuration as AdminProviderModelConfiguration, activeVersion: 2 } : {}) };
      if (mode === "draft_failure") {
        await route.fulfill({ contentType: "application/x-ndjson", body: `${JSON.stringify({ type: "result", status: 502,
          data: { error: "provider_refresh_failed", receipt: { connectionId: original.connectionId, modelId: original.id,
            displayName: model.displayName, draftVersion: 2, saved: "configuration", publication: "draft", checks: "not_requested" } } })}\n` });
      } else if (mode === "name") {
        await route.fulfill({ contentType: "application/json", body: "{broken" });
      } else {
        // The connection ends after persistence, without a terminal result.
        await route.fulfill({ contentType: "application/x-ndjson", body: '{"type":"heartbeat"}\n' });
      }
    });
    await signInWithLocalToken(page);
    await page.setViewportSize(mode === "partial" ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await page.goto(`/admin?section=providers&resource=${original.connectionId}`);
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, mode === "partial" ? "dark" : "light");
    const row = page.getByTestId(`provider-model-${original.id}`);
    await row.getByRole("button", { name: "More actions for Original model" }).click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Edit model" });
    await sheet.getByLabel("Display name", { exact: true }).fill("Saved name");
    if (mode !== "name") await sheet.getByLabel("Response timeout (seconds)").fill("120");
    await sheet.getByRole("button", { name: mode === "name" ? "Save" : "Test & Save", exact: true }).click();
    if (mode !== "name") {
      await expect(sheet.getByRole("alert")).toContainText(mode === "partial" ? "Some fields are saved"
        : mode === "draft_failure" ? "The draft was saved, but these changes were not activated." : "Model settings saved.");
      if (mode === "partial") {
        await sheet.getByRole("button", { name: "View model results" }).click();
        const discard = page.getByTestId("provider-model-discard");
        await expect(discard).toBeVisible();
        await discard.getByRole("button", { name: "Cancel", exact: true }).click();
        await sheet.getByLabel("Response timeout (seconds)").fill("");
        await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
      } else {
        await sheet.getByRole("button", { name: "Cancel", exact: true }).focus();
        await page.keyboard.press("Escape");
      }
    }
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId("provider-model-discard")).toHaveCount(0);
    await expect(row).toContainText("Saved name");
    expect(mutations).toHaveLength(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await row.getByRole("button", { name: "More actions for Saved name" }).click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await sheet.getByLabel("Display name", { exact: true }).fill("New unsaved edit");
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByTestId("provider-model-discard")).toBeVisible();
    expect(mutations).toHaveLength(1);
  });
}
