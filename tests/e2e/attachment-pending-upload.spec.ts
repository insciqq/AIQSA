import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

function picture(background: string) {
  return sharp({ create: { background, channels: 3, height: 120, width: 160 } }).png().toBuffer();
}

for (const viewport of [
  { height: 900, label: "desktop", theme: "light", width: 1440 },
  { height: 844, label: "phone", theme: "dark", width: 390 }
] as const) {
  test.describe(viewport.label, () => {
    test.use({ hasTouch: viewport.label === "phone", isMobile: viewport.label === "phone" });

    test(`a chosen image shows in the tray at once and the composer keeps taking files (${viewport.label})`,
      async ({ context, page }, testInfo) => {
        // The first upload on a cold dev server also compiles its routes.
        test.slow();
        await page.setViewportSize({ height: viewport.height, width: viewport.width });
        await context.addCookies([{ name: "aiqsa.theme", url: testInfo.project.use.baseURL!, value: viewport.theme }]);
        let release!: () => void;
        const slowNetwork = new Promise<void>((resolve) => { release = resolve; });
        const posted: string[] = [];
        await installMatrixCatalogFixture(page);
        // The real server stores and verifies each upload; only its arrival is held back.
        await page.route("**/api/uploads", async (route) => {
          if (route.request().method() !== "POST") {
            await route.fallback();
            return;
          }
          const name = /filename="([^"]+)"/u.exec(route.request().postDataBuffer()?.toString("latin1") ?? "")?.[1] ?? "";
          posted.push(name);
          await slowNetwork;
          await route.continue().catch(() => undefined);
        });
        await signInWithLocalToken(page);

        const composer = page.getByRole("textbox", { name: "Message" });
        const send = page.getByRole("button", { name: "Send message" });
        const input = page.getByLabel("Attach files");
        const tray = page.getByRole("region", { name: "Attachments" });
        const row = (name: string) => tray.getByRole("listitem").filter({ hasText: name });
        await composer.fill("What is in these pictures?");

        await input.setInputFiles({ buffer: await picture("#e9a742"), mimeType: "image/png", name: "first-picture.png" });
        await expect(row("first-picture.png")).toHaveAttribute("data-attachment-status", "uploading");
        await expect(row("first-picture.png")).toContainText("Uploading…");
        const firstThumb = row("first-picture.png").locator("img");
        await expect(firstThumb).toHaveAttribute("src", /^blob:/u);
        await expect.poll(() => firstThumb.evaluate((image: HTMLImageElement) => image.complete ? image.naturalWidth : 0))
          .toBe(160);
        await expect.poll(() => posted, { timeout: 60_000 }).toEqual(["first-picture.png"]);
        await expect(send).toBeDisabled();

        // Nothing is locked while it uploads: more files, and typing.
        await expect(input).toBeEnabled();
        await input.setInputFiles([
          { buffer: await picture("#477de5"), mimeType: "image/png", name: "second-picture.png" },
          { buffer: await picture("#3c9a5f"), mimeType: "image/png", name: "dropped-later.png" }
        ]);
        await expect(row("second-picture.png")).toHaveAttribute("data-attachment-status", "uploading");
        await expect(row("dropped-later.png")).toHaveAttribute("data-attachment-status", "uploading");
        await composer.fill("What is in these two pictures?");
        await expect(composer).toHaveValue("What is in these two pictures?");
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath(`pending-upload-${viewport.label}.png`) });

        // A row removed before its upload settles never becomes an attachment.
        await row("dropped-later.png").getByRole("button", { name: "Cancel upload of dropped-later.png" }).click();
        await expect(row("dropped-later.png")).toHaveCount(0);

        release();
        for (const name of ["first-picture.png", "second-picture.png"]) {
          await expect(row(name)).toHaveAttribute("data-attachment-status", "ready", { timeout: 30_000 });
          await expect(row(name).locator("img")).toHaveAttribute("src", /^blob:/u);
        }
        await expect(row("dropped-later.png")).toHaveCount(0);
        expect(posted).not.toContain("dropped-later.png");
        await expect(send).toBeEnabled();
        await expectNoHorizontalOverflow(page);
        await page.screenshot({ path: testInfo.outputPath(`ready-upload-${viewport.label}.png`) });

        await row("second-picture.png").getByRole("button", { name: "Remove second-picture.png" }).click();
        await expect(row("second-picture.png")).toHaveCount(0);
        await expect(row("first-picture.png")).toBeVisible();
      });
  });
}
