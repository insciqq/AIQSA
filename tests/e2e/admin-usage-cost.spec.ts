import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import type { AdminDashboard } from "../../lib/contracts/admin";
import { formatEstimatedCostMicros } from "../../lib/domain/formatEstimatedCost";

const prisma = new PrismaClient();
test.describe.configure({ mode: "serial" });
test.afterAll(async () => { await prisma.$disconnect(); });

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "tablet-portrait", width: 768, height: 1024 },
  { name: "tablet-landscape", width: 1024, height: 768 },
  { name: "phone-portrait", width: 390, height: 844 },
  { name: "phone-landscape", width: 844, height: 390 }
]) {
  for (const theme of ["light", "dark"] as const) {
    test(`Admin usage cost ${viewport.name} ${theme}`, async ({ page, context }, testInfo) => {
      const userId = randomUUID();
      const groupId = randomUUID();
      const fixtureName = `Cost coverage ${userId.slice(0, 8)}`;
      await prisma.user.create({ data: { id: userId, displayName: fixtureName, status: "active" } });
      try {
        await prisma.group.create({ data: { id: groupId, name: fixtureName } });
        await prisma.userGroup.create({ data: { userId, groupId, role: "member" } });
        await prisma.usageEvent.createMany({ data: [
          { userId, provider: "cost-fixture", modelId: "cost-fixture", totalTokens: 100,
            estimatedCostMicros: 125_000, usageCompleteness: "COMPLETE" },
          { userId, provider: "cost-fixture", modelId: "cost-fixture", totalTokens: 50,
            estimatedCostMicros: null, usageCompleteness: "COMPLETE" }
        ] });
        await page.setViewportSize(viewport);
        await context.addCookies([{ name: "aiqsa.theme", value: theme, url: testInfo.project.use.baseURL! }]);
        const auth = await page.request.post("/api/auth/token", { data: { token: "aiqsa-test-token" } });
        expect(auth.ok()).toBe(true);
        const response = await page.request.get("/api/admin");
        expect(response.ok()).toBe(true);
        const dashboard = await response.json() as AdminDashboard;
        expect(dashboard.usage.byUser.find((row) => row.userId === userId)).toMatchObject({
          estimatedCostMicros: 125_000, recordCount: 2, knownCostRecordCount: 1, runCount: 0, totalTokens: 150
        });
        await page.goto("/admin?section=usage");
        const usage = page.getByTestId("admin-section-usage");
        const summary = usage.getByRole("region", { name: "Usage summary" });
        await expect(summary).toBeVisible();
        await expect(summary.getByTestId("usage-total-cost")).toContainText(
          formatEstimatedCostMicros(dashboard.usage.totals.estimatedCostMicros)
        );
        await summary.getByTestId("usage-total-cost").scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath("usage-cost-summary.png") });

        const group = viewport.width >= 1024
          ? page.getByRole("region", { name: "Group usage table" }).getByRole("row").filter({ hasText: fixtureName })
          : page.getByTestId("admin-usage-groups-mobile").locator("article").filter({ hasText: fixtureName });
        const user = viewport.width >= 1024
          ? page.getByRole("region", { name: "User usage table" }).getByRole("row").filter({ hasText: fixtureName })
          : page.getByTestId("admin-usage-users-mobile").locator("article").filter({ hasText: fixtureName });
        for (const [label, row] of [["group", group], ["user", user]] as const) {
          await row.scrollIntoViewIfNeeded();
          await expect(row).toBeVisible();
          await expect(row.getByText("≈ $0.125", { exact: true })).toHaveCount(label === "user" ? 2 : 1);
          await expect(row.getByText("cost known for 1 of 2 requests", { exact: true })).toHaveCount(label === "user" ? 2 : 1);
          await page.screenshot({ path: testInfo.outputPath(`usage-cost-${label}.png`) });
        }
        await expect.poll(() => page.evaluate(() => ({
          body: document.body.scrollWidth <= document.body.clientWidth,
          document: document.documentElement.scrollWidth <= document.documentElement.clientWidth
        }))).toEqual({ body: true, document: true });
      } finally {
        await prisma.user.delete({ where: { id: userId } });
        await prisma.group.deleteMany({ where: { id: groupId } });
      }
    });
  }
}
