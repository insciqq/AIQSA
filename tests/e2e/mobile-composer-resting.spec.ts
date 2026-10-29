import { expect, test, type Page } from "@playwright/test";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { expectThreadTextInViewport, scrollMessage } from "./shell/thread";
import { expectCenterUnobscured, expectNoHorizontalOverflow, expectTouchSafe } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

// The phone composer and header after chatgpt.com (operator decision 2026-10-29): the composer rests as one line
// until engaged, the header islands float over the thread with no band, and "+" shares the "⋯" island.
const chatId = "mobile-composer-resting-chat";
const tailMarker = "Resting composer tail marker";
const chat = {
  activeLeafMessageId: "resting-answer", createdAt: "2026-10-29T10:00:00.000Z", defaultModelId: "gpt-5.5",
  defaultProvider: "openai", folderId: null, id: chatId, messageCount: 2,
  messages: [
    scrollMessage("resting-question", "user", "A question for the resting composer", null),
    scrollMessage("resting-answer", "assistant", ["An answer that fills a few lines of the phone thread.", tailMarker].join("\n\n"),
      "resting-question")
  ],
  pinned: false, title: "Resting composer", updatedAt: "2026-10-29T10:00:01.000Z", usageStats: null
};

const viewports = [
  { height: 844, name: "phone-390", width: 390 },
  { height: 780, name: "phone-360", width: 360 }
] as const;

function surface(page: Page) {
  return page.getByTestId("composer-v2-surface");
}

for (const theme of ["light", "dark"] as const) {
  for (const viewport of viewports) {
    test.describe(`resting composer · ${viewport.name} · ${theme}`, () => {
      test.use({ hasTouch: true, isMobile: true });

      test(`rests as one line, opens on a tap and folds after a tap on the thread (${viewport.name}, ${theme})`,
        async ({ page }, testInfo) => {
          await page.emulateMedia({ colorScheme: theme });
          await page.setViewportSize({ height: viewport.height, width: viewport.width });
          await installMatrixCatalogFixture(page, { chats: [chat], folders: [] });
          await signInWithLocalToken(page, `/c/${chatId}`);
          await expectThreadTextInViewport(page, tailMarker);

          const composer = surface(page);
          const field = page.getByRole("textbox", { name: "Message" });
          const tools = composer.getByRole("button", { name: "Change MCP mode" });
          await expect(composer).toHaveAttribute("data-resting", "true");
          await expect(tools).toBeHidden();
          await expect(composer.getByRole("button", { name: "Send message" })).toBeHidden();
          await expectTouchSafe(composer.getByRole("button", { name: "Add" }));
          const resting = (await composer.boundingBox())!;
          expect(resting.height).toBeLessThanOrEqual(58);
          // An island set in from the edges.
          expect(resting.x).toBeGreaterThanOrEqual(27);
          expect(viewport.width - resting.x - resting.width).toBeGreaterThanOrEqual(27);

          // No band under the header islands; "+" and "⋯" sit in one island.
          expect(await page.evaluate(() => getComputedStyle(document.querySelector(".v2-live-workspace")!, "::before").content))
            .toBe("none");
          const newChat = (await page.getByRole("link", { name: "New chat" }).last().boundingBox())!;
          const more = (await page.getByRole("button", { name: "Chat actions" }).boundingBox())!;
          expect(Math.abs(newChat.y - more.y)).toBeLessThanOrEqual(1);
          expect(more.x - (newChat.x + newChat.width)).toBeGreaterThanOrEqual(0);
          expect(more.x - (newChat.x + newChat.width)).toBeLessThanOrEqual(4);
          await expectCenterUnobscured(page.getByRole("link", { name: "New chat" }).last());
          await expectNoHorizontalOverflow(page);
          await page.screenshot({ path: testInfo.outputPath(`resting-${viewport.name}-${theme}.png`) });

          // A tap opens it: the text takes the full width and the tools stay reachable under the finger.
          await field.tap();
          await expect(composer).not.toHaveAttribute("data-resting");
          await expect(tools).toBeVisible();
          await expectTouchSafe(tools);
          const engaged = (await composer.boundingBox())!;
          const fieldBox = (await field.boundingBox())!;
          expect(fieldBox.width).toBeGreaterThanOrEqual(engaged.width - 24);
          await field.fill("A draft keeps the composer open");
          const send = composer.getByRole("button", { name: "Send message" });
          await expect(send).toBeEnabled();
          await expectTouchSafe(send);
          await expectCenterUnobscured(send);
          await page.getByTestId("conversation-thread").getByText(tailMarker).tap();
          await expect(composer).not.toHaveAttribute("data-resting");
          await expectNoHorizontalOverflow(page);
          await page.screenshot({ path: testInfo.outputPath(`draft-${viewport.name}-${theme}.png`) });

          // Emptied and left, it rests again; the chip menu opened from the open row keeps it open.
          await field.tap();
          await field.fill("");
          await tools.tap();
          await expect(page.getByRole("menu", { name: /MCP/u })).toBeVisible();
          await expect(composer).not.toHaveAttribute("data-resting");
          await page.keyboard.press("Escape");
          await page.getByTestId("conversation-thread").getByText(tailMarker).tap();
          await expect(composer).toHaveAttribute("data-resting", "true");
        });
    });
  }
}
