import { expect, test } from "@playwright/test";
import { fixtureCheck, fixtureCredential, workingConnection } from "../../components/admin/providers/providerFixtures";
import { signInWithLocalToken } from "./support/localAuth";
import { expectNoHorizontalOverflow, expectTouchSafe } from "./support/layoutAssertions";

test.use({ hasTouch: true });

test("PDF results distinguish incomplete checks, unsupported input and fresh proof", async ({ page }) => {
  const connection = workingConnection();
  connection.models = [connection.models[0]!];
  const model = connection.models[0]!;
  const config = model.activeConfig!;
  connection.credentials.push(fixtureCredential({ id: "research-key", label: "Research" }));
  connection.activeChecks = [fixtureCheck({ credentialId: "cred-primary", providerModelId: model.id,
    latestRefreshError: { code: "provider_refresh_failed", version: 1 }, refreshFailedAt: connection.updatedAt,
    evidence: { detail: "ok", method: "tiny_generation", selectedProviders: [], upstreamModelId: config.upstreamModelId,
      compatibility: { probeVersion: 2, modelAccess: "verified", directPdf: "not_supported", structuredOutput: "verified",
        streaming: "verified", usage: "verified", toolCalling: "not_supported", forcedToolCall: "not_supported", parallelToolCalls: "not_supported" },
      capabilitySetup: { policyVersion: 2, checks: { modelAccess: "verified", directPdf: "incomplete",
        toolCalling: "incomplete", forcedToolCall: "incomplete", parallelToolCalls: "incomplete" },
        attempts: { directPdf: { attempts: 3, status: "incomplete", reason: "budget_exhausted" },
          toolCalling: { attempts: 3, status: "incomplete", reason: "malformed_tool_output" },
          forcedToolCall: { attempts: 3, status: "incomplete", reason: "rate_limit", httpStatus: 429 },
          parallelToolCalls: { attempts: 3, status: "incomplete", reason: "budget_exhausted" } } }
    } })];
  const actions: unknown[] = [];
  await page.route("**/api/admin/providers**", async (route) => {
    if (route.request().method() !== "GET") actions.push(route.request().postDataJSON());
    await route.fulfill({ json: { connections: [connection] } });
  });
  await signInWithLocalToken(page);
  await page.goto(`/admin?section=providers&resource=${connection.id}`);
  const models = page.getByTestId("provider-models");
  const pdf = models.getByTestId("model-chip-pdf");
  const explanation = pdf.locator("..").locator("p");
  let scrolledExplanation = false;
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await expect(pdf).toHaveText("PDF");
      await expect(pdf).toHaveAttribute("data-chip-tone", "muted");
      await expectTouchSafe(pdf);
      await expect(explanation).toBeHidden();
      await pdf.focus();
      await page.keyboard.press("Enter");
      await expect(explanation).toContainText("Inconclusive: this check did not prove support.");
      await expect(explanation).toContainText("output budget exhausted · 3 attempts");
      await expect(explanation).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(explanation).toBeHidden();
      await expect(pdf).toBeFocused();
      await pdf.tap();
      await expect(explanation).toBeVisible();
      const size = await explanation.boundingBox();
      expect(size!.height).toBeLessThanOrEqual(160);
      await expect(models.getByText("JSON", { exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await pdf.tap();
      const tools = models.getByTestId("model-chip-tools");
      await tools.tap();
      const toolsHelp = tools.locator("..").locator("p");
      await expect(toolsHelp).toContainText("The latest model check could not finish. Earlier saved results are kept.");
      await toolsHelp.focus();
      // A retained refresh result adds real bounded copy; scroll only when that
      // copy overflows at this viewport, and require an exercised scroll below.
      if (await toolsHelp.evaluate((element) => element.scrollHeight > element.clientHeight)) {
        await page.keyboard.press("End");
        await expect.poll(() => toolsHelp.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        scrolledExplanation = true;
      }
      await page.keyboard.press("Escape");
      await expect(toolsHelp).toBeHidden();
      await expect(tools).toBeFocused();
    }
  }
  expect(scrolledExplanation, "a long retained check explanation can be scrolled with the keyboard").toBe(true);
  const evidence = connection.activeChecks[0]!.evidence!;
  evidence.capabilitySetup!.checks.directPdf = "unsupported";
  evidence.capabilitySetup!.attempts!.directPdf = { attempts: 1, status: "unsupported", reason: "route_unsupported", httpStatus: 404 };
  await page.reload();
  await pdf.tap();
  await expect(pdf).toHaveAttribute("data-chip-tone", "muted");
  await expect(explanation).toContainText("Unsupported on this route.");
  await expect(explanation).toContainText("HTTP 404 · 1 attempt");
  evidence.capabilitySetup!.checks.directPdf = "not_checked";
  evidence.capabilitySetup!.attempts!.directPdf = { attempts: 0, status: "not_checked", reason: "not_checked" };
  await page.reload();
  await pdf.tap();
  await expect(explanation).toContainText("Not checked with this key.");
  await expect(explanation).not.toContainText("Unsupported");
  evidence.capabilitySetup!.checks.directPdf = "verified";
  evidence.capabilitySetup!.attempts!.directPdf = { attempts: 2, status: "incomplete", reason: "timeout" };
  evidence.compatibility!.directPdf = "verified";
  evidence.pdfInput = { adapterKind: "openai_responses_native", probeVersion: 1, upstreamModelId: config.upstreamModelId, verified: true };
  await page.reload();
  await expect(pdf).toHaveAttribute("data-chip-tone", "ok");
  await pdf.tap();
  await expect(explanation).toContainText("Previously verified. Latest check inconclusive: check timed out · 2 attempts.");
  await expect(models.getByText("Check failed", { exact: true })).toHaveCount(0);
  await expect(models.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  expect(actions).toEqual([]);

  // The explicit menu remains usable with touch and keyboard and selects its own key.
  await models.getByRole("button", { name: `More actions for ${model.displayName}` }).tap();
  const recheck = page.getByRole("menuitem", { name: "Re-check with key…" });
  await recheck.focus();
  await page.keyboard.press("Enter");
  const research = page.getByRole("menuitem", { name: "Research" });
  await research.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => actions).toEqual([{ action: "check_models", credentialId: "research-key", modelIds: [model.id] }]);
  expect(connection.defaultCredentialId).toBe("cred-primary");
});
