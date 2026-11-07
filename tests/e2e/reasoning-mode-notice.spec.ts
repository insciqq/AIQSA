import { expect, test } from "@playwright/test";
import { defaultProviderModels, fallbackParameterControls } from "../../lib/domain/catalog";
import { buildCurrentUserCatalog, type CatalogData } from "../../lib/server/catalog/currentUserCatalog";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { closeRunSetup, openRunSetup } from "./shell/composer";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

// A codex-lb answer model: reasoning efforts and no reasoning mode, as setup saves it (2026-11-07).
const template = defaultProviderModels.find((model) => model.provider === "openai" && model.modelId === "gpt-5.5");
if (!template) throw new Error("missing GPT-5.5 template");
const codexLb = {
  ...template,
  adapterKind: "openai_responses_compatible" as const,
  displayName: "GPT-6.1 Sol",
  modelId: "gpt-6.1-sol",
  parameterControls: fallbackParameterControls({
    adapterKind: "openai_responses_compatible",
    defaultParams: { reasoning: { effort: "medium" } },
    provider: "codexlb",
    supportsReasoning: true,
    supportsReasoningMode: true,
    upstreamModelId: "gpt-6.1-sol"
  }),
  provider: "codexlb",
  providerDisplayName: "OpenAI (CodexLB)",
  providerFamily: "openai_compatible",
  upstreamModelId: "gpt-6.1-sol"
};
const NOTICE = "Your saved reasoning mode “pro” is not available for this model, so its default is used.";

const viewports = [
  { height: 900, name: "desktop", theme: "dark", width: 1440 },
  { height: 1180, name: "tablet", theme: "light", width: 820 },
  { height: 844, name: "phone", theme: "light", width: 390 },
  { height: 390, name: "phone-landscape", theme: "dark", width: 844 }
] as const;

for (const viewport of viewports) {
  test(`a saved Pro mode a codex-lb model does not offer is named, ${viewport.name}`, async ({ context, page }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ height: viewport.height, width: viewport.width });
    await page.emulateMedia({ colorScheme: viewport.theme });
    await context.addCookies([{ name: "aiqsa.theme", url: "http://127.0.0.1:3000", value: viewport.theme }]);
    const data: CatalogData = {
      entitlements: { fullAccess: true, modelKeys: new Set(), providerKeys: new Set(), searchStrategies: new Set() },
      modelPolicy: { defaultProviderModelId: codexLb.modelId, reasoningEffort: null },
      models: [codexLb],
      searchStrategies: [],
      settings: {
        defaultControlValues: { "codexlb:gpt-6.1-sol": { reasoningEffort: "low", reasoningMode: "pro" } },
        defaultProviderModelId: null,
        defaultSearchPlan: null,
        showCitations: true,
        showReasoningBlocks: false
      }
    };
    expect(codexLb.parameterControls.reasoningMode).toBeUndefined();
    await installMatrixCatalogFixture(page);
    await page.route("**/api/me/catalog", (route) => route.fulfill({ json: { catalog: buildCurrentUserCatalog(data) } }));
    await signInWithLocalToken(page);
    await expect(page.getByTestId("header-model-trigger")).toContainText("GPT-6.1 Sol");

    // The composer's reasoning menu names the unavailable saved mode beside the levels. On a phone the composer rests
    // as one line until engaged.
    await page.getByRole("textbox", { name: "Message", exact: true }).click();
    const chip = page.getByTestId("composer-v2").getByRole("button", { name: /^Reasoning effort:/u });
    await expect(chip).toHaveAccessibleName("Reasoning effort: low");
    await chip.click();
    const menu = page.getByRole("menu", { name: "Reasoning effort" });
    await expect(menu).toBeVisible();
    const menuNote = menu.getByTestId("composer-reasoning-mode-notice");
    await expect(menuNote).toHaveText(NOTICE);
    await expectWithinViewport(page, menuNote);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`mode-notice-menu-${viewport.name}.png`) });
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // So does the Model parameters dialog, which offers no mode control for this model.
    const setup = await openRunSetup(page);
    await expect(setup.getByText(NOTICE)).toBeVisible();
    await expect(setup.getByLabel("Reasoning mode")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`mode-notice-parameters-${viewport.name}.png`) });
    await closeRunSetup(page);
  });
}
