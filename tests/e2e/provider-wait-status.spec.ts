import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chooseSearchStrategy } from "./shell/composer";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";
import { disableMemoryRecall, selectFakeModel } from "./support/workspace";

const RETRYING = "The provider isn’t responding, trying again…";
const SLOW = "The provider is taking longer than usual…";

const viewports = [
  { height: 900, name: "desktop", width: 1440 },
  { height: 1180, name: "tablet", width: 820 },
  { height: 844, name: "phone", width: 390 },
  { height: 360, name: "phone-landscape", width: 780 }
] as const;

async function send(page: Page, trouble: string): Promise<string> {
  await signInWithLocalToken(page);
  await disableMemoryRecall(page);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({ timeout: 30_000 });
  await selectFakeModel(page);
  if (await page.getByRole("button", { name: /^Choose web search/u }).isVisible()) await chooseSearchStrategy(page, "Off");
  const id = randomUUID().slice(0, 8);
  const text = `[AIQSA_PROVIDER_WAIT_E2E:${id}:${trouble}] hello`;
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  return text;
}

for (const viewport of viewports) {
  test(`a retry names the provider and never leaves a blank answer, ${viewport.name}`, async ({ page }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ height: viewport.height, width: viewport.width });
    await send(page, "drop3");
    await expect(page.getByText(RETRYING)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^Worked for/u)).toHaveCount(0);
    await expect(page.getByText("Dropped")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`retrying-${viewport.name}.png`) });
    await info.attach(`retrying-${viewport.name}`, { path: info.outputPath(`retrying-${viewport.name}.png`), contentType: "image/png" });
    await expect(page.getByText(/Fake answer:/u)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(RETRYING)).toHaveCount(0);
  });
}

test("a return to the app during retries shows the retry and then the answer", async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ height: 844, width: 390 });
  await send(page, "drop5");
  await expect(page.getByText(RETRYING)).toBeVisible({ timeout: 30_000 });
  await page.waitForURL(/\/c\//u, { timeout: 30_000 }).catch(() => undefined);
  await page.reload();
  await expect(page.getByText(RETRYING)).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: info.outputPath("retrying-after-return.png") });
  await expect(page.getByText(/Fake answer:/u)).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(RETRYING)).toHaveCount(0);
});

test("a first request silent for 20 seconds is called slow until it answers", async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ height: 844, width: 390 });
  await send(page, "silent24000");
  await expect(page.getByText(SLOW)).toHaveCount(0);
  await expect(page.getByText(SLOW)).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: info.outputPath("slow-phone.png") });
  await expect(page.getByText(/Fake answer:/u)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(SLOW)).toHaveCount(0);
});

test("a run that ran out of attempts shows its failure instead of a status", async ({ page }, info) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ height: 844, width: 390 });
  await send(page, "drop9");
  await expect(page.getByText(RETRYING)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/kept failing/u)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(RETRYING)).toHaveCount(0);
  // The composer's Stop goes with the run: the failed answer leaves nothing to stop.
  await expect(page.getByRole("button", { name: /^Stop/u })).toHaveCount(0, { timeout: 15_000 });
  await page.screenshot({ path: info.outputPath("failed-phone.png") });
});
