import { expect, test, type Page } from "@playwright/test";
import type { SubagentDefinitionSummary } from "../../lib/contracts/subagentDefinitions";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { runAccountMenuAction } from "./shell/page";
import { captureState } from "./support/capture";
import { expectNoHorizontalOverflow, expectTouchSafe } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

/**
 * The default sub-agent switch in Studio, on a scripted owner-only server: the
 * pointer itself is covered on a real database by
 * `lib/server/subagents/definitionStore.prisma.test.ts`.
 */

const summary = (id: string, name: string, modelAvailable = true): SubagentDefinitionSummary => ({
  description: `Synthetic helper ${name}, whose description is long enough to reach the end of a narrow row and be cut there.`,
  effort: "high", id, modelAvailable, modelDisplayName: modelAvailable ? "Gemini 3.5" : null, modelId: modelAvailable ? "gemini-3-5" : "gone",
  name, revisionNumber: 1, tools: null, updatedAt: "2026-10-30T10:00:00.000Z", version: 1
});

async function openPanel(page: Page) {
  const definitions = [summary("helper-1", "gemini-helper"), summary("helper-2", `long-${"x".repeat(40)}`), summary("helper-3", "lost-model", false)];
  const state = { defaultDefinitionId: "helper-1" as string | null };
  await installMatrixCatalogFixture(page);
  await page.route("**/api/me/subagents", (route) => route.fulfill({ json: {
    defaultDefinitionId: state.defaultDefinitionId, definitions, limit: 50, models: []
  } }));
  await page.route("**/api/me/subagents/default", async (route) => {
    const body = route.request().postDataJSON() as { definitionId: string | null; expected: string | null };
    expect(body.expected).toBe(state.defaultDefinitionId);
    state.defaultDefinitionId = body.definitionId;
    await route.fulfill({ json: { defaultDefinitionId: state.defaultDefinitionId } });
  });
  await signInWithLocalToken(page);
  const library = await runAccountMenuAction(page, "Instructions");
  await library.getByRole("tab", { name: "Sub-agents", exact: true }).click();
  await expect(page.getByTestId("studio-subagents").getByRole("heading", { name: "Sub-agents" })).toBeVisible();
  return { panel: page.getByTestId("studio-subagents"), state };
}

test("the default sub-agent switch has one default, a mark and a deletion that says what follows", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ height: 900, width: 1440 });
  const { panel, state } = await openPanel(page);
  const rows = panel.getByRole("list", { name: "Your sub-agents" }).getByRole("listitem");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).getByText("Default", { exact: true })).toBeVisible();
  await expect(rows.nth(1).getByText("Default", { exact: true })).toHaveCount(0);
  await captureState(page, testInfo, "subagents-studio-default", { atEachSize: async () => expectNoHorizontalOverflow(page) });

  // Moving it leaves one default.
  await panel.getByRole("switch", { name: /Make long-x+ the default sub-agent/u }).click();
  await expect.poll(() => state.defaultDefinitionId).toBe("helper-2");
  await expect(rows.nth(1).getByText("Default", { exact: true })).toBeVisible();
  await expect(rows.nth(0).getByText("Default", { exact: true })).toHaveCount(0);

  // Turning it off goes back to the built-in.
  await panel.getByRole("switch", { name: /Make long-x+ the default sub-agent/u }).click();
  await expect.poll(() => state.defaultDefinitionId).toBeNull();
  await expect(panel.getByText("Default", { exact: true })).toHaveCount(0);

  await panel.getByRole("switch", { name: "Make gemini-helper the default sub-agent" }).click();
  await expect.poll(() => state.defaultDefinitionId).toBe("helper-1");
  await panel.getByRole("button", { name: "More actions for gemini-helper" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(rows.nth(0).getByRole("alert")).toContainText("built-in");
  await captureState(page, testInfo, "subagents-studio-delete-default", { anchor: rows.nth(0), atEachSize: async () => expectNoHorizontalOverflow(page) });
});

test.describe("touch", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("the switch is touch-safe on a phone", async ({ page }) => {
    await page.setViewportSize({ height: 844, width: 390 });
    const { panel } = await openPanel(page);
    await expectTouchSafe(panel.getByRole("switch", { name: "Make gemini-helper the default sub-agent" }));
    await expectNoHorizontalOverflow(page);
  });
});
