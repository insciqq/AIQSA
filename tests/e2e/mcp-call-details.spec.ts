import { expect, test, type Page } from "@playwright/test";
import type { McpCallDetails, McpCallDisplaySection } from "../../lib/contracts/mcpCallDetails";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { signInWithLocalToken } from "./support/localAuth";
import { expectCenterUnobscured, expectNoHorizontalOverflow, expectTouchSafe } from "./support/layoutAssertions";

const timestamp = "2026-09-30T10:00:00.000Z";
const chatId = "mcp-details-chat";
const runId = "mcp-details-run";
const requestText = '{\n  "query": "Synthetic logs"\n}';
const responseText = '<script>window.MCP_MARKUP_EXECUTED = true</script>\n[link](https://example.com)';
const section = (text: string): McpCallDisplaySection => ({ text, byteSize: new TextEncoder().encode(text).length, truncated: false });
const details = (overrides: Partial<McpCallDetails> = {}): McpCallDetails => ({
  request: section(requestText), response: section(responseText), requestState: "available", responseState: "available",
  isError: false, unsupportedContentTypes: [], ...overrides
});

async function prepare(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => { (window as unknown as { mcpCopiedText: string }).mcpCopiedText = text; }
    } });
  });
  const calls = ["Logs", "Large result", "Expired result", "Pending result", "Retry result"].map((serverName, ordinal) => ({
    origin: "mcp", serverName, toolName: "search", round: 1, status: "complete", durationMs: 50,
    details: { roundIndex: 1, ordinal }
  }));
  await installMatrixCatalogFixture(page, { folders: [], chats: [{
    id: chatId, activeLeafMessageId: "mcp-details-answer", createdAt: timestamp, updatedAt: timestamp,
    title: "MCP call details", defaultModelId: "gpt-5.5", defaultProvider: "openai", folderId: null,
    pinned: false, messageCount: 2, messages: [
      { id: "mcp-details-question", role: "user", parentMessageId: null, status: "complete",
        content: "Check synthetic logs.", modelId: null, modelRunId: null, provider: null, errorMessage: null },
      { id: "mcp-details-answer", role: "assistant", parentMessageId: "mcp-details-question", status: "complete",
        content: "Synthetic check completed.", modelId: "gpt-5.5", modelRunId: runId, provider: "openai", errorMessage: null,
        artifactSummary: { citations: [], sources: [], reasoningText: [], workDurationMs: 1800 },
        toolActivity: { calls: [...calls,
          { origin: "mcp", serverName: "Other participant", toolName: "restricted", round: 1, status: "complete" },
          { origin: "skill", skillName: "Example Skill", toolName: "load_skill", round: 1, status: "complete" }] } }
    ]
  }] });
  await page.route("**/api/me/mcp", route => route.fulfill({ json: { servers: [] } }));
  await signInWithLocalToken(page, `/c/${chatId}`);
  const process = page.getByTestId("tool-activity-disclosure");
  await process.locator(":scope > summary").click();
  return process;
}

const viewports = [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "tablet-portrait", width: 820, height: 1180, touch: true },
  { name: "tablet-landscape", width: 1180, height: 820, touch: true },
  { name: "phone-portrait", width: 390, height: 844, touch: true },
  { name: "phone-landscape", width: 844, height: 390, touch: true }
] as const;

