import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  expectTouchSafe,
  expectWithinViewport
} from "./support/layoutAssertions";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { composerRunSummary, openRunSetup } from "./shell/composer";
import { signInWithLocalToken as signIn } from "./support/localAuth";

const safeArea = {
  bottom: 23,
  left: 41,
  right: 37,
  top: 19
} as const;

const compactViewports = [
  { height: 844, name: "portrait", width: 390 },
  { height: 390, name: "landscape", width: 844 }
] as const;

test.use({ hasTouch: true, isMobile: true });

async function installEmptyResourceFixtures(page: Page): Promise<void> {
  await page.route("**/api/me/assistants*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      json: {
        assistants: [],
        publishableGroups: [],
        viewer: { canPublishInstallation: false }
      }
    });
  });
  await page.route("**/api/me/knowledge-bases*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      json: {
        embeddingDeployments: [],
        knowledgeBases: [],
        publishableGroups: [],
        viewer: { canPublishInstallation: false }
      }
    });
  });
}

async function expectInjectedSafeArea(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        const read = (side: string) =>
          Number.parseFloat(style.getPropertyValue(`--composer-picker-safe-area-inset-${side}`));
        return {
          bottom: read("bottom"),
          coarse: matchMedia("(pointer: coarse)").matches,
          left: read("left"),
          noHover: matchMedia("(hover: none)").matches,
          right: read("right"),
          top: read("top")
        };
      })
    )
    .toEqual({ ...safeArea, coarse: true, noHover: true });
}

async function expectSafeAreaGeometry(
  page: Page,
  surface: Locator,
  close: Locator,
  options: Readonly<{ bottomContent?: Locator; surfaceClearsBottom?: boolean }> = {}
): Promise<void> {
  await expectWithinViewport(page, surface);
  await expectTouchSafe(close);

  const [surfaceBox, closeBox, viewport] = await Promise.all([
    surface.boundingBox(),
    close.boundingBox(),
    page.viewportSize()
  ]);
  expect(surfaceBox).toBeTruthy();
  expect(closeBox).toBeTruthy();
  expect(viewport).toBeTruthy();

  expect(surfaceBox!.x).toBeGreaterThanOrEqual(safeArea.left - 1);
  expect(surfaceBox!.x + surfaceBox!.width).toBeLessThanOrEqual(
    viewport!.width - safeArea.right + 1
  );
  expect(surfaceBox!.y).toBeGreaterThanOrEqual(safeArea.top - 1);
  if (options.surfaceClearsBottom !== false) {
    expect(surfaceBox!.y + surfaceBox!.height).toBeLessThanOrEqual(
      viewport!.height - safeArea.bottom + 1
    );
  }

  expect(closeBox!.x).toBeGreaterThanOrEqual(safeArea.left - 1);
  expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(
    viewport!.width - safeArea.right + 1
  );
  expect(closeBox!.y).toBeGreaterThanOrEqual(safeArea.top - 1);
  expect(closeBox!.y + closeBox!.height).toBeLessThanOrEqual(
    viewport!.height - safeArea.bottom + 1
  );

  if (options.bottomContent) {
    const bottomContentBox = await options.bottomContent.boundingBox();
    expect(bottomContentBox).toBeTruthy();
    expect(bottomContentBox!.y + bottomContentBox!.height).toBeLessThanOrEqual(
      viewport!.height - safeArea.bottom + 1
    );
  }

  await expectNoHorizontalOverflow(page);
}

test("keeps compact composer pickers dismissible and safe-area bounded", async ({ page }) => {
  await installEmptyResourceFixtures(page);
  await installMatrixCatalogFixture(page);
  await signIn(page);
  await page.evaluate((insets) => {
    const root = document.documentElement;
    root.style.setProperty("--composer-picker-safe-area-inset-top", `${insets.top}px`);
    root.style.setProperty("--composer-picker-safe-area-inset-right", `${insets.right}px`);
    root.style.setProperty("--composer-picker-safe-area-inset-bottom", `${insets.bottom}px`);
    root.style.setProperty("--composer-picker-safe-area-inset-left", `${insets.left}px`);
  }, safeArea);

  for (const viewport of compactViewports) {
    await test.step(viewport.name, async () => {
      await page.setViewportSize(viewport);
      await expectInjectedSafeArea(page);

      const runSummary = composerRunSummary(page);
      const runSetup = await openRunSetup(page);
      const useAssistant = runSetup.getByTestId("run-setup-use-assistant");
      await useAssistant.scrollIntoViewIfNeeded();
      await useAssistant.click();
      const assistantPicker = page.getByTestId("assistant-picker");
      const assistantClose = assistantPicker.getByRole("button", {
        name: "Close assistant picker"
      });
      await expect(assistantPicker.getByLabel("Search assistants")).toBeFocused();
      await expect(assistantPicker).toHaveAttribute("aria-modal", "true");
      await expect(page.getByTestId("assistant-picker-backdrop")).toBeVisible();
      await expectSafeAreaGeometry(page, assistantPicker, assistantClose, {
        bottomContent: assistantPicker.getByTestId("assistant-picker-actions"),
        surfaceClearsBottom: false
      });
      await assistantClose.click();
      await expect(assistantPicker).toHaveCount(0);
      await expect(runSummary).toBeFocused();

      const searchTrigger = page.locator("#composer-inline-search");
      await searchTrigger.click();
      const searchPicker = page.getByTestId("composer-inline-search-options");
      const searchClose = searchPicker.getByRole("button", { name: "Close Search picker" });
      await expect(searchPicker).not.toHaveAttribute("aria-modal");
      await expectSafeAreaGeometry(page, searchPicker, searchClose);
      await searchClose.click();
      await expect(searchPicker).toHaveCount(0);
      await expect(searchTrigger).toBeFocused();

      const knowledgeTrigger = page.locator("#composer-inline-knowledge");
      await knowledgeTrigger.click();
      const knowledgePicker = page.getByTestId("composer-inline-knowledge-options");
      const knowledgeClose = knowledgePicker.getByRole("button", {
        name: "Close Knowledge picker"
      });
      await expect(knowledgePicker).not.toHaveAttribute("aria-modal");
      await expectSafeAreaGeometry(page, knowledgePicker, knowledgeClose);
      await knowledgeClose.click();
      await expect(knowledgePicker).toHaveCount(0);
      await expect(knowledgeTrigger).toBeFocused();
      await expectNoHorizontalOverflow(page);
    });
  }
});
