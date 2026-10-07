import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { decodeAdminUsageLimitsResponse } from "../../lib/contracts/usageLimits";

/**
 * Control Center → Budgets & limits over a synthetic installation: limits are
 * configured through the admin API, current-month spend is seeded, and the
 * section, its sheets and the Needs-attention items are captured in every
 * layout and theme.
 */
const prisma = new PrismaClient();
test.describe.configure({ mode: "serial" });

const tag = randomUUID().slice(0, 6);
const groups = [
  { id: randomUUID(), name: `Engineering ${tag}`, budget: 40_000_000, hour: 60 },
  { id: randomUUID(), name: `Interns ${tag}`, budget: 5_000_000, hour: 20 },
  { id: randomUUID(), name: `Support ${tag}`, budget: null, hour: null }
];
const people = [
  { name: "Mira Petrova", groups: [0], spend: 38_500_000 },
  { name: "Oleg Sokolov", groups: [0, 1], spend: 12_000_000 },
  { name: "Anna Kim", groups: [1], spend: 4_200_000 },
  { name: "Ivan Orlov", groups: [1], spend: 5_400_000 },
  { name: "Sofia Lind", groups: [2], spend: 900_000 },
  { name: "Pavel Gromov", groups: [], spend: 300_000 }
].map((person) => ({ ...person, id: randomUUID(), email: `${person.name.toLowerCase().replace(" ", ".")}.${tag}@example.test` }));

async function signIn(page: Page, theme: "dark" | "light", baseURL: string): Promise<void> {
  await page.context().addCookies([{ name: "aiqsa.theme", url: baseURL, value: theme }]);
  const auth = await page.request.post("/api/auth/token", { data: { token: "aiqsa-test-token" } });
  expect(auth.ok()).toBe(true);
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflowing = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth + 0.5;
    return [...document.querySelectorAll<HTMLElement>("body *")]
      // Content inside a visually hidden clip or a local horizontal scroller cannot widen the page.
      .filter((element) => {
        if (element.closest(".sr-only") || element.getBoundingClientRect().right <= limit) return false;
        for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
          if (getComputedStyle(parent).overflowX !== "visible" && parent.getBoundingClientRect().right <= limit) return false;
        }
        return true;
      })
      .slice(0, 12)
      .map((element) => `${element.tagName.toLowerCase()}${element.dataset.testid ? `[${element.dataset.testid}]` : ""}` +
        ` .${String(element.className).slice(0, 80)} right=${Math.round(element.getBoundingClientRect().right)}`);
  });
  expect(overflowing, "elements beyond the viewport's right edge").toEqual([]);
}

test.beforeAll(async () => {
  await prisma.group.createMany({ data: groups.map(({ id, name }) => ({ id, name })) });
  const now = new Date();
  for (const person of people) {
    await prisma.user.create({ data: { displayName: person.name, email: person.email, id: person.id, status: "active" } });
    await prisma.userGroup.createMany({ data: person.groups.map((index) => ({ groupId: groups[index]!.id, role: "member", userId: person.id })) });
    await prisma.usageEvent.create({ data: {
      chatId: randomUUID(), createdAt: new Date(Math.max(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1), now.getTime() - 60_000)),
      estimatedCostMicros: person.spend, inputTokens: 1_000, modelId: "gpt-5.5", outputTokens: 100, provider: "openai",
      purpose: "chat_answer", totalTokens: 1_100, usageCompleteness: "COMPLETE", userId: person.id
    } });
  }
});

test.afterAll(async () => {
  await prisma.usageLimitPolicy.update({ data: { messagesPerDay: null, messagesPerHour: null, monthlyBudgetMicros: null, monthlyCapMicros: null },
    where: { id: "installation" } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: people.map((person) => person.id) } } });
  await prisma.group.deleteMany({ where: { id: { in: groups.map((group) => group.id) } } });
  await prisma.$disconnect();
});

