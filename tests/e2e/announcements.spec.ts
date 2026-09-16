import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { hashPassword } from "../../lib/server/auth/password";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";
import { providerTemplateIds } from "../../lib/domain/providerTemplates";
import { loginWithPassword } from "./support/workspace";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";

const prisma = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.afterAll(() => prisma.$disconnect());
const viewports = [
  { name: "desktop-light", width: 1440, height: 900, theme: "light" },
  { name: "desktop-dark", width: 1280, height: 720, theme: "dark" },
  { name: "tablet-portrait", width: 768, height: 1024, theme: "light" },
  { name: "tablet-landscape", width: 1024, height: 768, theme: "dark" },
  { name: "phone-portrait", width: 390, height: 844, theme: "dark" },
  { name: "phone-landscape", width: 844, height: 390, theme: "light" },
  { name: "phone-small", width: 320, height: 568, theme: "light" }
] as const;

async function account(role: "admin" | "user") {
  const id = randomUUID(), email = `announcements-${id}@example.com`, password = `Synthetic-${randomUUID()}`;
  await prisma.user.create({ data: { id, email, role, status: "active", displayName: "Announcements reader", authIdentities: { create: {
    normalizedEmail: email, provider: "password", providerAccountId: email, passwordHash: await hashPassword(password), emailVerifiedAt: new Date()
  } } } });
  await prisma.$transaction(tx => provisionActiveUser(tx, { userId: id }));
  await prisma.accessGrant.create({ data: { userId: id, providerModelId: providerTemplateIds.fakeModel } });
  return { id, email, password };
}

async function openInbox(page: Page) {
  const rail = page.getByRole("navigation", { name: "Workspace" });
  if (!(await rail.isVisible())) {
    const drawer = page.getByRole("complementary", { name: "Chat navigation" });
    if (!(await drawer.isVisible())) await page.getByRole("button", { name: "Open sidebar" }).click();
  }
  const bell = page.getByRole("button", { name: /^Announcements(?:, \d+ unread)?$/u });
  await bell.focus(); await bell.press("Enter");
  const inbox = page.getByRole("dialog", { name: "Announcements", exact: true });
  await expect(inbox).toBeVisible();
  await expect(inbox.getByRole("button", { name: "Close announcements" })).toBeFocused();
  return { inbox, bell };
}

async function confirm(page: Page, dialog: string, label: string) {
  const confirmation = page.getByRole("dialog", { name: dialog, exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: `Confirm ${label.toLowerCase()}`, exact: true }).click();
  await expect(confirmation).toHaveCount(0);
}

