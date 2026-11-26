import { expect, test } from "@playwright/test";
import { matrixCatalog } from "./shell/catalog";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { runAccountMenuAction, showSettingsSection } from "./shell/page";
import { authenticateWithLocalToken } from "./support/localAuth";
import { expectNoHorizontalOverflow, expectTouchSafe, expectWithinViewport } from "./support/layoutAssertions";

const sizes = [{ width: 1440, height: 900 }, { width: 768, height: 1024 },
  { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 844, height: 390 }];

test.use({ locale: "ru-RU" });

for (const theme of ["dark", "light"] as const) {
  test(`Files, Skills and catalog defaults remain usable across devices · ${theme}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(15_000);
    await authenticateWithLocalToken(page.request);
    await page.context().addCookies([{ name: "aiqsa.theme", value: theme, url: "http://127.0.0.1:3000" }]);
    const catalog = structuredClone(matrixCatalog);
    // Search is one switch for every chat with no choice of source (search-v2, 2026-11-26).
    catalog.defaults.searchEnabled = true;
    await installMatrixCatalogFixture(page, undefined, { catalog });
    await page.route("**/api/uploads", route => route.fulfill({ json: {
      nextCursor: null,
      files: [
        { id: "saved-file", fileName: "prompt_template.md", byteSize: 1200, createdAt: "2026-09-09T10:00:00Z",
          savedAt: "2026-09-12T10:00:00Z", chatId: null, chatTitle: null, messageId: null, status: "ready", previewKind: "text" },
        ...Array.from({ length: 6 }, (_, index) => ({
          id: `chat-file-${index}`, fileName: index < 2 ? "report.md" : `quarterly_research_supporting_document_${index}.pdf`,
          byteSize: 214000, createdAt: `2026-09-21T14:0${5 - index}:00Z`, savedAt: null,
          chatId: "brief-chat", chatTitle: "Quarterly product brief with supporting research and decisions",
          messageId: `message-${index}`, previewKind: index < 2 ? "text" : null, status: index === 5 ? "processing" : "ready"
        }))
      ]
    } }));
    await page.route("**/api/me/skills**", route => route.fulfill({ json: {
      nextCursor: null, publishableWorkspaces: [], viewer: { canPublishInstallation: false },
      skills: Array.from({ length: 25 }, (_, index) => ({
        id: `skill-${index}`, name: `Careful editor ${index + 1}`, archived: false, owned: true,
        description: "Review claims and preserve source evidence before returning the answer.",
        instructionCharacterCount: 42, instructionApproxTokens: 11, ownerDisplayName: "You",
        scope: { kind: "owner" }, updatedAt: "2026-09-21T10:00:00Z", version: 1
      }))
    } }));
    await page.goto("/");
    await expect(page.getByTestId("app-shell")).toBeVisible();

    for (const size of sizes) {
      await page.setViewportSize(size);
      await runAccountMenuAction(page, "Files");
      const library = page.getByTestId("library-v2");
      const files = page.getByTestId("library-files-panel");
      await expect(files.getByRole("button", { name: "All 7", exact: true })).toBeVisible();
      await expect(files.getByText(/Files are private and visible only to you\./)).toHaveCount(1);
      const fileHeading = await files.getByRole("heading", { name: "Files", exact: true }).boundingBox();
      await expect(files.getByText(/Saved Sep 12, 2026/)).toBeVisible();
      await files.getByRole("searchbox", { name: "Search files" }).fill("QUARTERLY");
      await expect(files.getByRole("heading", { name: "report.md" })).toHaveCount(2);
      await expect(files.getByRole("heading", { name: "prompt_template.md" })).toHaveCount(0);
      await files.getByRole("searchbox", { name: "Search files" }).fill("");
      await expectNoHorizontalOverflow(page);
      if (size.width < 768) {
        await expectTouchSafe(files.getByRole("button", { name: "Use in chat" }).first());
        await expectTouchSafe(files.getByRole("link", { name: "Download prompt_template.md" }));
      }
      await page.screenshot({ path: testInfo.outputPath(`files-${size.width}x${size.height}-${theme}.png`) });
      // Below 1024px the next section starts from the list of sections.
      await showSettingsSection(page, "Skills");
      const skills = page.getByTestId("skill-library-section");
      await expect(skills.getByRole("button", { name: "Open Careful editor 1", exact: true })).toBeVisible();
      if (size.height > 600) {
        const skillsHeading = await skills.getByRole("heading", { name: "Skills", exact: true }).boundingBox();
        expect(Math.abs(skillsHeading!.x - fileHeading!.x)).toBeLessThanOrEqual(1);
        await testInfo.attach(`heading-geometry-${size.width}-${theme}`, {
          body: JSON.stringify({ files: fileHeading, skills: skillsHeading }), contentType: "application/json"
        });
      }
      await expectNoHorizontalOverflow(page);
      if (size.width >= 1024 && size.height > 500) {
        const scroller = skills.locator(".v2-skill-list-pane");
        await skills.getByRole("button", { name: "Open Careful editor 1", exact: true }).hover();
        await page.mouse.wheel(0, 600);
        await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
      }
      await page.screenshot({ path: testInfo.outputPath(`skills-${size.width}x${size.height}-${theme}.png`) });
      await library.getByRole("button", { name: "Back to chat" }).click();
    }

    for (const size of [sizes[0], sizes[3]]) {
      await page.setViewportSize(size);
      await runAccountMenuAction(page, "Chat defaults");
      const settings = page.getByTestId("library-v2");
      await settings.getByRole("button", { name: "Default model", exact: true }).click();
      const models = page.getByRole("menu", { name: "Default model" });
      await expect(models.locator(".v2-menu-item-sub").first()).toHaveText(catalog.providers.find(provider => provider.id === catalog.models[0]!.provider)!.name);
      await expectWithinViewport(page, models);
      await page.screenshot({ path: testInfo.outputPath(`model-default-${size.width}-${theme}.png`) });
      await page.keyboard.press("Escape");
      const searchRow = settings.getByTestId("settings-default-search");
      const searchSwitch = searchRow.getByRole("switch", { name: "Web search default" });
      await expect(searchSwitch).toHaveAttribute("aria-checked", "true");
      await expect(searchRow.getByRole("checkbox")).toHaveCount(0);
      await expect(searchRow.getByRole("combobox")).toHaveCount(0);
      await searchRow.scrollIntoViewIfNeeded();
      await expectWithinViewport(page, searchRow);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`search-${size.width}-${theme}.png`) });
      // Keyboard only: Space asks before turning Search off, and Keep search on leaves it on.
      await searchSwitch.focus();
      await page.keyboard.press("Space");
      const confirmation = page.getByRole("dialog", { name: "Turn off web search" });
      await expect(confirmation).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`search-off-confirmation-${size.width}-${theme}.png`) });
      await confirmation.getByRole("button", { name: "Keep search on" }).click();
      await expect(confirmation).toHaveCount(0);
      await expect(searchSwitch).toHaveAttribute("aria-checked", "true");
      await settings.getByRole("button", { name: "Back to chat" }).click();
    }
  });
}
