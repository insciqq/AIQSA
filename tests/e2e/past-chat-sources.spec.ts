import { expect, test } from "@playwright/test";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { signInWithLocalToken } from "./support/localAuth";
import { memoryConsumerSettingsFixture } from "../support/memoryFixtures";
import type { MemoryAnswerSource } from "../../lib/contracts/memoryClient";

const timestamp = "2026-09-06T10:00:00.000Z";
const history = (group: number, excerpt = 0): MemoryAnswerSource => ({
  actions: ["CORRECT", "FORGET", "NOT_RELEVANT", "OPEN_SOURCE"],
  chatGroup: `chat-${group}`,
  date: timestamp,
  memoryRef: `opaque-history-${group}-${excerpt}`,
  origin: group < 3 ? "Earlier deployment discussion" : `Earlier discussion ${group}`,
  sourceAvailable: true,
  sourceType: "PAST_CHAT",
  text: `User: Earlier question ${group}.${excerpt}. ` + "A detailed discussion of the selected environment and its log index. ".repeat(12)
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`past chats stay compact and preserve source actions at ${viewport.width}px`, async ({ page, context }, testInfo) => {
    await page.setViewportSize(viewport);
    const theme = viewport.width === 390 ? "light" : "dark";
    await page.emulateMedia({ colorScheme: theme });
    await context.addCookies([{ name: "aiqsa.theme", value: theme, url: "http://127.0.0.1:3000" }]);
    const sources: MemoryAnswerSource[] = [history(1), history(1, 1), history(2), history(3), history(4), {
      actions: ["CORRECT", "FORGET", "NOT_RELEVANT"], date: timestamp,
      memoryRef: "opaque-fact", sourceAvailable: true, sourceType: "SAVED_MEMORY",
      text: "Prefer concise answers."
    }];
    const messages = ["user", "assistant"].map((role) => ({
      id: `${role}-recall`, role, parentMessageId: role === "user" ? null : "user-recall",
      createdAt: timestamp, errorMessage: null, modelId: role === "assistant" ? "gpt-5.5" : null,
      modelRunId: role === "assistant" ? "run-recall" : null,
      provider: role === "assistant" ? "openai" : null, status: "complete",
      content: { blocks: [{ type: "text", text: role === "user" ? "Check the current logs." : "The requested result." }] },
      artifactSummary: role === "assistant" ? {
        citations: [], sources: [], reasoningText: [], memorySources: sources, workDurationMs: 1800
      } : null,
      toolActivity: role === "assistant" ? {
        calls: [{ round: 1, status: "complete", serverName: "Logs", toolName: "search", durationMs: 50 }]
      } : null
    }));
    const chat = {
      id: "recall-ui-chat", activeLeafMessageId: "assistant-recall", createdAt: timestamp,
      updatedAt: timestamp, title: "Recall presentation", defaultModelId: "gpt-5.5",
      defaultProvider: "openai", folderId: null, pinned: false, messageCount: messages.length,
      messages, usageStats: null
    };
    await page.addInitScript(() => window.localStorage.setItem("aiqsa.activeChatId", "recall-ui-chat"));
    await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
    await page.route("**/api/me/memory/settings", (route) => route.fulfill({ json: memoryConsumerSettingsFixture() }));
    await page.route("**/api/me/memory/source-actions", (route) => route.fulfill({ json: { status: "COMMITTED" } }));
    const openedRefs: string[] = [];
    await context.route("**/api/me/memory/source-actions/open?**", async (route) => {
      openedRefs.push(new URL(route.request().url()).searchParams.get("memoryRef")!);
      await route.fulfill({ contentType: "text/html", body: "<p>Authenticated source destination</p>" });
    });
    await signInWithLocalToken(page);
    const process = page.getByTestId("tool-activity-disclosure");
    await expect(process.locator(":scope > summary")).toContainText("Past chats · 4 · Memory · 1");
    await process.locator(":scope > summary").click();
    await expect(process.getByRole("heading", { name: "Steps" })).toBeVisible();
    const chats = page.getByTestId("past-chats-disclosure");
    const memories = page.getByTestId("memories-disclosure");
    await expect(chats).not.toHaveAttribute("open");
    await expect(memories).not.toHaveAttribute("open");
    await chats.locator(":scope > summary").click();
    const groups = chats.locator('[data-testid="past-chat-source"]:visible');
    await expect(groups).toHaveCount(3);
    await expect(chats.getByRole("link", { name: "Earlier deployment discussion" })).toHaveCount(2);
    for (const preview of await chats.locator(".v2-past-chat-preview:visible").all()) {
      const geometry = await preview.evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        line: Number.parseFloat(getComputedStyle(element).lineHeight),
        fullHeight: element.scrollHeight
      }));
      expect(geometry.height).toBeLessThanOrEqual(geometry.line * 2 + 1);
      expect(geometry.fullHeight).toBeGreaterThan(geometry.height);
    }
    await expect(chats.locator(".v2-past-chat-excerpts[open]")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("sources-compact.png") });
    await chats.getByRole("button", { name: "Show all 4" }).click();
    await expect(groups).toHaveCount(4);
    await chats.getByRole("button", { name: "Show less" }).click();
    await expect(groups).toHaveCount(3);
    const first = groups.first();
    const popupPromise = page.waitForEvent("popup");
    await first.getByRole("link", { name: "Earlier deployment discussion" }).click();
    const popup = await popupPromise;
    await expect(popup.getByText("Authenticated source destination")).toBeVisible();
    expect(openedRefs).toEqual(["opaque-history-1-0"]);
    await popup.close();
    await first.locator(".v2-past-chat-excerpts > summary").click();
    const excerpts = first.getByTestId("memory-source-card");
    await expect(excerpts).toHaveCount(2);
    const excerpt = excerpts.first();
    const previewBox = await excerpt.locator(".v2-memory-source-text").boundingBox();
    await excerpt.getByRole("button", { name: "Details", exact: true }).click();
    expect((await excerpt.locator(".v2-memory-source-text").boundingBox())!.height).toBeGreaterThan(previewBox!.height);
    await excerpt.getByRole("button", { name: "Show less", exact: true }).click();
    const actions = excerpt.getByRole("button", { name: "Memory actions" });
    await actions.click();
    await expect(page.getByRole("menuitem", { name: "Correct" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(actions).toBeFocused();
    await actions.click();
    await page.getByRole("menuitem", { name: "Forget" }).click();
    await expect(excerpt.getByRole("status")).toContainText("forgotten");
    await expect(first.locator(".v2-past-chat-preview")).toHaveCount(0);
    await expect(first.getByRole("link", { name: "Earlier deployment discussion" })).toHaveCount(0);
    await memories.locator(":scope > summary").click();
    await expect(memories.getByText("Prefer concise answers.")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const row of await groups.all()) {
      const box = await row.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
    }
    await page.screenshot({ path: testInfo.outputPath("sources.png") });
  });
}
