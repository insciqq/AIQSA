import { expect, test, type Page } from "@playwright/test";
import { chooseSearchStrategy } from "./shell/composer";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";
import { activeChatId, disableMemoryRecall, selectFakeModel, setWorkspaceEnabled } from "./support/workspace";

const viewports = [
  { width: 1440, height: 900 }, { width: 900, height: 1440 },
  { width: 820, height: 1180 }, { width: 1180, height: 820 },
  { width: 390, height: 844 }, { width: 844, height: 390 }
] as const;

for (const transport of ["suspended", "disconnected"] as const) {
  test(`an answer ${transport} in the background recovers without reloading or resending`, async ({ page, context }, testInfo) => {
    test.setTimeout(180_000);
    // Keep the server's accepted stream running while the browser receives no
    // further bytes. The two failures cover a hanging read and a closed stream.
    await page.addInitScript(({ transport }) => {
      const original = window.fetch.bind(window);
      let hidden = false;
      let stallStatus = false;
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" });
      Object.assign(window, { returnToChat() {
        hidden = false;
        document.dispatchEvent(new Event("visibilitychange"));
      } });
      window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (stallStatus && /\/api\/model-runs\/[^/]+$/u.test(url)) {
          stallStatus = false;
          // Simulate the first recovery request hanging after Android resumes.
          return new Promise<Response>(() => undefined);
        }
        const response = await original(input, init);
        if (init?.method !== "POST" || !/\/api\/chats\/[^/]+\/messages$/u.test(url) || !response.body ||
          !response.headers.get("content-type")?.includes("text/event-stream")) return response;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let received = "";
        let held = false;
        return new Response(new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (held) return new Promise<void>(() => undefined);
            const chunk = await reader.read();
            if (chunk.done) { controller.close(); return; }
            received += decoder.decode(chunk.value, { stream: true });
            controller.enqueue(chunk.value);
            if (received.includes("event: message_start") && received.includes("event: run_start")) {
              held = true;
              hidden = true;
              stallStatus = transport === "disconnected";
              document.dispatchEvent(new Event("visibilitychange"));
              if (transport === "disconnected") controller.close();
              void reader.cancel();
            }
          }
        }), { status: response.status, headers: response.headers });
      };
    }, { transport });
    await signInWithLocalToken(page);
    await startPlainFakeChat(page);
    let sends = 0;
    page.on("request", request => {
      if (request.method() === "POST" && /\/api\/chats\/[^/]+\/messages$/u.test(request.url())) sends++;
    });
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("Background recovery check");
    await page.getByRole("button", { name: "Send message" }).click();
    const chatId = await activeChatId(page);
    try {
      await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("hidden");
      await expect.poll(async () => {
        const response = await page.request.get(`/api/chats/${chatId}`);
        if (!response.ok()) return false;
        const body = await response.json();
        return body.chat.messages.some((message: { role: string; status: string }) => message.role === "assistant" && message.status === "complete");
      }, { timeout: 45_000 }).toBe(true);
      await composer.fill("Keep my unsent follow-up");
      if (transport === "disconnected") {
        await expect(page.getByTestId("run-connection-lost")).toBeVisible();
        // Manual Refresh must also recover when its status request hangs.
        await page.getByTestId("run-connection-lost").getByRole("button", { name: "Refresh" }).click();
        await expect(page.locator('article[data-role="assistant"]').last())
          .toContainText("Fake answer: Background recovery check", { timeout: 45_000 });
      }
      await page.evaluate(() => (window as unknown as { returnToChat(): void }).returnToChat());
      await expect(page.locator('article[data-role="assistant"]').last()).toContainText("Fake answer: Background recovery check", { timeout: 45_000 });
      await expect(page.getByTestId("run-connection-lost")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0);
      await expect(composer).toHaveValue("Keep my unsent follow-up");
      expect(sends).toBe(1);
      if (transport === "suspended") for (const theme of ["dark", "light"]) {
        await context.addCookies([{ name: "aiqsa.theme", value: theme, url: "http://127.0.0.1:3000" }]);
        await page.evaluate(value => document.documentElement.setAttribute("data-theme", value), theme);
        for (const viewport of viewports) {
          await page.setViewportSize(viewport);
          await expectNoHorizontalOverflow(page);
          await expectWithinViewport(page, composer);
          await page.screenshot({ path: testInfo.outputPath(`recovered-${theme}-${viewport.width}x${viewport.height}.png`) });
        }
      }
    } finally {
      await page.request.delete(`/api/chats/${chatId}`);
    }
  });
}

