import { expect, test } from "@playwright/test";
import { fixtureCheck, workingConnection } from "../../components/admin/providers/providerFixtures";
import { signInWithLocalToken } from "./support/localAuth";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";

test("PDF results distinguish incomplete checks, unsupported input and fresh proof", async ({ page }) => {
  const connection = workingConnection();
  connection.models = [connection.models[0]!];
  const model = connection.models[0]!;
  const config = model.activeConfig!;
  connection.activeChecks = [fixtureCheck({ credentialId: "cred-primary", providerModelId: model.id,
    evidence: { detail: "ok", method: "tiny_generation", selectedProviders: [], upstreamModelId: config.upstreamModelId,
      compatibility: { probeVersion: 2, modelAccess: "verified", directPdf: "not_supported", structuredOutput: "verified",
        streaming: "verified", usage: "verified" },
      capabilitySetup: { policyVersion: 1, checks: { modelAccess: "verified", directPdf: "incomplete" } }
    } })];
  await page.route("**/api/admin/providers**", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({ json: { connections: [connection] } });
  });
  await signInWithLocalToken(page);
  await page.goto(`/admin?section=providers&resource=${connection.id}`);
  const models = page.getByTestId("provider-models");
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(models.getByText("PDF check incomplete", { exact: true })).toBeVisible();
      await expect(models.getByText("No PDF", { exact: true })).toHaveCount(0);
      await expect(models.getByText("JSON", { exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  }
  const evidence = connection.activeChecks[0]!.evidence!;
  evidence.capabilitySetup!.checks.directPdf = "unsupported";
  await page.reload();
  await expect(models.getByText("No PDF", { exact: true })).toBeVisible();
  await expect(models.getByText("PDF check incomplete", { exact: true })).toHaveCount(0);
  evidence.capabilitySetup!.checks.directPdf = "verified";
  evidence.compatibility!.directPdf = "verified";
  evidence.pdfInput = { adapterKind: "openai_responses_native", probeVersion: 1, upstreamModelId: config.upstreamModelId, verified: true };
  await page.reload();
  await expect(models.getByText("PDF", { exact: true })).toBeVisible();
  await expect(models.getByText("No PDF", { exact: true })).toHaveCount(0);
  await expect(models.getByText("PDF check incomplete", { exact: true })).toHaveCount(0);
});