for (const viewport of viewports) {
  test(`publish, read and withdraw announcements: ${viewport.name}`, async ({ browser }, testInfo) => {
    test.setTimeout(120_000);
    const admin = await account("admin"), reader = await account("user");
    const contextOptions = { baseURL: testInfo.project.use.baseURL, viewport: { width: viewport.width, height: viewport.height }, hasTouch: viewport.name.startsWith("phone") };
    const adminContext = await browser.newContext(contextOptions), readerContext = await browser.newContext(contextOptions);
    const adminPage = await adminContext.newPage(), readerPage = await readerContext.newPage();
    const title = `Workspace news: clearer instructions and quieter notifications (${viewport.name})`;
    const body = "## A clearer workspace\n\nRead the built-in instructions in **Settings** and keep your own presets.\n\n- Review the platform rules\n- Keep reading without interruptions\n\n[Release notes](https://example.com/releases)\n\n![inert image](https://example.com/image.png)\n<script>void 0</script>\n[unsafe](javascript:alert(1))";
    let pageErrors = 0;
    for (const page of [adminPage, readerPage]) page.on("pageerror", () => pageErrors++);
    try {
      for (const context of [adminContext, readerContext]) {
        await context.addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: contextOptions.baseURL! }]);
      }
      await loginWithPassword(readerPage, reader);
      await expect(readerPage).toHaveTitle("New chat · AIQSA");
      const originalTitle = await readerPage.title();
      const originalIcon = await readerPage.locator('link[rel="icon"]').first().getAttribute("href");
      let opened = await openInbox(readerPage);
      await expect(opened.inbox.getByText("No announcements yet.")).toBeVisible();
      await readerPage.keyboard.press("Tab");
      await expect(opened.inbox.getByRole("button", { name: "Refresh announcements" })).toBeFocused();
      await readerPage.keyboard.press("Shift+Tab");
      await expect(opened.inbox.getByRole("button", { name: "Close announcements" })).toBeFocused();
      await readerPage.keyboard.press("Escape");
      await expect(opened.inbox).toHaveCount(0);
      await expect(opened.bell).toBeFocused();
      if (viewport.width < 768) await readerPage.keyboard.press("Escape");

      await adminPage.goto(`/login?next=${encodeURIComponent("/admin?section=announcements")}`);
      await adminPage.getByLabel("Email").fill(admin.email);
      await adminPage.getByLabel("Password", { exact: true }).fill(admin.password);
      await adminPage.getByRole("button", { name: "Sign in" }).click();
      await expect(adminPage.getByTestId("admin-topbar-title")).toHaveText("Announcements");
      await adminPage.getByRole("button", { name: "New announcement" }).click();
      let editor = adminPage.getByRole("dialog", { name: "New announcement", exact: true });
      await editor.getByLabel("Title", { exact: true }).fill(title);
      await editor.getByRole("textbox", { name: "Message", exact: true }).fill(body);
      await adminPage.keyboard.press("Escape");
      const discard = adminPage.getByRole("dialog", { name: "Unsaved announcement" });
      await expect(discard).toBeVisible();
      await discard.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(editor.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(body);
      await editor.getByRole("button", { name: "Preview", exact: true }).click();
      const preview = editor.getByRole("article", { name: "Announcement preview" });
      await expect(preview.getByRole("link", { name: "Release notes" })).toHaveAttribute("rel", /noreferrer/u);
      await expect(preview.locator("img, script, a[href^='javascript:']")).toHaveCount(0);
      await expectNoHorizontalOverflow(adminPage);
      await adminPage.screenshot({ path: testInfo.outputPath(`${viewport.name}-admin-preview.png`) });
      if (viewport.height <= 600) {
        await preview.getByText("[unsafe](javascript:alert(1))", { exact: false }).scrollIntoViewIfNeeded();
        await adminPage.screenshot({ path: testInfo.outputPath(`${viewport.name}-admin-preview-end.png`) });
      }
      await editor.getByRole("button", { name: "Write", exact: true }).click();
      await editor.getByRole("button", { name: "Save draft", exact: true }).click();
      editor = adminPage.getByRole("dialog", { name: "Edit announcement", exact: true });
      await expect(editor).toBeVisible();
      const saved = await prisma.announcement.findFirstOrThrow({ where: { title } });
      expect((await readerPage.request.get(`/api/announcements/${saved.id}`)).status()).toBe(404);
      await editor.getByRole("button", { name: "Publish to everyone" }).click();
      await confirm(adminPage, "Publish announcement", "Publish to everyone");
      await expect(editor.getByRole("button", { name: "Unpublish", exact: true })).toBeEnabled();
      const published = await prisma.announcement.findUniqueOrThrow({ where: { id: saved.id } });
      expect(published.publishedAt).not.toBeNull();

      await readerPage.reload();
      await expect(readerPage.getByTestId("app-shell")).toBeVisible();
      await expect(readerPage.getByRole("dialog", { name: "Announcements", exact: true })).toHaveCount(0);
      await expect(readerPage).toHaveTitle(originalTitle);
      expect(await readerPage.locator('link[rel="icon"]').first().getAttribute("href")).toBe(originalIcon);
      if (viewport.width < 768) {
        const trigger = readerPage.getByRole("button", { name: "Open sidebar" });
        await expect(trigger).toHaveAttribute("data-announcements-unread", "true");
        await expect(trigger).toHaveAccessibleDescription("Unread announcements");
        const dot = await trigger.evaluate(button => {
          const style = getComputedStyle(button, "::before");
          return { display: style.display, visibility: style.visibility, opacity: style.opacity,
            width: parseFloat(style.width), height: parseFloat(style.height) };
        });
        expect(dot.display).not.toBe("none");
        expect(dot.visibility).toBe("visible");
        expect(dot.opacity).toBe("1");
        expect(dot.width).toBeGreaterThan(0);
        expect(dot.width).toBe(dot.height);
        await readerPage.screenshot({ path: testInfo.outputPath(`${viewport.name}-unread-trigger.png`) });
      }
      opened = await openInbox(readerPage);
      await expect(opened.inbox.getByText("1 unread", { exact: true })).toBeVisible();
      const row = opened.inbox.getByRole("button", { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")) });
      await expect(row).toContainText("(unread)");
      await expectNoHorizontalOverflow(readerPage);
      await readerPage.screenshot({ path: testInfo.outputPath(`${viewport.name}-inbox.png`) });
      await row.click();
      await expect(opened.inbox.getByRole("heading", { name: title, exact: true })).toBeFocused();
      await expect(opened.inbox.getByRole("link", { name: "Release notes" })).toHaveAttribute("rel", /noreferrer/u);
      await expect(opened.inbox.locator("img, script, a[href^='javascript:']")).toHaveCount(0);
      await expect.poll(() => prisma.announcementRead.count({ where: { userId: reader.id, announcementId: saved.id } })).toBe(1);
      await expectNoHorizontalOverflow(readerPage);
      await readerPage.screenshot({ path: testInfo.outputPath(`${viewport.name}-detail.png`) });
      if (viewport.height <= 600) {
        await opened.inbox.getByText("[unsafe](javascript:alert(1))", { exact: false }).scrollIntoViewIfNeeded();
        await readerPage.screenshot({ path: testInfo.outputPath(`${viewport.name}-detail-end.png`) });
      }
      await expect(opened.inbox.locator("[aria-busy]")).toHaveAttribute("aria-busy", "false");
      await opened.inbox.getByRole("button", { name: "Back to announcements" }).click();
      await expect(row).toBeFocused();
      await expect(row).not.toContainText("(unread)");
      await readerPage.keyboard.press("Escape");
      await expect(opened.inbox).toHaveCount(0);
      await expect(opened.bell).toBeFocused();
      await expect(opened.bell).toHaveAccessibleName("Announcements");
      if (viewport.width < 768) {
        await expect(readerPage.getByRole("complementary", { name: "Chat navigation" })).toBeVisible();
        await readerPage.keyboard.press("Escape");
        await expect(readerPage.getByRole("button", { name: "Open sidebar" })).toBeFocused();
        await expect(readerPage.getByRole("button", { name: "Open sidebar" })).not.toHaveAttribute("data-announcements-unread");
      }

      await editor.getByRole("textbox", { name: "Message", exact: true }).fill(`${body}\n\nUpdated for clarity.`);
      await editor.getByRole("button", { name: "Save changes" }).click();
      await expect(editor.getByRole("status")).toContainText("Edits do not notify");
      expect((await prisma.announcement.findUniqueOrThrow({ where: { id: saved.id } })).publishedAt).toEqual(published.publishedAt);
      await readerPage.reload();
      opened = await openInbox(readerPage);
      await expect(opened.inbox.getByText("You're all caught up")).toBeVisible();
      await editor.getByRole("button", { name: "Unpublish", exact: true }).click();
      await confirm(adminPage, "Unpublish announcement", "Unpublish");
      await expect(editor.getByRole("button", { name: "Publish to everyone" })).toBeEnabled();
      await opened.inbox.getByRole("button", { name: "Refresh announcements" }).click();
      await expect(opened.inbox.getByText("No announcements yet.")).toBeVisible();
      expect((await readerPage.request.get(`/api/announcements/${saved.id}`)).status()).toBe(404);
      expect(await prisma.announcementRead.count({ where: { announcementId: saved.id } })).toBe(1);
      await editor.getByRole("button", { name: "Delete announcement" }).click();
      await confirm(adminPage, "Delete announcement", "Delete announcement");
      await expect(editor).toHaveCount(0);
      await expect(adminPage.getByRole("button", { name: "New announcement" })).toBeFocused();
      expect(await prisma.announcementRead.count({ where: { announcementId: saved.id } })).toBe(0);
      expect(pageErrors).toBe(0);
    } finally {
      await adminContext.close(); await readerContext.close();
      await prisma.announcement.deleteMany({ where: { title } });
      await prisma.user.deleteMany({ where: { id: { in: [admin.id, reader.id] } } });
    }
  });
}
