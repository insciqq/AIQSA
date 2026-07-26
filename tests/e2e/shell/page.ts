import { expect, type Locator, type Page } from "@playwright/test";

export async function runAccountMenuAction(
  page: Page,
  name: "Command palette" | "Settings"
): Promise<Locator> {
  const trigger = page.getByRole("button", { name: "Account menu" });
  await trigger.click();
  await page.getByRole("menu", { name: "Account" }).getByRole("menuitem", { name }).click();
  return trigger;
}

export async function expectComposerBeforeDetails(page: Page): Promise<void> {
  const composerBox = await page.getByTestId("composer-control-bar").boundingBox();
  const detailsBox = await page.getByTestId("details-pane").boundingBox();

  expect(composerBox).toBeTruthy();
  expect(detailsBox).toBeTruthy();
  expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(detailsBox!.x + 1);
}
