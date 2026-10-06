import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { decodeAdminUsageAnalyticsResponse } from "../../lib/contracts/adminUsageAnalytics";
import { textMessageContent } from "../../lib/domain/content";

/**
 * The Usage management view over a realistic synthetic installation: several
 * users and groups, a few models, daily chat and scheduled runs over two
 * months (so the previous window has data) and background usage without a
 * known price. Screenshots cover every layout and theme.
 */
const prisma = new PrismaClient();
test.describe.configure({ mode: "serial" });

const DAY_MS = 24 * 60 * 60 * 1000;
const tag = randomUUID().slice(0, 6);
const groups = ["Engineering", "Marketing", "Support"].map((name) => ({ id: randomUUID(), name: `${name} ${tag}` }));
const models = [
  { modelId: "gpt-5.5", provider: "openai", inputPrice: 1.25, outputPrice: 10 },
  { modelId: "claude-sonnet-5-5", provider: "anthropic", inputPrice: 3, outputPrice: 15 },
  { modelId: "gemini-3-flash", provider: "gemini", inputPrice: 0.3, outputPrice: 2.5 }
];
const people = [
  { name: "Mira Petrova", groups: [0], model: 1, intensity: 9 },
  { name: "Oleg Sokolov", groups: [0], model: 0, intensity: 7 },
  { name: "Anna Kim", groups: [1], model: 2, intensity: 5 },
  { name: "Ivan Orlov", groups: [1, 2], model: 0, intensity: 3 },
  { name: "Sofia Lind", groups: [2], model: 2, intensity: 2 },
  { name: "Pavel Gromov", groups: [0, 2], model: 1, intensity: 1 }
].map((person) => ({ ...person, id: randomUUID(), email: `${person.name.toLowerCase().replace(" ", ".")}.${tag}@example.test` }));

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

async function seed(): Promise<void> {
  await prisma.group.createMany({ data: groups });
  for (const person of people) {
    await prisma.user.create({ data: { displayName: person.name, email: person.email, id: person.id, status: "active" } });
    await prisma.userGroup.createMany({ data: person.groups.map((index) => ({ groupId: groups[index]!.id, role: "member", userId: person.id })) });
  }
  const next = random(42);
  const now = Date.now();
  for (const [personIndex, person] of people.entries()) {
    const chatId = randomUUID();
    await prisma.chat.create({ data: { id: chatId, title: "Synthetic usage", userId: person.id } });
    let parent: string | null = null;
    const usage: Parameters<typeof prisma.usageEvent.createMany>[0]["data"] = [];
    for (let day = 59; day >= 0; day -= 1) {
      const runs = Math.max(0, Math.round(person.intensity * (0.4 + next()) * (day < 30 ? 1.25 : 1) - (day % 7 >= 5 ? 3 : 0)));
      for (let index = 0; index < runs; index += 1) {
        const createdAt = new Date(now - day * DAY_MS - Math.floor(next() * 8 * 60 * 60 * 1000) - 60_000);
        const scheduled = personIndex < 2 && index === 0;
        const questionId = randomUUID();
        const answerId = randomUUID();
        const runId = randomUUID();
        const model = models[scheduled ? 2 : person.model]!;
        await prisma.message.create({ data: { chatId, content: textMessageContent("Q"), createdAt, id: questionId,
          parentMessageId: parent, role: "user", status: "complete" } });
        await prisma.message.create({ data: { chatId, content: textMessageContent("A"), createdAt, id: answerId,
          parentMessageId: questionId, role: "assistant", status: "complete" } });
        parent = answerId;
        await prisma.modelRun.create({ data: {
          assistantMessageId: answerId, chatId, createdAt, id: runId, modelId: model.modelId, normalizedRequest: {},
          provider: model.provider, status: "complete", userId: person.id, userMessageId: questionId,
          ...(scheduled ? { scheduledOccurrenceId: randomUUID(), scheduledTaskGeneration: 1, scheduledTaskId: randomUUID() } : {})
        } });
        const inputTokens = Math.round(4_000 + next() * 40_000);
        const cachedInputTokens = Math.round(inputTokens * next() * 0.6);
        const outputTokens = Math.round(300 + next() * 3_000);
        const cost = Math.round(((inputTokens - cachedInputTokens) * model.inputPrice + cachedInputTokens * model.inputPrice * 0.1 +
          outputTokens * model.outputPrice));
        usage.push({ cachedInputTokens, chatId, createdAt, estimatedCostMicros: cost, inputTokens, modelId: model.modelId,
          modelRunId: runId, outputTokens, provider: model.provider, totalTokens: inputTokens + outputTokens,
          usageCompleteness: "COMPLETE", userId: person.id });
      }
      if (day % 2 === 0) {
        const inputTokens = Math.round(2_000 + next() * 20_000);
        usage.push({ createdAt: new Date(now - day * DAY_MS - 3 * 60 * 60 * 1000), inputTokens, modelId: "text-embedding-3-small",
          provider: "openai", totalTokens: inputTokens, usageCompleteness: "PARTIAL", userId: person.id });
      }
    }
    await prisma.usageEvent.createMany({ data: usage });
  }
}

