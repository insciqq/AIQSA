import { expect, test } from "@playwright/test";
import { fixtureConnection, fixtureCredential } from "../../components/admin/providers/providerFixtures";
import { signInWithLocalToken } from "./support/localAuth";

test("key-first setup unlocks model creation only after the saved key is available", async ({ page }) => {
  let connection = fixtureConnection({ family: "openrouter", id: "first-key-provider", displayName: "First key provider" });
  let attempts = 0;
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  await page.route("**/api/admin/providers**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { connections: [connection] } });
    } else if (new URL(route.request().url()).pathname.endsWith("/credentials")) {
      attempts += 1;
      if (attempts === 1) {
        await route.fulfill({ status: 422, json: { error: "provider_credential_test_failed" } });
      } else {
        await saveGate;
        connection = { ...connection, credentials: [fixtureCredential({ id: "first-key", label: "Main" })] };
        await route.fulfill({ status: 201, json: { connections: [connection] } });
      }
    } else if (route.request().postDataJSON().action === "discover_models") {
      await route.fulfill({ json: { models: [] } });
    } else {
      await route.fulfill({ status: 400, json: { error: "unexpected_mutation" } });
    }
  });
  await signInWithLocalToken(page);
  await page.goto(`/admin?section=providers&resource=${connection.id}`);
  const addKey = page.getByRole("button", { name: "Add key", exact: true });
  const addModel = page.getByTestId("provider-add-model");
  await expect(addKey).toHaveAttribute("data-tone", "primary");
  await expect(addModel).toBeDisabled();
  await expect(addModel).toHaveAccessibleDescription("Add a working key first, then add models.");
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 600 }]) {
      await page.setViewportSize(viewport);
      await addModel.scrollIntoViewIfNeeded();
      await expect(page.getByText("Add a working key first, then add models.")).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`first-key-${theme}-${viewport.width}.png`) });
    }
  }
  await addKey.focus();
  await page.keyboard.press("Enter");
  const form = page.getByTestId("provider-key-form");
  const secret = form.getByLabel("API key", { exact: true });
  await expect(secret).toBeFocused();
  await secret.fill("synthetic-invalid-value");
  await form.getByRole("button", { name: "Test & Save" }).click();
  await expect(form.getByRole("alert")).toContainText("rejected this key");
  await expect(addModel).toBeDisabled();
  await secret.fill("synthetic-saved-value");
  await form.getByRole("button", { name: "Test & Save" }).click();
  await expect(form.getByRole("button", { name: "Test & Save" })).toHaveAttribute("aria-busy", "true");
  await expect(addModel).toBeDisabled();
  releaseSave();
  await expect(form).toHaveCount(0);
  await expect(addModel).toBeEnabled();
  await expect(addKey).toHaveAttribute("data-tone", "ghost");
  await expect(page.getByText("Add a working key first, then add models.")).toHaveCount(0);
  await addModel.click();
  await expect(page.getByRole("menuitem", { name: "Embedding preset" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Reranker preset" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Chat model" }).click();
  await expect(page.getByRole("dialog", { name: "Add model" })).toBeVisible();
  expect(connection.defaultCredentialId).toBeNull();
});

test("explicitly keyless compatible providers keep model setup available", async ({ page }) => {
  const connection = fixtureConnection({ family: "openai_compatible", id: "keyless-provider", displayName: "Keyless provider" });
  connection.draftConfig = { ...connection.draftConfig, authenticationMode: "none" };
  connection.activeConfig = connection.draftConfig;
  await page.route("**/api/admin/providers**", (route) => route.fulfill({ json: { connections: [connection] } }));
  await signInWithLocalToken(page);
  await page.goto(`/admin?section=providers&resource=${connection.id}`);
  await expect(page.getByTestId("provider-add-model")).toBeEnabled();
  await expect(page.getByRole("button", { name: "Add key" })).toHaveAttribute("data-tone", "ghost");
  await expect(page.getByText("Add a working key first, then add models.")).toHaveCount(0);
});
