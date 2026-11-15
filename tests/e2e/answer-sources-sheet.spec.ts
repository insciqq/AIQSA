import { expect, test } from "@playwright/test";
import type { ThreadSearchSource } from "../../lib/contracts/chats";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

// A settled answer whose run searched 1600 pages on 40 sites: the Sources chip
// opens a sheet that leads with what the answer cites and groups the rest by
// site, so the first screen is never 1600 rows.
const timestamp = "2026-11-16T10:00:00.000Z";
const longTitle = "An exceptionally long synthetic page title that keeps going well past one line to prove that titles wrap inside the sheet";
const longPath = `article-${"segment".repeat(30)}`;

function siteName(site: number): string {
  return `site-${String(site).padStart(2, "0")}.example`;
}

/** Ten sites of 80 pages, ten of 40, twenty of 20; the first page of sites 0 and 3 has a long title and address. */
function searchedPages(): ThreadSearchSource[] {
  const sizes = Array.from({ length: 40 }, (_, site) => site < 10 ? 80 : site < 20 ? 40 : 20);
  return sizes.flatMap((size, site) => Array.from({ length: size }, (_, page) => {
    const long = page === 0 && (site === 0 || site === 3);
    return {
      rank: page + 1,
      snippet: `A synthetic snippet for page ${page} on site ${site}, long enough to need a second line on a phone.`,
      title: long ? longTitle : `Result ${page} on site ${site}`,
      url: `https://www.${siteName(site)}/${long ? longPath : `page-${page}`}`
    };
  }));
}

/** Fourteen Markdown links to listed pages, on every other site. */
const citingText = [
  "The synthetic findings, with their sources:",
  ...Array.from({ length: 14 }, (_, index) => {
    const site = index * 2;
    const path = site === 0 && index === 0 ? longPath : `page-${index}`;
    return `- Point ${index} ([source](https://${siteName(site)}/${path})).`;
  })
].join("\n");

const cases = [
  { name: "uncited", chipCount: 1600, content: "The search ran long and the answer stopped before citing anything." },
  { name: "cited", chipCount: 14, content: citingText }
] as const;

for (const viewport of [
  { width: 1440, height: 900, theme: "dark", touch: false },
  { width: 768, height: 1024, theme: "light", touch: true },
  { width: 390, height: 844, theme: "dark", touch: true },
  { width: 844, height: 390, theme: "light", touch: true }
] as const) {
  const size = `${viewport.width}x${viewport.height}`;
  test.describe(size, () => {
    test.use({ hasTouch: viewport.touch, isMobile: viewport.touch });

    for (const scenario of cases) {
      test(`the ${scenario.name} answer's sources open in a bounded sheet at ${size}`, async ({ context, page }, testInfo) => {
        const chatId = `answer-sources-${scenario.name}-chat`;
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await context.addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: testInfo.project.use.baseURL! }]);
        await installMatrixCatalogFixture(page, { folders: [], chats: [{
          id: chatId, title: "Answer sources", activeLeafMessageId: "sources-answer",
          createdAt: timestamp, updatedAt: timestamp, defaultProvider: "openai", defaultModelId: "gpt-5.5",
          folderId: null, pinned: false, messageCount: 1,
          messages: [{ id: "sources-answer", role: "assistant", status: "complete", parentMessageId: null,
            createdAt: timestamp, content: scenario.content, errorMessage: null, citationMessageId: null,
            modelId: "gpt-5.5", modelRunId: `${chatId}-run`, provider: "openai",
            toolActivity: { calls: [{ durationMs: 2_000, origin: "web_search", round: 1, status: "complete", toolName: "web_search" }] },
            artifactSummary: { citations: [], reasoningText: [], sources: searchedPages() } }]
        }] });
        await signInWithLocalToken(page, `/c/${chatId}`);

        const chip = page.getByTestId("answer-sources-toggle");
        await expect(chip).toBeVisible();
        await expect(chip).toContainText(`· ${scenario.chipCount}`);
        await chip.scrollIntoViewIfNeeded();
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath(`${size}-${scenario.name}-chip.png`) });

        // Opening the sheet never grows the page behind it.
        const scroller = page.locator(".v2-conversation-scroll");
        const pageHeight = await scroller.evaluate((node) => node.scrollHeight);
        await chip.click();
        const sheet = page.getByRole("dialog", { name: "Sources" });
        await expect(sheet).toBeVisible();
        await expectWithinViewport(page, sheet);
        expect(await scroller.evaluate((node) => node.scrollHeight)).toBe(pageHeight);
        await expectNoHorizontalOverflow(page);

        const sites = sheet.getByTestId("answer-source-site");
        if (scenario.name === "cited") {
          const cited = sheet.getByTestId("answer-sources-cited");
          await expect(cited.getByRole("heading")).toContainText("Cited in the answer · 14");
          await expect(cited.getByRole("listitem")).toHaveCount(14);
          await expect(cited.getByRole("listitem").first()).toContainText(longTitle);
          const searched = sheet.getByRole("button", { name: "Also searched · 1586" });
          await expect(searched).toHaveAttribute("aria-expanded", "false");
          await expect(sites).toHaveCount(0);
          await page.screenshot({ path: testInfo.outputPath(`${size}-${scenario.name}-open.png`) });
          await searched.click();
        } else {
          await expect(sheet.getByRole("button", { name: "Searched · 1600" })).toHaveAttribute("aria-expanded", "true");
          await expect(sheet.getByRole("link")).toHaveCount(0);
          await page.screenshot({ path: testInfo.outputPath(`${size}-${scenario.name}-open.png`) });
        }
        await expect(sites).toHaveCount(40);

        // A site opens to its links, fifty at a time; the long address wraps.
        const site = sheet.getByRole("button", { name: "site-03.example · 80" });
        await site.click();
        await expect(site).toHaveAttribute("aria-expanded", "true");
        const siteLinks = sites.filter({ hasText: "site-03.example" }).getByRole("link");
        await expect(siteLinks).toHaveCount(50);
        await expect(siteLinks.first()).toHaveText(longTitle);
        await expectNoHorizontalOverflow(page);
        await site.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`${size}-${scenario.name}-site-open.png`) });
        await sites.filter({ hasText: "site-03.example" }).getByRole("button", { name: "Show more · 30 left" }).click();
        await expect(siteLinks).toHaveCount(80);

        // The filter matches title, site or address and lists the matches.
        const filter = sheet.getByRole("searchbox", { name: "Filter sources" });
        await filter.fill("site 7");
        await expect(sheet.getByRole("status")).toHaveText("80 matching");
        await expect(sheet.getByTestId("answer-source-matches").getByRole("link")).toHaveCount(50);
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath(`${size}-${scenario.name}-filtered.png`) });

        // Escape closes the sheet and hands focus back to the chip.
        await filter.focus();
        await page.keyboard.press("Escape");
        await expect(sheet).toHaveCount(0);
        await expect(chip).toBeFocused();
        await expectNoHorizontalOverflow(page);
      });
    }
  });
}
