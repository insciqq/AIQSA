import { expect, test, type Page } from "@playwright/test";
import { decodeChatDetailResponse } from "../../lib/contracts/chats";
import { chooseSearchStrategy } from "./shell/composer";
import { signInWithLocalToken } from "./support/localAuth";
import { selectFakeModel, setWorkspaceEnabled } from "./support/workspace";
import { expectCenterUnobscured, expectNoHorizontalOverflow, expectTouchSafe } from "./support/layoutAssertions";

async function startAnswer(page: Page): Promise<string> {
  await signInWithLocalToken(page);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("complementary", { name: "Chat navigation" }).getByRole("button", { name: "New chat", exact: true }).click();
  if (await page.getByRole("button", { name: /^Workspace details\./u }).isVisible()) await setWorkspaceEnabled(page, false);
  await selectFakeModel(page);
  // Compile this route before a short fake generation on reusable dev servers.
  expect((await page.request.post("/api/model-runs/missing/followups", { data: {} })).status()).toBe(400);
  // Installations without configured Search omit its chip entirely.
  if (await page.getByRole("button", { name: /^Choose web search/u }).isVisible()) await chooseSearchStrategy(page, "Off");
  await page.getByRole("textbox", { name: "Message" }).fill("Explain this synthetic example. " + "synthetic ".repeat(1_800));
  const admission = page.waitForResponse(response => response.request().method() === "POST" &&
    /^\/api\/chats\/[^/]+\/messages$/u.test(new URL(response.url()).pathname));
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const response = await admission;
  const chatId = new URL(response.url()).pathname.split("/")[3]!;
  try {
    expect(response.ok()).toBe(true);
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute("placeholder", "Follow up…", { timeout: 30_000 });
    return chatId;
  } catch (error) {
    const detail = decodeChatDetailResponse(await (await page.request.get(`/api/chats/${chatId}`)).json());
    const runId = detail?.messages.find(message => message.role === "assistant")?.modelRunId;
    if (runId) await page.request.post(`/api/model-runs/${runId}/cancel`);
    await page.request.delete(`/api/chats/${chatId}`);
    throw error;
  }
}

test("Follow-up stays on the accepted run, survives another tab and reload, and keeps Stop reachable", async ({ page, context }, testInfo) => {
  test.setTimeout(180_000);
  const chatId = await startAnswer(page);
  let runId: string | undefined;
  try {
    const editor = page.getByRole("textbox", { name: "Message" });
    for (const [index, theme] of (["light", "dark"] as const).entries()) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await editor.fill(index === 0 ? "First clarification: use a table." : "Second clarification: add a short conclusion.");
      const acceptedPromise = page.waitForResponse(response => response.request().method() === "POST" && /\/api\/model-runs\/[^/]+\/followups$/u.test(response.url()));
      await editor.press("Enter");
      const accepted = await acceptedPromise;
      expect(accepted.status()).toBe(200);
      const acceptedRun = accepted.url().split("/").at(-2)!;
      expect(runId ?? acceptedRun).toBe(acceptedRun);
      runId = acceptedRun;
      await expect(editor).toHaveValue("");
      await expect(page.getByLabel("Follow-ups")).toContainText(index === 0 ? "First clarification" : "Second clarification");
      await expect(page.getByLabel("Follow-ups").getByText("Delivered to the task", { exact: true })).toHaveCount(index + 1, { timeout: 15_000 });
      await editor.fill("Unsent draft remains here");
      await context.addCookies([{ name: "aiqsa.theme", value: theme, url: "http://127.0.0.1:3000" }]);
      await page.evaluate(value => document.documentElement.setAttribute("data-theme", value), theme);
      for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 1024, height: 768 },
        { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 320, height: 568 }]) {
        await page.setViewportSize(viewport);
        const send = page.getByRole("button", { name: "Send follow-up", exact: true });
        const stop = page.getByRole("button", { name: "Stop answer", exact: true }).last();
        await expectTouchSafe(send);
        await expectTouchSafe(stop);
        await expectCenterUnobscured(send);
        await expectCenterUnobscured(stop);
        await expectNoHorizontalOverflow(page);
        await page.getByLabel("Follow-ups").getByText("Delivered to the task", { exact: true }).last().scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`followup-${theme}-${viewport.width}x${viewport.height}.png`) });
      }
    }
    // Emulate the reduced phone viewport while its software keyboard is open.
    await page.setViewportSize({ width: 390, height: 422 });
    await editor.fill("Long unsent clarification.\n".repeat(12));
    await editor.focus();
    await editor.press("Shift+Enter");
    await expect(editor).toBeFocused();
    await expectCenterUnobscured(page.getByRole("button", { name: "Send follow-up", exact: true }));
    await expectCenterUnobscured(page.getByRole("button", { name: "Stop answer", exact: true }).last());
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("followup-focused-phone-keyboard.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    const secondTab = await context.newPage();
    try {
      await secondTab.goto(`/?chat=${chatId}`);
      await expect(secondTab.getByLabel("Follow-ups")).toContainText("First clarification", { timeout: 30_000 });
      await expect(secondTab.getByLabel("Follow-ups")).toContainText("Second clarification");
    } finally { await secondTab.close(); }
    await page.request.post(`/api/model-runs/${runId}/cancel`);
    await page.reload();
    await expect(page.getByLabel("Follow-ups")).toContainText("Second clarification", { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
    const detail = decodeChatDetailResponse(await (await page.request.get(`/api/chats/${chatId}`)).json());
    expect(detail).not.toBeNull();
    expect(detail!.messages.filter(message => message.role === "user")).toHaveLength(1);
    expect(detail!.messages.find(message => message.role === "assistant")?.followups?.entries).toHaveLength(2);
  } finally {
    if (runId) await page.request.post(`/api/model-runs/${runId}/cancel`);
    await page.request.delete(`/api/chats/${chatId}`);
  }
});

test("Stop can win a pending Follow-up without clearing the draft or creating another task", async ({ page }) => {
  test.setTimeout(120_000);
  const chatId = await startAnswer(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let runId: string | undefined;
  await page.route("**/api/model-runs/*/followups", async route => {
    runId = route.request().url().split("/").at(-2)!;
    await held;
    await route.fulfill({ response: await route.fetch() });
  });
  try {
    const editor = page.getByRole("textbox", { name: "Message" });
    await editor.fill("Keep this draft after a late submission");
    await page.getByRole("button", { name: "Send follow-up", exact: true }).click();
    await expect.poll(() => Boolean(runId)).toBe(true);
    const stop = page.getByRole("button", { name: "Stop answer", exact: true }).last();
    await expect(stop).toBeEnabled();
    await stop.click();
    await expect(page.locator('.v2-run-terminal-strip[data-kind="cancelled"]')).toBeVisible();
    const rejected = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith(`/api/model-runs/${runId}/followups`));
    release();
    expect((await rejected).status()).toBe(409);
    await expect(page.getByText("This answer has finished accepting follow-ups. Your text is still here.", { exact: true })).toBeVisible();
    await expect(editor).toHaveValue("Keep this draft after a late submission");
    const detail = decodeChatDetailResponse(await (await page.request.get(`/api/chats/${chatId}`)).json());
    expect(detail).not.toBeNull();
    expect(detail!.messages).toHaveLength(2);
    expect(detail!.messages.find(message => message.role === "assistant")?.followups?.entries).toHaveLength(0);
  } finally {
    release();
    if (runId) await page.request.post(`/api/model-runs/${runId}/cancel`);
    await page.request.delete(`/api/chats/${chatId}`);
  }
});
