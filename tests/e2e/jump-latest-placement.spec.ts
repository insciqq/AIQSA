import { expect, test, type Page } from "@playwright/test";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { expectThreadTextInViewport, scrollMessage } from "./shell/thread";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

const chatId = "jump-latest-placement-chat";
const tailMarker = "Jump placement tail marker";
const longAnswer = [
  ...Array.from({ length: 60 }, (_, index) =>
    `Answer paragraph ${index + 1} runs across the whole reading column so that every line reaches both edges ` +
    "of the thread, and the control has no side gutter to rest in while the reader is scrolled up."),
  tailMarker
].join("\n\n");
const chat = {
  activeLeafMessageId: "jump-answer", createdAt: "2026-10-25T10:00:00.000Z", defaultModelId: "gpt-5.5",
  defaultProvider: "openai", folderId: null, id: chatId, messageCount: 2,
  messages: [
    scrollMessage("jump-question", "user", "A question with a long answer", null),
    scrollMessage("jump-answer", "assistant", longAnswer, "jump-question")
  ],
  pinned: false, title: "Jump placement", updatedAt: "2026-10-25T10:00:01.000Z", usageStats: null
};

const viewports = [
  { height: 844, name: "phone-portrait-390", touch: true, mobile: true, width: 390 },
  { height: 390, name: "phone-landscape-844", touch: true, mobile: true, width: 844 },
  { height: 1024, name: "boundary-767", touch: true, mobile: false, width: 767 },
  { height: 1024, name: "boundary-768", touch: true, mobile: false, width: 768 },
  { height: 1180, name: "tablet-820", touch: true, mobile: false, width: 820 },
  { height: 900, name: "desktop-1440", touch: false, mobile: false, width: 1440 }
] as const;

/**
 * The control against the answer's text lines (Range client rects) clipped to
 * the readable band of the thread: above the dock's fade, whose top includes
 * the phone's upward extension while the control is shown.
 */
function jumpGeometry(page: Page) {
  return page.evaluate(() => {
    const button = document.querySelector<HTMLElement>('button[aria-label="Jump to latest message"]')!;
    const dock = document.querySelector<HTMLElement>("[data-thread-composer-dock]")!;
    const thread = document.querySelector<HTMLElement>('[data-testid="conversation-scroll"]')!;
    const dockBox = dock.getBoundingClientRect();
    const fade = getComputedStyle(dock, "::before");
    const fadeTop = fade.content !== "none" && fade.position === "absolute"
      ? dockBox.top + parseFloat(fade.top) : dockBox.top;
    const dockContentTop = dockBox.top + parseFloat(getComputedStyle(dock).paddingTop);
    const threadBox = thread.getBoundingClientRect();
    const readingTop = threadBox.top;
    const readingBottom = Math.min(threadBox.bottom, fadeTop);
    const jump = button.getBoundingClientRect();
    const lines: Array<{ bottom: number; left: number; right: number; top: number }> = [];
    for (const answer of document.querySelectorAll('article[data-role="assistant"]')) {
      const walker = document.createTreeWalker(answer, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          const top = Math.max(rect.top, readingTop);
          const bottom = Math.min(rect.bottom, readingBottom);
          if (bottom - top > 0.5 && rect.width > 0.5) lines.push({ bottom, left: rect.left, right: rect.right, top });
        }
      }
    }
    const overlapsLane = (line: (typeof lines)[number]) =>
      Math.min(line.right, jump.right) - Math.max(line.left, jump.left) > 0.5;
    const covered = lines.filter((line) =>
      overlapsLane(line) && Math.min(line.bottom, jump.bottom) - Math.max(line.top, jump.top) > 0.5);
    const above = lines.filter((line) => line.bottom >= readingBottom - 80);
    return {
      covered: covered.length,
      dockContentTop,
      fadeTop,
      jump: { bottom: jump.bottom, height: jump.height, left: jump.left, right: jump.right, top: jump.top, width: jump.width },
      linesAbove: above.length,
      linesAboveInLane: above.filter(overlapsLane).length
    };
  });
}

for (const theme of ["light", "dark"] as const) {
  for (const viewport of viewports) {
    test.describe(`jump to latest · ${viewport.name} · ${theme}`, () => {
      test.use({ hasTouch: viewport.touch, isMobile: viewport.mobile });

      test(`covers no answer line while scrolled up and still reaches the end (${viewport.name}, ${theme})`,
        async ({ page }, testInfo) => {
          await page.emulateMedia({ colorScheme: theme });
          await page.setViewportSize({ height: viewport.height, width: viewport.width });
          await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
          await signInWithLocalToken(page, `/c/${chatId}`);
          await expectThreadTextInViewport(page, tailMarker);

          const thread = page.getByTestId("conversation-scroll");
          await thread.evaluate((element) => {
            element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) / 2);
            element.dispatchEvent(new Event("scroll"));
          });
          const jump = page.getByRole("button", { name: "Jump to latest message" });
          await expect(jump).toBeVisible();
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

          const geometry = await jumpGeometry(page);
          // The thread really is over the answer next to the control.
          expect(geometry.linesAbove).toBeGreaterThan(0);
          if (viewport.width < 768) expect(geometry.linesAboveInLane).toBeGreaterThan(0);
          expect(geometry.covered).toBe(0);
          // It rests in the dock's band: below the readable thread, above the composer.
          expect(geometry.jump.top).toBeGreaterThanOrEqual(geometry.fadeTop - 0.5);
          expect(geometry.jump.bottom).toBeLessThanOrEqual(geometry.dockContentTop + 0.5);
          expect(geometry.jump.left).toBeGreaterThanOrEqual(0);
          expect(geometry.jump.right).toBeLessThanOrEqual(viewport.width);
          if (viewport.touch) {
            expect(geometry.jump.width).toBeGreaterThanOrEqual(44);
            expect(geometry.jump.height).toBeGreaterThanOrEqual(44);
          }
          await expectNoHorizontalOverflow(page);
          await page.screenshot({ path: testInfo.outputPath(`jump-latest-${viewport.name}-${theme}-scrolled.png`) });

          await jump.click();
          await expect(jump).toHaveCount(0);
          await expectThreadTextInViewport(page, tailMarker);
          await page.screenshot({ path: testInfo.outputPath(`jump-latest-${viewport.name}-${theme}-end.png`) });
        });
    });
  }
}