for (const viewport of viewports) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: viewport.touch });
    for (const theme of ["light", "dark"] as const) {
      test(`MCP details load lazily and stay contained in ${theme}`, async ({ page, context }, testInfo) => {
        await context.addCookies([{ name: "aiqsa.theme", value: theme, url: testInfo.project.use.baseURL! }]);
        let release: () => void = () => undefined;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const requests: number[] = [];
        await page.route(`**/api/model-runs/${runId}/mcp-calls/1/*`, async route => {
          const ordinal = Number(route.request().url().split("/").at(-1));
          requests.push(ordinal);
          if (ordinal === 0) await gate;
          const payload = ordinal === 1 ? details({ response: { ...section("long-unbroken-value-".repeat(400) + "\nline\n".repeat(120)), byteSize: 100_000, truncated: true }, unsupportedContentTypes: ["image", "audio"] })
            : ordinal === 2 ? details({ response: null, responseState: "unavailable" }) : details();
          await route.fulfill({ json: payload });
        });
        const process = await prepare(page);
        const rows = process.getByTestId("mcp-call-row");
        const buttons = rows.getByRole("button", { name: /MCP call details/u });
        await expect(buttons).toHaveCount(5);
        expect(requests).toEqual([]);
        await expect(process.getByText(/Other participant/u)).toBeVisible();
        await expect(process.getByText(/Example Skill/u)).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("mcp-details-closed.png") });
        const first = buttons.nth(0);
        await expect(first).toHaveAttribute("aria-expanded", "false");
        if (viewport.touch) await expectTouchSafe(first);
        await first.focus();
        await page.keyboard.press("Enter");
        await expect(rows.nth(0).getByRole("status")).toHaveText("Loading call details…");
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath("mcp-details-loading.png") });
        release();
        const loaded = rows.nth(0).getByTestId("mcp-call-details");
        await expect(loaded.getByLabel("Response text")).toHaveText(responseText);
        await expect(loaded.locator("script,a,img")).toHaveCount(0);
        expect(await page.evaluate(() => (window as unknown as { MCP_MARKUP_EXECUTED?: boolean }).MCP_MARKUP_EXECUTED)).toBeUndefined();
        for (const name of ["request", "response"] as const) {
          const copy = loaded.getByRole("button", { name: `Copy ${name}` });
          await copy.scrollIntoViewIfNeeded();
          if (viewport.touch) await expectTouchSafe(copy);
          await expectCenterUnobscured(copy);
          await copy.click();
          await expect.poll(() => page.evaluate(() => (window as unknown as { mcpCopiedText?: string }).mcpCopiedText))
            .toBe(name === "request" ? requestText : responseText);
        }
        await loaded.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath("mcp-details-loaded.png") });
        await first.click();
        await first.click();
        expect(requests).toEqual([0]);
        await first.click();

        await buttons.nth(1).click();
        const truncated = rows.nth(1).getByTestId("mcp-call-details");
        await expect(truncated).toContainText("Showing part of 100,000 bytes.");
        await expect(truncated).toContainText("Content not included: image, audio.");
        const pre = truncated.getByLabel("Response text");
        const geometry = await pre.evaluate(element => ({
          width: element.clientWidth, fullWidth: element.scrollWidth, height: element.clientHeight, fullHeight: element.scrollHeight
        }));
        expect(geometry.fullWidth).toBeGreaterThan(geometry.width);
        expect(geometry.fullHeight).toBeGreaterThan(geometry.height);
        await pre.focus();
        await page.keyboard.press("ArrowDown");
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath("mcp-details-truncated.png") });
        await buttons.nth(1).click();
        await buttons.nth(2).click();
        const unavailable = rows.nth(2).getByTestId("mcp-call-details");
        const unavailableMessage = unavailable.getByText("The content is no longer available.", { exact: true });
        await unavailableMessage.scrollIntoViewIfNeeded();
        await expect(unavailableMessage).toBeVisible();
        await expectCenterUnobscured(unavailableMessage);
        await expect(unavailable.getByRole("button", { name: "Copy response" })).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath("mcp-details-unavailable.png") });
        expect(requests).toEqual([0, 1, 2]);
      });
    }
  });
}

test("MCP pending details refresh explicitly and a failed read is retryable", async ({ page }, testInfo) => {
  const requests = new Map<number, number>();
  await page.route(`**/api/model-runs/${runId}/mcp-calls/1/*`, async route => {
    const ordinal = Number(route.request().url().split("/").at(-1));
    const count = (requests.get(ordinal) ?? 0) + 1;
    requests.set(ordinal, count);
    if (ordinal === 4 && count === 1) await route.fulfill({ status: 503, json: { error: "synthetic_unavailable" } });
    else await route.fulfill({ json: ordinal === 3 && count === 1 ? details({ response: null, responseState: "pending" }) : details() });
  });
  const process = await prepare(page);
  const rows = process.getByTestId("mcp-call-row");
  await rows.nth(3).getByRole("button", { name: /MCP call details/u }).click();
  await expect(rows.nth(3)).toContainText("The call has not finished.");
  await rows.nth(3).getByRole("button", { name: "Refresh call details" }).click();
  await expect(rows.nth(3).getByLabel("Response text")).toHaveText(responseText);
  await rows.nth(4).getByRole("button", { name: /MCP call details/u }).click();
  await expect(rows.nth(4).getByRole("alert")).toContainText("Call details could not be loaded.");
  await page.screenshot({ path: testInfo.outputPath("mcp-details-failed.png") });
  await rows.nth(4).getByRole("button", { name: "Retry call details" }).click();
  await expect(rows.nth(4).getByLabel("Response text")).toHaveText(responseText);
  expect([...requests]).toEqual([[3, 2], [4, 2]]);
});