test("limits are configured through the admin API", async ({ page }, testInfo) => {
  await signIn(page, "light", testInfo.project.use.baseURL!);
  const current = decodeAdminUsageLimitsResponse(await (await page.request.get("/api/admin/usage-limits")).json());
  expect(current).not.toBeNull();
  const installation = await page.request.patch("/api/admin/usage-limits/installation", { data: {
    expectedVersion: current!.limits.installation.version, messagesPerDay: 200, messagesPerHour: null,
    monthlyBudgetMicros: 2_000_000, monthlyCapMicros: 70_000_000
  } });
  expect(installation.ok()).toBe(true);
  for (const group of groups) {
    if (group.budget === null) continue;
    const response = await page.request.put(`/api/admin/usage-limits/groups/${group.id}`, { data: {
      messagesPerDay: null, messagesPerHour: group.hour, monthlyBudgetMicros: group.budget
    } });
    expect(response.ok()).toBe(true);
  }
  const override = await page.request.put(`/api/admin/usage-limits/users/${people[1]!.id}`, { data: {
    exempt: false, messagesPerDay: null, messagesPerHour: null, monthlyBudgetMicros: 15_000_000
  } });
  expect(override.ok()).toBe(true);
  const exempt = await page.request.put(`/api/admin/usage-limits/users/${people[4]!.id}`, { data: {
    exempt: true, messagesPerDay: null, messagesPerHour: null, monthlyBudgetMicros: null
  } });
  expect(exempt.ok()).toBe(true);
  const limits = decodeAdminUsageLimitsResponse(await exempt.json())!.limits;
  // A save that names no version, or an outdated one, never overwrites a saved allowance.
  const engineering = limits.groups.find((row) => row.groupId === groups[0]!.id)!;
  for (const version of [{}, { expectedVersion: engineering.version! + 1_000_000 }]) {
    const stale = await page.request.put(`/api/admin/usage-limits/groups/${groups[0]!.id}`, { data: {
      messagesPerDay: 1, messagesPerHour: null, monthlyBudgetMicros: null, ...version
    } });
    expect(stale.status()).toBe(409);
    expect(await stale.json()).toEqual({ error: "usage_limits_stale" });
  }
  const row = (id: string) => limits.users.find((user) => user.userId === id)!;
  expect(row(people[0]!.id).effective.monthlyBudgetMicros).toEqual({ source: { groupId: groups[0]!.id, kind: "group", name: groups[0]!.name }, value: 40_000_000 });
  expect(row(people[1]!.id).effective.monthlyBudgetMicros).toEqual({ source: { kind: "user" }, value: 15_000_000 });
  expect(row(people[3]!.id).effective.monthlyBudgetMicros.value).toBe(5_000_000);
  expect(row(people[4]!.id).effective.exempt).toBe(true);
  expect(row(people[5]!.id).effective.monthlyBudgetMicros).toEqual({ source: { kind: "installation" }, value: 2_000_000 });
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "tablet-portrait", width: 768, height: 1024 },
  { name: "tablet-landscape", width: 1024, height: 768 },
  { name: "phone-portrait", width: 390, height: 844 },
  { name: "phone-landscape", width: 844, height: 390 }
]) {
  for (const theme of ["light", "dark"] as const) {
    test(`budgets and limits ${viewport.name} ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await signIn(page, theme, testInfo.project.use.baseURL!);
      await page.goto("/admin?section=limits");
      const summary = page.getByTestId("admin-usage-limits-summary");
      await expect(summary).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("01-top.png") });

      const groupsList = page.getByTestId("admin-usage-limit-groups");
      await groupsList.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("02-groups.png") });

      const usersList = page.getByTestId("admin-usage-limit-users");
      await usersList.scrollIntoViewIfNeeded();
      await expect(usersList.getByText("Mira Petrova").locator("visible=true").first()).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("03-users.png") });
      await expectNoPageOverflow(page);

      await usersList.getByRole("button", { name: "Edit limits for Oleg Sokolov" }).click();
      const sheet = page.getByRole("dialog");
      await expect(sheet).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("04-user-sheet.png") });
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);

      if (viewport.name === "desktop") {
        await page.goto("/admin?section=overview");
        const items = page.getByTestId("admin-attention-item");
        await expect(items.filter({ hasText: "The monthly cap for everyone is almost used" })).toBeVisible();
        await expect(items.filter({ hasText: "A user reached their monthly budget" })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("05-attention.png") });
      }
    });
  }
}