/** A plain fake-provider chat: no Workspace, no Search, deterministic Fake QSA. */
async function startPlainFakeChat(page: Page): Promise<void> {
  await disableMemoryRecall(page);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("complementary", { name: "Chat navigation" }).getByRole("button", { name: "New chat", exact: true }).click();
  if (await page.getByRole("button", { name: /^Workspace details\./u }).isVisible()) await setWorkspaceEnabled(page, false);
  await selectFakeModel(page);
  await expect(page.getByTestId("header-model-trigger")).toHaveText("Fake QSA");
  if (await page.getByRole("button", { name: /^Choose web search/u }).isVisible()) await chooseSearchStrategy(page, "Off");
}

/**
 * Presents one settled fake answer of `chatId` as a still-active run while
 * `held` is true: chat detail reads report its answer as streaming and run
 * outcome reads as streaming. This stands in for a run that outlives the
 * 20-minute polling horizon without a long question, which would exceed the
 * 8k fake model context. Released reads reach the real server again.
 */
async function holdRunAsActive(page: Page, chatId: string): Promise<{ release(): void }> {
  let held = true;
  await page.route((url) => url.pathname === `/api/chats/${chatId}`, async (route) => {
    if (!held || route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = await response.json() as { chat?: { messages?: Array<{ role?: string; status?: string }> } };
    const answer = [...(body.chat?.messages ?? [])].reverse().find((message) => message.role === "assistant");
    if (answer) answer.status = "streaming";
    await route.fulfill({ json: body, response });
  });
  await page.route("**/api/model-runs/*", async (route) => {
    const runId = new URL(route.request().url()).pathname.split("/").at(-1) ?? "";
    if (!held || route.request().method() !== "GET") return route.continue();
    await route.fulfill({ json: { run: { id: decodeURIComponent(runId), status: "streaming" }, version: 1 } });
  });
  return { release: () => { held = false; } };
}

/** Sends a short question, waits for its settled answer, then holds that run as active. */
async function sendHeldRun(page: Page, question: string): Promise<{ chatId: string; release(): void }> {
  await page.getByRole("textbox", { name: "Message" }).fill(question);
  await page.getByRole("button", { name: "Send message" }).click();
  const chatId = await activeChatId(page);
  await expect(page.locator('article[data-role="assistant"]').last())
    .toContainText(`Fake answer: ${question}`, { timeout: 45_000 });
  await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 45_000 });
  return { chatId, ...(await holdRunAsActive(page, chatId)) };
}

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
  const chatId = await activeChatId(page);
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

