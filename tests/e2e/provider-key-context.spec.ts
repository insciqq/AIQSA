import { expect, test } from "@playwright/test";
import { fixtureCheck, fixtureCheckRun, fixtureConnection, fixtureCredential, fixtureModel, FIXTURE_NOW } from "../../components/admin/providers/providerFixtures";
import { signInWithLocalToken } from "./support/localAuth";

test("personal-key results, details and checks share an explicit context without changing access", async ({ page }) => {
  test.setTimeout(90_000);
  const model = fixtureModel({ connectionId: "diagnostic-provider", displayName: "Diagnostic model", id: "diagnostic-model" });
  model.draftConfig = { ...model.draftConfig, adapterKind: "openai_responses_compatible" };
  model.activeConfig = model.draftConfig;
  let connection = fixtureConnection({
    activeChecks: [fixtureCheck({
      credentialId: "personal-key",
      evidence: {
        compatibility: {
          directPdf: "verified", forcedToolCall: "verified", modelAccess: "verified", probeVersion: 2,
          streaming: "verified", structuredOutput: "verified", toolCalling: "verified", usage: "verified", vision: "verified"
        },
        detail: "ok", method: "tiny_generation", selectedProviders: [], upstreamModelId: model.draftConfig.upstreamModelId
      },
      providerModelId: model.id
    })],
    checkRun: fixtureCheckRun({
      credentialId: "personal-key", done: 1, finishedAt: FIXTURE_NOW, id: "setup-run", reason: "setup",
      setup: { defaults: [], search: "skipped", state: "completed" }, state: "completed", total: 1
    }),
    credentials: [
      fixtureCredential({ id: "personal-key", label: "Main" }),
      fixtureCredential({ id: "other-key", label: "Research" }),
      fixtureCredential({ enabled: false, id: "disabled-key", label: "Disabled" }),
      fixtureCredential({ activeVersion: null, id: "unsaved-key", label: "Unsaved" })
    ],
    defaultCredentialId: null,
    displayName: "Diagnostic provider",
    family: "openai_compatible",
    id: "diagnostic-provider",
    models: [model],
    unassignedPolicy: "require_assignment"
  });
  const actions: Record<string, unknown>[] = [];
  await page.route("**/api/admin/providers**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { connections: [connection] } });
      return;
    }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    actions.push(body);
    if (body.action !== "check_models") {
      await route.fulfill({ json: { error: "unexpected_mutation" }, status: 400 });
      return;
    }
    connection = {
      ...connection,
      checkRun: fixtureCheckRun({
        credentialId: String(body.credentialId), id: "requested-run", inFlight: [model.id], reason: "requested", total: 1
      })
    };
    await route.fulfill({ json: { connections: [connection] } });
  });

  await signInWithLocalToken(page);
  await page.goto("/admin?section=providers&resource=diagnostic-provider");
  const models = page.getByTestId("provider-models");
  const picker = models.getByRole("combobox", { name: "Check results for key" });
  const row = models.getByTestId("provider-model-diagnostic-model-works-with");
  await expect(picker).toHaveValue("personal-key");
  await expect(row).toHaveAttribute("data-works-with", "checked");
  await expect(page.getByTestId("provider-default-key")).toHaveValue("");
  await expect(page.getByText("Automatic setup finished.", { exact: true })).toBeVisible();
  await models.getByRole("button", { name: "Diagnostic model", exact: true }).click();
  const details = models.getByTestId("provider-model-diagnostic-model-details");
  await expect(details).toContainText("with key Main");

  await picker.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(picker).toHaveValue("other-key");
  await expect(picker).toBeFocused();
  await expect(row).toHaveAttribute("data-works-with", "not_checked");
  await expect(details).toContainText("Not checked yet with key Research.");
  await expect(page.getByText("Automatic setup finished.", { exact: true })).toHaveCount(0);
  expect(actions).toEqual([]);
  await expect(picker.locator('option[value="disabled-key"]')).toHaveJSProperty("disabled", true);
  await expect(picker.locator('option[value="unsaved-key"]')).toHaveJSProperty("disabled", true);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(picker).toHaveValue("other-key");

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 500 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await picker.scrollIntoViewIfNeeded();
      await expect(picker).toBeInViewport();
      await expect(details.getByRole("button", { name: "Re-check" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      const box = await picker.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      await page.screenshot({ path: test.info().outputPath(`key-${colorScheme}-${viewport.width}x${viewport.height}.png`) });
    }
  }

  await models.getByRole("button", { name: "Check models" }).click();
  expect(actions).toEqual([{ action: "check_models", credentialId: "other-key" }]);
  await expect(row).toHaveAttribute("data-works-with", "checking");
  await expect(page.getByTestId("provider-check-banner")).toContainText("key Research");
  await picker.selectOption("personal-key");
  await expect(row).toHaveAttribute("data-works-with", "checked");
  await expect(page.getByTestId("provider-check-banner")).toHaveCount(0);
  await expect(models.getByRole("button", { name: "Check models" })).toBeDisabled();
  expect(actions).toHaveLength(1);
  expect(connection.defaultCredentialId).toBeNull();
  expect(connection.unassignedPolicy).toBe("require_assignment");
  expect(connection.assignments).toEqual([]);
  expect(connection.userAssignments).toEqual([]);
});
