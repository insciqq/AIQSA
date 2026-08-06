import { expect, type Locator, type Page } from "@playwright/test";

export async function runAccountMenuAction(
  page: Page,
  name: "Command palette" | "Library" | "Settings"
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

export async function expectConversationControlsClearOfThread(page: Page): Promise<void> {
  const actionRail = page.getByTestId("top-rail");
  const conversationControls = page.getByTestId("conversation-controls");
  const thread = page.getByTestId("thread");
  const desktop = await page.evaluate(() => window.matchMedia("(min-width: 1024px)").matches);

  await expect(actionRail).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(actionRail).toHaveCSS("border-bottom-width", "0px");
  await expect(actionRail).toHaveCSS("position", "absolute");
  await expect(page.getByTestId("top-rail-reading-veil")).toBeVisible();
  await expect
    .poll(async () => {
      const [actionRailBox, conversationControlsBox, threadBox, contentBoxes] = await Promise.all([
        actionRail.boundingBox(),
        conversationControls.boundingBox(),
        thread.boundingBox(),
        thread.locator('[data-thread-message-content="true"]').evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top };
          })
        )
      ]);
      if (!actionRailBox || !conversationControlsBox || !threadBox) {
        return false;
      }
      const controls = {
        bottom: conversationControlsBox.y + conversationControlsBox.height,
        left: conversationControlsBox.x,
        right: conversationControlsBox.x + conversationControlsBox.width,
        top: conversationControlsBox.y
      };
      const intersectsContent = contentBoxes.some((content) =>
        controls.left < content.right &&
        controls.right > content.left &&
        controls.top < content.bottom &&
        controls.bottom > content.top
      );
      const overlaysThread =
        threadBox.y <= actionRailBox.y + 1 &&
        actionRailBox.y + actionRailBox.height > threadBox.y;
      return overlaysThread && (!desktop || !intersectsContent);
    })
    .toBe(true);
}
