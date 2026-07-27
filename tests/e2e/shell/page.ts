import { expect, type Locator, type Page } from "@playwright/test";

export async function runAccountMenuAction(
  page: Page,
  name: "Command palette" | "Prompt library" | "Settings"
): Promise<Locator> {
  const desktopTrigger = page.getByTestId("left-chat-pane").getByRole("button", { name: /Account menu/ });
  if (await desktopTrigger.isVisible()) {
    await desktopTrigger.click();
    await page.getByRole("menu", { name: "Account" }).getByRole("menuitem", { name }).click();
    return desktopTrigger;
  }

  const restoreTarget = page.getByRole("button", { name: "Open workspace" });
  const workspace = page.getByTestId("workspace-pane-mobile");
  if (!(await workspace.isVisible())) {
    await restoreTarget.click();
  }

  const trigger = workspace.getByRole("button", { name: /Account menu/ });
  await trigger.click();
  await workspace.getByRole("menu", { name: "Account" }).getByRole("menuitem", { name }).click();
  return restoreTarget;
}

export async function expectComposerBeforeDetails(page: Page): Promise<void> {
  const composerBox = await page.getByTestId("composer-control-bar").boundingBox();
  const detailsBox = await page.getByTestId("details-pane").boundingBox();

  expect(composerBox).toBeTruthy();
  expect(detailsBox).toBeTruthy();
  expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(detailsBox!.x + 1);
}
