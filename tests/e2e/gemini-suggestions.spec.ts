import { expect, test } from "@playwright/test";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { createGatedRunStreamFixture } from "./support/gatedRunStream";
import {
  expectCenterUnobscured,
  expectNoHorizontalOverflow,
  expectTouchSafe,
  expectWithinViewport
} from "./support/layoutAssertions";
import { signInWithLocalToken as signIn } from "./support/localAuth";

const chatId = "chat-gemini-suggestions";
const cssCanary = "AIQSA_PROVIDER_CSS_CANARY";
const runId = "run-gemini-suggestions";
const suggestionStream = createGatedRunStreamFixture({
  abortMessage: "Gemini suggestions stream aborted",
  key: "gemini-suggestions",
  notReadyError: "gemini_suggestions_stream_not_ready"
});

const groundingData = {
  citations: [],
  provider: "gemini",
  runSearch: { callCount: 1, queryCount: 1 }
} as const;

test("contains Gemini suggestions and rejects direct provider CSS before it can intercept the viewport", async ({
  page
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.addInitScript((activeChatId) => {
    window.localStorage.setItem("aiqsa.activeChatId", activeChatId);
  }, chatId);
  await suggestionStream.install(page, chatId);
  await installMatrixCatalogFixture(page, {
    chats: [{
      activeLeafMessageId: null,
      createdAt: "2026-08-05T08:00:00.000Z",
      defaultModelId: "gpt-5.5",
      defaultProvider: "openai",
      folderId: null,
      id: chatId,
      messageCount: 0,
      messages: [],
      pinned: false,
      title: "Suggestions containment",
      updatedAt: "2026-08-05T08:00:00.000Z",
      usageStats: null
    }],
    folders: []
  });

  await signIn(page);
  const composer = page.getByRole("textbox", { name: "Сообщение" });
  await composer.fill("Show grounded suggestions");
  await composer.press("Enter");
  await suggestionStream.waitForRequestCount(page, 1);
  await suggestionStream.emit(page, "run_start", {
    modelId: "gemini-test",
    provider: "gemini",
    runId,
    status: "streaming"
  });
  await suggestionStream.emit(page, "message_start", {
    assistantMessageId: "assistant-gemini-suggestions",
    userMessageId: "user-gemini-suggestions"
  });
  await suggestionStream.emit(page, "token", { delta: "Grounded answer" });

  await suggestionStream.emit(page, "grounding_display", {
    ...groundingData,
    suggestionsHtml: String.raw`<style>body::before{content:"${cssCanary}"}.cover{pos\69 tion:fixed;inset:0;z-index:2147483647;width:100vw;height:100vh}</style><a href="https://google.com/search?q=unsafe">Unsafe overlay</a>`
  });

  await page.getByRole("button", { name: /^Search,/u }).click();
  const region = page.getByRole("complementary", { name: "Google Search suggestions" });
  await expect(region.getByRole("alert")).toContainText("could not be displayed safely");
  const host = page.getByTestId("gemini-search-suggestions-host");
  await expect(host).toBeHidden();
  expect(await host.evaluate((element, canary) => ({
    childCount: element.shadowRoot?.childNodes.length ?? 0,
    hasProviderCssCanary: element.shadowRoot?.textContent?.includes(canary) ?? false
  }), cssCanary)).toEqual({ childCount: 0, hasProviderCssCanary: false });
  const workspaceButton = page.getByRole("button", { name: "Открыть панель" });
  await expectCenterUnobscured(workspaceButton);
  expect(await workspaceButton.evaluate((button) => {
    const bounds = button.getBoundingClientRect();
    const topmost = document.elementFromPoint(
      bounds.left + bounds.width / 2,
      bounds.top + bounds.height / 2
    );
    const suggestions = document.querySelector('[data-testid="gemini-search-suggestions"]');
    const suggestionHost = document.querySelector('[data-testid="gemini-search-suggestions-host"]');
    return {
      hostCapturedPoint: topmost === suggestionHost,
      suggestionsCapturedPoint: Boolean(suggestions?.contains(topmost))
    };
  })).toEqual({ hostCapturedPoint: false, suggestionsCapturedPoint: false });
  await expectNoHorizontalOverflow(page);

  const longLabel = `Search on Google ${"without-overflow-".repeat(24)}`;
  await suggestionStream.emit(page, "grounding_display", {
    ...groundingData,
    suggestionsHtml: [
      '<div class="provider-layout">',
      `<a class="provider-chip" href="https://www.google.com/search?q=aiqsa">${longLabel}`,
      '<svg width="9999" height="9999" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">',
      '<circle cx="10" cy="10" r="8" fill="#4285f4"></circle>',
      "</svg></a></div>"
    ].join("")
  });

  const link = region.getByRole("link", { name: longLabel });
  await link.scrollIntoViewIfNeeded();
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "https://www.google.com/search?q=aiqsa");
  await expectTouchSafe(link);
  await expectWithinViewport(page, region);
  await expectWithinViewport(page, link);
  await expectNoHorizontalOverflow(page);
  await expect.poll(() => link.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const x = bounds.left + bounds.width / 2;
    const y = bounds.top + bounds.height / 2;
    const root = element.getRootNode();
    if (!(root instanceof ShadowRoot)) return false;
    const documentTarget = document.elementFromPoint(x, y);
    const shadowTarget = root.elementFromPoint(x, y);
    return documentTarget === root.host &&
      (shadowTarget === element || element.contains(shadowTarget));
  })).toBe(true);
  await expectCenterUnobscured(workspaceButton);

  const projection = await host.evaluate((element) => {
    const shadow = element.shadowRoot;
    const anchor = shadow?.querySelector("a");
    const icon = shadow?.querySelector("svg");
    if (!shadow || !anchor || !icon) return null;
    const hostBounds = element.getBoundingClientRect();
    const regionBounds = element.closest("aside")?.getBoundingClientRect();
    const linkBounds = anchor.getBoundingClientRect();
    const iconBounds = icon.getBoundingClientRect();
    const hostStyle = getComputedStyle(element);
    const linkStyle = getComputedStyle(anchor);
    return {
      contain: hostStyle.contain,
      hostBounds: {
        bottom: hostBounds.bottom,
        left: hostBounds.left,
        right: hostBounds.right,
        top: hostBounds.top
      },
      iconHeight: iconBounds.height,
      iconWidth: iconBounds.width,
      linkBounds: {
        bottom: linkBounds.bottom,
        left: linkBounds.left,
        right: linkBounds.right,
        top: linkBounds.top
      },
      linkPosition: linkStyle.position,
      linkZIndex: linkStyle.zIndex,
      overflow: hostStyle.overflow,
      regionBounds: regionBounds ? {
        bottom: regionBounds.bottom,
        left: regionBounds.left,
        right: regionBounds.right,
        top: regionBounds.top
      } : null,
      styles: shadow.querySelectorAll('style[data-aiqsa-suggestions-style="true"]').length,
      wrappers: shadow.querySelectorAll('[data-aiqsa-suggestions-content="true"]').length
    };
  });

  expect(projection).not.toBeNull();
  expect(projection!.styles).toBe(1);
  expect(projection!.wrappers).toBe(1);
  // Chromium serializes `layout paint style` to the equivalent `content` keyword.
  expect(projection!.contain).toBe("content");
  expect(projection!.overflow).toBe("hidden");
  expect(projection!.linkPosition).toBe("static");
  expect(projection!.linkZIndex).toBe("auto");
  expect(projection!.regionBounds).not.toBeNull();
  expect(projection!.hostBounds.left).toBeGreaterThanOrEqual(projection!.regionBounds!.left - 1);
  expect(projection!.hostBounds.right).toBeLessThanOrEqual(projection!.regionBounds!.right + 1);
  expect(projection!.hostBounds.top).toBeGreaterThanOrEqual(projection!.regionBounds!.top - 1);
  expect(projection!.hostBounds.bottom).toBeLessThanOrEqual(projection!.regionBounds!.bottom + 1);
  expect(projection!.linkBounds.left).toBeGreaterThanOrEqual(projection!.hostBounds.left - 1);
  expect(projection!.linkBounds.right).toBeLessThanOrEqual(projection!.hostBounds.right + 1);
  expect(projection!.linkBounds.top).toBeGreaterThanOrEqual(projection!.hostBounds.top - 1);
  expect(projection!.linkBounds.bottom).toBeLessThanOrEqual(projection!.hostBounds.bottom + 1);
  expect(projection!.iconWidth).toBeLessThanOrEqual(19);
  expect(projection!.iconHeight).toBeLessThanOrEqual(19);

  await link.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(link).toBeFocused();
  const focusRing = await link.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      offset: style.outlineOffset,
      style: style.outlineStyle,
      width: style.outlineWidth
    };
  });
  expect(focusRing).toEqual({ offset: "-2px", style: "solid", width: "2px" });

  await suggestionStream.emit(page, "done", { runId, status: "complete" });
  await suggestionStream.close(page);
});
