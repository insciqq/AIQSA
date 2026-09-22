import { expect, test } from "@playwright/test";
import { chooseSearchStrategy } from "./shell/composer";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";
import { selectFakeModel, setWorkspaceEnabled } from "./support/workspace";

test("a disconnected accepted answer can be stopped through the real cancellation endpoint", async ({ page, context }, testInfo) => {
  test.setTimeout(180_000);
  // Cut only the browser's response after durable acknowledgement. The server
  // keeps its accepted fake-provider run, exactly as after a lost connection.
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (init?.method !== "POST" || !/\/api\/chats\/[^/]+\/messages$/u.test(url) ||
        !response.ok || !response.headers.get("content-type")?.includes("text/event-stream") || !response.body) return response;
      const reader = response.body.getReader();
      let received = "";
      const decoder = new TextDecoder();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const chunk = await reader.read();
          if (chunk.done) { controller.close(); return; }
          received += decoder.decode(chunk.value, { stream: true });
          controller.enqueue(chunk.value);
          if (received.includes("event: message_start") && received.includes("event: run_start")) {
            controller.close();
            void reader.cancel();
          }
        }
      });
      return new Response(body, { headers: response.headers, status: response.status });
    };
  });
  await signInWithLocalToken(page);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("complementary", { name: "Chat navigation" }).getByRole("button", { name: "New chat", exact: true }).click();
  if (await page.getByRole("button", { name: /^Workspace details\./u }).isVisible()) await setWorkspaceEnabled(page, false);
  await selectFakeModel(page);
  await expect(page.getByTestId("header-model-trigger")).toHaveText("Fake QSA");
  if (await page.getByRole("button", { name: /^Choose web search/u }).isVisible()) await chooseSearchStrategy(page, "Off");
  await page.getByRole("textbox", { name: "Message" }).fill("Keep this answer running. " + "synthetic ".repeat(1000));
  await page.getByRole("button", { name: "Send message" }).click();
  const strip = page.getByTestId("run-connection-lost");
  await expect(strip).toBeVisible();
  const chatId = await page.evaluate(() => localStorage.getItem("aiqsa.activeChatId"));
  expect(chatId).toBeTruthy();

  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let cancelCount = 0;
  let serverCancelled = false;
  await page.route("**/api/model-runs/*/cancel", async (route) => {
    cancelCount += 1;
    const response = await route.fetch();
    const result = await response.json();
    serverCancelled = response.status() === 200 && result.run?.status === "cancelled";
    await held;
    await route.fulfill({ response });
  });
  try {
    await strip.getByRole("button", { name: "Stop answer" }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => serverCancelled).toBe(true);
    await expect(strip.getByRole("button", { name: "Stopping…" })).toBeDisabled();
    await expect(strip.getByRole("button", { name: "Refresh" })).toBeDisabled();
    for (const theme of ["light", "dark"] as const) {
      await context.addCookies([{ name: "aiqsa.theme", value: theme, url: "http://127.0.0.1:3000" }]);
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      for (const viewport of [
        { width: 1440, height: 900 }, { width: 900, height: 1440 },
        { width: 820, height: 1180 }, { width: 1180, height: 820 },
        { width: 390, height: 844 }, { width: 844, height: 390 }
      ]) {
        await page.setViewportSize(viewport);
        await strip.scrollIntoViewIfNeeded();
        await expectWithinViewport(page, strip);
        await expect.poll(async () => {
          const control = await strip.boundingBox();
          const dock = await page.locator("[data-thread-composer-dock]").boundingBox();
          return control && dock ? control.y + control.height <= dock.y : false;
        }).toBe(true);
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath(`stopping-${theme}-${viewport.width}x${viewport.height}.png`) });
      }
    }
    expect(cancelCount).toBe(1);
    release();
    await expect(strip).toBeHidden();
    await expect(page.locator('.v2-run-terminal-strip[data-kind="cancelled"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator(`[data-navigation-chat-id="${chatId}"] [aria-label="Answer in progress"]`)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("cancelled-desktop.png") });
  } finally {
    release();
    if (chatId) await page.request.delete(`/api/chats/${chatId}`);
  }
});