test("a reloaded long run stays stoppable past the polling horizon and releases the chat when it ends", async ({ page, context }, testInfo) => {
  test.setTimeout(240_000);
  await page.clock.install();
  await signInWithLocalToken(page);
  await startPlainFakeChat(page);
  const { chatId, release } = await sendHeldRun(page, "Background liveness");
  const outcomes = { release };
  try {
    // Reload restores the chat only by its address.
    await page.goto(`/c/${chatId}`);
    const stop = page.getByRole("button", { name: "Stop answer" }).first();
    await expect(stop).toBeVisible({ timeout: 30_000 });

    // Past the 20-minute horizon the gate and Stop remain, with a persistent
    // Check run affordance instead of a transient notice.
    await page.clock.fastForward("21:00");
    await page.clock.fastForward(30_000);
    const background = page.locator(".v2-live-background-run");
    await expect(background).toContainText("Run is still active in the background.");
    await expect(background.getByRole("button", { name: "Check run" })).toBeVisible();
    await expect(stop).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      await context.addCookies([{ name: "aiqsa.theme", value: theme, url: "http://127.0.0.1:3000" }]);
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        await background.scrollIntoViewIfNeeded();
        await expectWithinViewport(page, background);
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath(`background-run-${theme}-${viewport.width}x${viewport.height}.png`) });
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    // A temporary offline read is not terminal; regaining connectivity checks
    // at once (the owner remembers an online event that lands during its
    // in-flight check) and the finished run frees the chat. The background
    // cadence, driven by the installed clock, is the bounded fallback when the
    // emulated network change delivers no online event; the annotation records
    // which path released the gate. Neither path is a manual action.
    await context.setOffline(true);
    await page.clock.fastForward(60_000);
    await expect(background).toBeVisible();
    await expect(stop).toBeVisible();
    outcomes.release();
    await context.setOffline(false);
    const stopControls = page.getByRole("button", { name: "Stop answer" });
    let releasedBy = "online";
    await expect(stopControls).toHaveCount(0, { timeout: 15_000 }).catch(async () => {
      releasedBy = "background cadence";
      await page.clock.runFor(61_000);
      await expect(stopControls).toHaveCount(0, { timeout: 30_000 });
    });
    testInfo.annotations.push({ type: "background-run-released-by", description: releasedBy });
    await expect(background).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
    await expect(page.locator(`[data-navigation-chat-id="${chatId}"] [aria-label="Answer in progress"]`)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("background-run-released.png") });
  } finally {
    outcomes.release();
    await context.setOffline(false);
    await page.request.delete(`/api/chats/${chatId}`);
  }
});

test("a background run is checked on focus and after returning to its chat through history", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await page.clock.install();
  await signInWithLocalToken(page);
  await startPlainFakeChat(page);
  const { chatId, release } = await sendHeldRun(page, "Focus liveness");
  const outcomes = { release };
  let otherChatId: string | null = null;
  try {
    await page.goto(`/c/${chatId}`);
    await expect(page.getByRole("button", { name: "Stop answer" }).first()).toBeVisible({ timeout: 30_000 });

    // Leaving the chat ends its polling; back restores the owner and its Stop.
    await startPlainFakeChat(page);
    await page.getByRole("textbox", { name: "Message" }).fill("Short neighbour question");
    await page.getByRole("button", { name: "Send message" }).click();
    otherChatId = await activeChatId(page);
    expect(otherChatId).not.toBe(chatId);
    await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 45_000 });
    await page.goBack();
    await expect.poll(() => page.evaluate(() => window.location.pathname)).toBe(`/c/${chatId}`);
    await expect(page.getByRole("button", { name: "Stop answer" }).first()).toBeVisible({ timeout: 30_000 });
    await page.goForward();
    await expect.poll(() => page.evaluate(() => window.location.pathname)).toBe(`/c/${otherChatId}`);
    await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0);
    await page.goBack();
    await expect(page.getByRole("button", { name: "Stop answer" }).first()).toBeVisible({ timeout: 30_000 });

    await page.clock.fastForward("21:00");
    await page.clock.fastForward(30_000);
    await expect(page.locator(".v2-live-background-run")).toBeVisible();
    outcomes.release();
    await page.evaluate(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 60_000 });
    await expect(page.locator(".v2-live-background-run")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("background-run-focus-released.png") });
  } finally {
    outcomes.release();
    await page.request.delete(`/api/chats/${chatId}`);
    if (otherChatId) await page.request.delete(`/api/chats/${otherChatId}`);
  }
});

test("a second send right after an answer completes leaves the chat free when it finishes", async ({ page }) => {
  test.setTimeout(180_000);
  await signInWithLocalToken(page);
  await startPlainFakeChat(page);
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("First short question");
  await page.getByRole("button", { name: "Send message" }).click();
  const chatId = await activeChatId(page);
  try {
    await expect(page.locator('article[data-role="assistant"]').last()).toContainText("Fake answer: First short question", { timeout: 45_000 });
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
    await composer.fill("Second short question");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator('article[data-role="assistant"]').last()).toContainText("Fake answer: Second short question", { timeout: 45_000 });
    await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 45_000 });
    await expect(page.locator(`[data-navigation-chat-id="${chatId}"] [aria-label="Answer in progress"]`)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  } finally {
    await page.request.delete(`/api/chats/${chatId}`);
  }
});