async function signIn(page: Page, theme: "dark" | "light", baseURL: string): Promise<void> {
  await page.context().addCookies([{ name: "aiqsa.theme", url: baseURL, value: theme }]);
  const auth = await page.request.post("/api/auth/token", { data: { token: "aiqsa-test-token" } });
  expect(auth.ok()).toBe(true);
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({
    body: document.body.scrollWidth <= document.body.clientWidth,
    document: document.documentElement.scrollWidth <= document.documentElement.clientWidth
  }))).toEqual({ body: true, document: true });
}

test.beforeAll(async () => { await seed(); });
test.afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: people.map((person) => person.id) } } });
  await prisma.group.deleteMany({ where: { id: { in: groups.map((group) => group.id) } } });
  await prisma.$disconnect();
});

test("usage analytics endpoint and CSV describe the seeded period", async ({ page }, testInfo) => {
  await signIn(page, "light", testInfo.project.use.baseURL!);
  const response = await page.request.get("/api/admin/usage?period=30d&tz=Europe/Moscow");
  expect(response.ok()).toBe(true);
  const analytics = decodeAdminUsageAnalyticsResponse(await response.json());
  expect(analytics).not.toBeNull();
  const usage = analytics!.usage;
  expect(usage.series).toHaveLength(30);
  expect(usage.previous).not.toBeNull();
  expect(usage.byUser.filter((row) => people.some((person) => person.id === row.userId))).toHaveLength(people.length);
  expect(new Set(usage.byCategory.map((row) => row.category))).toEqual(new Set(["background", "chat", "scheduled"]));
  const csv = await page.request.get("/api/admin/usage/export?period=30d&tz=Europe/Moscow");
  expect(csv.ok()).toBe(true);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect(csv.headers()["content-disposition"]).toMatch(/^attachment; filename="aiqsa-usage-30d-\d{4}-\d{2}-\d{2}\.csv"$/u);
  const lines = (await csv.text()).replace(/^﻿/u, "").trim().split("\r\n");
  expect(lines[0]).toBe("period_start,user_email,user_name,groups,category,provider,model,runs,records,input_tokens," +
    "cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_tokens,total_tokens,estimated_cost_usd,cost_known_records");
  expect(lines.length).toBeGreaterThan(30);
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "tablet-portrait", width: 768, height: 1024 },
  { name: "tablet-landscape", width: 1024, height: 768 },
  { name: "phone-portrait", width: 390, height: 844 },
  { name: "phone-landscape", width: 844, height: 390 }
]) {
  for (const theme of ["light", "dark"] as const) {
    test(`usage management view ${viewport.name} ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await signIn(page, theme, testInfo.project.use.baseURL!);
      await page.goto("/admin?section=usage");
      const section = page.getByTestId("admin-section-usage");
      const summary = section.getByLabel("Usage summary");
      await expect(summary).toBeVisible();
      await expect(summary.getByTestId("usage-kpi-cost")).toContainText("$");
      await page.screenshot({ path: testInfo.outputPath("01-top.png") });

      const chart = section.getByTestId("usage-spend-chart");
      await chart.scrollIntoViewIfNeeded();
      const box = await chart.boundingBox();
      if (box) await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.6);
      await expect(section.getByTestId("usage-chart-tooltip")).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("02-chart-hover.png") });

      await section.getByRole("group", { name: "Chart metric" }).getByRole("button", { name: "Tokens" }).click();
      await page.screenshot({ path: testInfo.outputPath("03-chart-tokens.png") });

      const byModel = section.getByText("By model", { exact: true }).first();
      await byModel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("04-breakdowns.png") });

      const users = section.getByText("Mira Petrova").first();
      await users.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("05-users.png") });

      const groupsHeading = section.getByText(groups[0]!.name).last();
      await groupsHeading.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("06-groups.png") });
      await expectNoPageOverflow(page);

      if (viewport.name === "desktop") {
        await page.evaluate(() => window.scrollTo(0, 0));
        await section.getByRole("combobox").first().selectOption("90d");
        await expect(page).toHaveURL(/filter=90d/u);
        await expect(summary.getByTestId("usage-kpi-cost")).toContainText("$");
        await page.screenshot({ path: testInfo.outputPath("07-90d.png") });
        await section.getByRole("combobox").first().selectOption("12m");
        await expect(page).toHaveURL(/filter=12m/u);
        await expect(summary.getByTestId("usage-kpi-cost")).toContainText("$");
        await chart.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath("08-12m.png") });
      }
    });
  }
}
