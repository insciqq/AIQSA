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

export async function expectConversationControlsBeforeThread(page: Page): Promise<void> {
  const actionRail = page.getByTestId("top-rail");
  const conversationControls = page.getByTestId("conversation-controls");
  const thread = page.getByTestId("thread");

  await expect(actionRail).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(actionRail).toHaveCSS("border-bottom-width", "0px");
  await expect
    .poll(async () => {
      const [actionRailBox, conversationControlsBox, threadBox] = await Promise.all([
        actionRail.boundingBox(),
        conversationControls.boundingBox(),
        thread.boundingBox()
      ]);
      if (!actionRailBox || !conversationControlsBox || !threadBox) {
        return false;
      }
      const threadTop = threadBox.y + 1;
      return (
        actionRailBox.y + actionRailBox.height <= threadTop &&
        conversationControlsBox.y + conversationControlsBox.height <= threadTop
      );
    })
    .toBe(true);
}
