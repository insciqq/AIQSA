import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import type { PublicShareSnapshot } from "../../lib/domain/shareSnapshot";
import { hashShareToken } from "../../lib/server/shares/tokens";
import { LOCAL_OPERATOR_EMAIL } from "../../prisma/local-seed-auth";

test.describe.configure({ mode: "serial" });

const prisma = new PrismaClient();

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        body: document.body.scrollWidth <= document.body.clientWidth,
        document: document.documentElement.scrollWidth <= document.documentElement.clientWidth
      }))
    )
    .toEqual({ body: true, document: true });
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test("contains a long sanitized public snapshot in the dark theme", async ({ baseURL, page }) => {
  expect(baseURL).toBeTruthy();
  const owner = await prisma.user.findUnique({
    select: { id: true },
    where: { email: LOCAL_OPERATOR_EMAIL }
  });
  expect(owner).toBeTruthy();

  const token = `public-share-layout-${randomUUID()}`;
  const longEvidence = "ResearchEvidenceWithoutBreaks".repeat(24);
  const title = `A shared project title that wraps safely ${longEvidence}`;
  const snapshot = {
    messages: [
      {
        content: {
          blocks: [
            {
              text: `Review this bounded public source: https://example.com/${longEvidence}`,
              type: "text"
            }
          ]
        },
        role: "user"
      },
      {
        content: {
          blocks: [
            {
              text: [
                "## Public evidence",
                "",
                "| Source | Finding |",
                "| --- | --- |",
                `| Public | ${longEvidence} |`,
                "",
                "```ts",
                `const evidence = \"${longEvidence}\";`,
                "```"
              ].join("\n"),
              type: "text"
            }
          ]
        },
        role: "assistant"
      }
    ],
    title,
    version: 1
  } satisfies PublicShareSnapshot;

  const share = await prisma.sharedChatSnapshot.create({
    data: {
      ownerUserId: owner!.id,
      slugHash: hashShareToken(token),
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      title
    },
    select: { id: true }
  });

  try {
    await page.setViewportSize({ height: 844, width: 390 });
    await page.context().addCookies([
      {
        name: "aiqsa.theme",
        url: baseURL!,
        value: "graphite"
      }
    ]);
    const response = await page.goto(`/s/${token}`);
    expect(response?.status()).toBe(200);

    await expect(page).toHaveTitle("Shared conversation · AIQSA");
    expect(await page.title()).not.toContain(title);
    expect(await page.title()).not.toContain(token);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "graphite");
    await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    await expect(page.getByText("Read-only snapshot", { exact: true })).toBeVisible();
    await expect(page.getByTestId("markdown-table-scroll")).toBeVisible();
    await expect(page.getByTestId("markdown-code-scroll")).toBeVisible();
    await expect(page.getByTestId("public-share-view")).not.toContainText(share.id);
    await expect(page.getByTestId("public-share-view")).not.toContainText(LOCAL_OPERATOR_EMAIL);
    await expect(page.getByTestId("public-share-view")).not.toContainText(token);
    await expect(page.getByRole("button", { name: "Share anonymously" })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    for (const contained of [
      page.getByRole("heading", { level: 1 }),
      page.locator('[data-role="user"] [data-public-share-message-content="true"]')
    ]) {
      await expect.poll(() => contained.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }

    for (const scroller of [
      page.getByTestId("markdown-table-scroll"),
      page.getByTestId("markdown-code-scroll")
    ]) {
      await scroller.scrollIntoViewIfNeeded();
      const [box, viewport] = await Promise.all([scroller.boundingBox(), page.viewportSize()]);
      expect(box).toBeTruthy();
      expect(viewport).toBeTruthy();
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
    }
  } finally {
    await prisma.sharedChatSnapshot.delete({ where: { id: share.id } });
  }
});
