import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { decodeCatalogResponse } from "../../lib/contracts/catalog";
import { SCHEDULED_TASK_RETRY_WINDOW_MS } from "../../lib/server/scheduledTasks/runnerPolicy";
import { runAccountMenuAction } from "./shell/page";
import { authenticateWithLocalToken } from "./support/localAuth";

/**
 * A scheduled task whose owner has used up the monthly budget, on a real
 * stand with the app's own runner: Run now is refused before any run, the
 * occurrence waits with the budget reason, and once its retry window ends it
 * is skipped with that reason while the task stays active. Synthetic spend is
 * tagged by model id and removed afterwards.
 */
const prisma = new PrismaClient();
const FIXTURE_MODEL = "usage-limits-scheduled-e2e";
let userId = "";
let taskId = "";

test.afterAll(async () => {
  if (taskId) await prisma.scheduledTask.deleteMany({ where: { id: taskId } });
  if (userId) {
    await prisma.usageEvent.deleteMany({ where: { modelId: FIXTURE_MODEL, userId } });
    await prisma.usageLimit.deleteMany({ where: { userId } });
  }
  await prisma.$disconnect();
});

async function occurrence() {
  return prisma.scheduledTaskOccurrence.findFirst({ where: { taskId }, orderBy: { scheduledFor: "desc" } });
}

test("a used-up budget skips a scheduled run with its reason and never pauses the task", async ({ page }) => {
  test.setTimeout(300_000);
  await authenticateWithLocalToken(page.request);
  userId = (await (await page.request.get("/api/me")).json()).user.id as string;
  expect((await page.request.put(`/api/admin/usage-limits/users/${userId}`, { data: {
    exempt: false, messagesPerDay: null, messagesPerHour: null, monthlyBudgetMicros: 1_000
  } })).ok()).toBe(true);
  await prisma.usageEvent.create({ data: {
    estimatedCostMicros: 5_000, inputTokens: 1_000, modelId: FIXTURE_MODEL, outputTokens: 100, provider: "openai",
    purpose: "chat_answer", totalTokens: 1_100, usageCompleteness: "COMPLETE", userId
  } });

  const catalog = decodeCatalogResponse(await (await page.request.get("/api/me/catalog")).json());
  const model = catalog?.models[0];
  expect(model, "the stand lists an answer model").toBeTruthy();
  const created = await page.request.post("/api/me/scheduled-tasks", { data: {
    title: "Budget check", prompt: "Synthetic scheduled instructions.", schedule: { kind: "daily", time: "09:00" },
    timeZone: "UTC", modelId: model!.modelId, provider: model!.provider, searchEnabled: false, emailNotify: false,
    toolsEnabled: false, workspaceEnabled: false, memoryEnabled: false, chatMode: "new", kind: "standard",
    historyRetentionDays: 90, pinnedSkillIds: []
  } });
  expect(created.ok(), `task is created (${created.status()})`).toBe(true);
  taskId = (await created.json() as { task: { id: string } }).task.id;
  const runsBefore = await prisma.modelRun.count({ where: { userId } });

  expect((await page.request.post(`/api/me/scheduled-tasks/${taskId}/run`)).ok()).toBe(true);
  await expect.poll(async () => {
    const pending = await occurrence();
    return pending ? { reasonCode: pending.reasonCode, runId: pending.runId, state: pending.state } : null;
  }, { intervals: [2_000], timeout: 120_000 }).toEqual({ reasonCode: "usage_budget_exhausted", runId: null, state: "PENDING" });
  expect(await prisma.modelRun.count({ where: { userId } }), "a refused occurrence creates no run").toBe(runsBefore);

  // The retry window ends: the runner's next tick settles the occurrence.
  const waiting = await occurrence();
  await prisma.scheduledTaskOccurrence.update({ where: { id: waiting!.id }, data: {
    startedAt: new Date(Date.now() - SCHEDULED_TASK_RETRY_WINDOW_MS - 60_000)
  } });
  await expect.poll(async () => {
    const settled = await prisma.scheduledTaskOccurrence.findUnique({ where: { id: waiting!.id } });
    return settled ? { reasonCode: settled.reasonCode, state: settled.state } : null;
  }, { intervals: [2_000], timeout: 120_000 }).toEqual({ reasonCode: "usage_budget_exhausted", state: "SKIPPED" });
  const task = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: taskId } });
  expect(task.pauseReason, "a budget skip never pauses the task").toBeNull();

  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await runAccountMenuAction(page, "Scheduled");
  const panel = page.getByTestId("scheduled-tasks-panel");
  await expect(panel.getByRole("heading", { name: "Budget check" })).toBeVisible();
  await expect(panel.getByText(/^Paused/u)).toHaveCount(0);
  await panel.getByRole("button", { name: "More actions for Budget check", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const runs = page.getByRole("dialog", { name: "Edit scheduled task", exact: true })
    .getByRole("region", { name: "Recent runs", exact: true });
  await expect(runs.getByRole("listitem").first()).toContainText("Skipped: your monthly budget was used up");
});
