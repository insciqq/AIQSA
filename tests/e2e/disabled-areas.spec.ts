import { randomUUID } from "node:crypto";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

/*
 * Projects are removed (operator decision 2026-10-22), but their addresses
 * are a contract: an old Project address opens the new chat without
 * revealing anything. Screenshots are viewport shots.
 */

test.setTimeout(120_000);
test.use({ trace: "off" });

const DESKTOP = { height: 900, width: 1440 } as const;
const PHONE_PORTRAIT = { height: 844, width: 390 } as const;

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const size = page.viewportSize();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath(`${name}-${size?.width ?? 0}x${size?.height ?? 0}.png`)
  });
}

/** An old Project chat address lands on the new chat with a working composer. */
async function expectOldProjectAddressOpensNewChat(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await signInWithLocalToken(page);
  await page.goto(`/p/project-${randomUUID()}/c/chat-${randomUUID()}`);
  await expect(page).toHaveURL((url) => url.pathname === "/");
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("textbox", { exact: true, name: "Message" })).toBeVisible();
  await expect(page.getByTestId("conversation-thread")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await shot(page, testInfo, name);
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("an old Project chat address opens the new chat", async ({ page }, testInfo) => {
    await expectOldProjectAddressOpensNewChat(page, testInfo, "old-project-address-desktop");
  });
});

test.describe("phone portrait", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: PHONE_PORTRAIT });

  test("an old Project chat address opens the new chat", async ({ page }, testInfo) => {
    await expectOldProjectAddressOpensNewChat(page, testInfo, "old-project-address-phone");
  });
});
