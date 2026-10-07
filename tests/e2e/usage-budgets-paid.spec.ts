/**
 * Opt-in, paid, bounded end-to-end check of usage accounting and limits on a
 * DISPOSABLE stand with a real codex-lb answer model. Never a default lane:
 * it runs only with AIQSA_BUDGETS_PAID_E2E=DISPOSABLE plus CODEX_LB_API_KEY
 * and CODEX_LB_BASE_URL (the Codex root ending in `/backend-api/codex`, so
 * catalog prices apply); AIQSA_BUDGETS_CODEX_MODEL picks the model (default
 * gpt-5.6-luna, else gpt-5.5 when the endpoint does not list it).
 *
 * Oracles are the stand's database and HTTP status codes, never the model's
 * wording; prompts and answers are never printed. The attached summary holds
 * counts, codes and booleans only.
 */
import { randomUUID } from "node:crypto";
import { PrismaClient, type ModelRun } from "@prisma/client";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { decodeAdminUsageAnalyticsResponse } from "../../lib/contracts/adminUsageAnalytics";
import { decodeCatalogResponse } from "../../lib/contracts/catalog";
import { decodeUserUsageLimitStatusResponse } from "../../lib/contracts/usageLimits";
import { codexLbSetupBody, journeyRunParams, modelInConnection, readConnections } from "../../scripts/context-compaction-journey-support";
import { authenticateWithLocalToken } from "./support/localAuth";

const prisma = new PrismaClient();
const enabled = process.env.AIQSA_BUDGETS_PAID_E2E === "DISPOSABLE";

test.skip(!enabled, "paid: requires AIQSA_BUDGETS_PAID_E2E=DISPOSABLE on a disposable stand");
test.describe.configure({ mode: "serial" });
test.afterAll(() => prisma.$disconnect());

const SETUP_TIMEOUT_MS = 600_000;
const TURN_TIMEOUT_MS = 300_000;
const ACTIVE = ["preparing", "queued", "streaming", "in_progress"];
const env = (name: string) => process.env[name]?.trim() || null;

type AnswerModel = Readonly<{ modelId: string; params: Record<string, unknown>; provider: string }>;

async function poll<T>(timeoutMs: number, probe: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("budgets_paid_poll_timeout");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function codexLbModel(request: APIRequestContext): Promise<AnswerModel> {
  const apiRoot = env("CODEX_LB_BASE_URL")?.replace(/\/+$/u, "");
  const secret = env("CODEX_LB_API_KEY");
  if (!apiRoot || !secret) throw new Error("budgets_paid_model_unconfigured");
  const discovered = await request.post("/api/admin/providers/custom-setup/discover", { timeout: SETUP_TIMEOUT_MS,
    data: { allowPrivateNetwork: true, apiRoot, authenticationMode: "bearer", responseTimeoutSeconds: 180, secret } });
  const discovery = discovered.ok() ? await discovered.json() as { catalogProof?: unknown; models?: Array<{ id?: unknown }> } : null;
  const listed = new Set((discovery?.models ?? []).map((model) => model.id));
  const preferred = env("AIQSA_BUDGETS_CODEX_MODEL") ?? "gpt-5.6-luna";
  const upstream = listed.size === 0 || listed.has(preferred) ? preferred : "gpt-5.5";
  const catalogProof = typeof discovery?.catalogProof === "string" && listed.has(upstream) ? discovery.catalogProof : undefined;
  const setup = await request.post("/api/admin/providers/custom-setup", { timeout: SETUP_TIMEOUT_MS,
    data: codexLbSetupBody({ apiRoot, ...(catalogProof ? { catalogProof } : {}), contextWindow: 65_536, model: upstream, secret,
      connectionDisplayName: `Budgets ${randomUUID().slice(0, 8)}` }) });
  expect(setup.ok(), "codex-lb custom setup is accepted").toBe(true);
  const outcome = await setup.json() as { connectionId?: unknown; outcome?: unknown };
  expect(["ready", "partial"]).toContain(outcome.outcome);
  const connectionId = String(outcome.connectionId);
  const providerModelId = await poll(SETUP_TIMEOUT_MS, async () => {
    const connection = readConnections(await (await request.get("/api/admin/providers")).json())
      ?.find((candidate) => candidate.id === connectionId);
    return connection && !connection.checkRunning ? modelInConnection(connection, upstream)?.id ?? null : null;
  });
  const model = await poll(SETUP_TIMEOUT_MS, async () => {
    const catalog = decodeCatalogResponse(await (await request.get("/api/me/catalog")).json());
    return catalog?.models.find((candidate) => candidate.provider === connectionId && candidate.modelId === providerModelId) ?? null;
  });
  return { modelId: providerModelId, params: journeyRunParams(model, 512), provider: connectionId };
}

async function newChat(request: APIRequestContext): Promise<string> {
  const created = await request.post("/api/chats", { data: { title: "Budgets check" } });
  expect(created.ok()).toBe(true);
  const chatId = (await created.json() as { chat: { id: string } }).chat.id;
  expect((await request.patch(`/api/me/chats/${chatId}/memory-mode`, { data: { mode: "EXCLUDED" } })).ok()).toBe(true);
  return chatId;
}

async function send(request: APIRequestContext, chatId: string, model: AnswerModel, text: string) {
  const chat = await prisma.chat.findUniqueOrThrow({ where: { id: chatId }, select: { activeLeafMessageId: true } });
  const response = await request.post(`/api/chats/${chatId}/messages`, { timeout: TURN_TIMEOUT_MS, data: {
    content: { blocks: [{ text, type: "text" }] }, expectedActiveLeafId: chat.activeLeafMessageId,
    mcp: { mode: "off" }, modelId: model.modelId, params: model.params, provider: model.provider,
    searchPlan: { mode: "all_selected", optionIds: [] }, searchStrategy: "search-disabled", timeZone: "UTC"
  } });
  return response;
}

async function completedTurn(request: APIRequestContext, chatId: string, model: AnswerModel): Promise<ModelRun> {
  const response = await send(request, chatId, model, "Reply with exactly one word: ready.");
  expect(response.ok(), `send is accepted (${response.status()})`).toBe(true);
  await response.body();
  const newest = await prisma.modelRun.findFirstOrThrow({ where: { chatId }, orderBy: { createdAt: "desc" } });
  const settled = await poll(TURN_TIMEOUT_MS, async () => {
    const run = await prisma.modelRun.findUniqueOrThrow({ where: { id: newest.id } });
    return ACTIVE.includes(run.status) ? null : run;
  });
  expect(settled.status).toBe("complete");
  return settled;
}

async function knownSpend(userId: string): Promise<number> {
  const sum = await prisma.usageEvent.aggregate({ _sum: { estimatedCostMicros: true }, where: { userId } });
  return sum._sum.estimatedCostMicros ?? 0;
}

async function override(request: APIRequestContext, userId: string, limits: Readonly<{ budget: number | null; hour: number | null }>) {
  // Saves name the version they replace; a first save names none.
  const saved = await prisma.usageLimit.findUnique({ select: { version: true }, where: { userId } });
  const response = await request.put(`/api/admin/usage-limits/users/${userId}`, { data: {
    exempt: false, messagesPerDay: null, messagesPerHour: limits.hour, monthlyBudgetMicros: limits.budget,
    ...(saved ? { expectedVersion: saved.version } : {})
  } });
  expect(response.ok()).toBe(true);
}

test("real usage is accounted, budgets and message limits refuse before provider work, deletion keeps spend", async ({ request }, testInfo) => {
  test.setTimeout(1_800_000);
  await authenticateWithLocalToken(request);
  const userId = (await (await request.get("/api/me")).json()).user.id as string;
  await prisma.usageLimit.deleteMany({ where: { userId } });
  const model = await codexLbModel(request);
  const chatId = await newChat(request);
  const summary: Record<string, unknown> = {};

  const first = await completedTurn(request, chatId, model);
  const firstRows = await prisma.usageEvent.findMany({ where: { modelRunId: first.id } });
  summary.firstRunUsageRows = firstRows.length;
  summary.firstRunKnownCost = firstRows.some((row) => row.estimatedCostMicros !== null && row.estimatedCostMicros > 0);
  expect(summary.firstRunKnownCost, "a codex-lb answer has a catalog-priced cost").toBe(true);
  const spent = await knownSpend(userId);

  const analytics = decodeAdminUsageAnalyticsResponse(await (await request.get("/api/admin/usage?period=7d&tz=UTC")).json());
  expect(analytics).not.toBeNull();
  const mine = analytics!.usage.byUser.find((row) => row.userId === userId);
  expect(mine?.estimatedCostMicros ?? 0).toBeGreaterThanOrEqual(spent);
  expect(analytics!.usage.byModel.some((row) => row.modelId === model.modelId && row.provider === model.provider)).toBe(true);
  summary.analyticsRunCount = mine?.runCount ?? 0;

  await override(request, userId, { budget: spent, hour: null });
  const status = decodeUserUsageLimitStatusResponse(await (await request.get("/api/me/usage-limits")).json());
  expect(status?.usageLimits).toMatchObject({ monthSpentMicros: spent, monthlyBudgetMicros: spent });
  const runsBefore = await prisma.modelRun.count({ where: { chatId } });
  const refused = await send(request, chatId, model, "This must not reach the provider.");
  expect(refused.status()).toBe(429);
  expect(Number(refused.headers()["retry-after"])).toBeGreaterThan(0);
  expect(await refused.json()).toMatchObject({ error: "usage_budget_exhausted", usageLimit: { limit: spent, scope: "user", window: "month" } });
  expect(await prisma.modelRun.count({ where: { chatId } }), "a refused send creates no run").toBe(runsBefore);
  expect(await knownSpend(userId), "a refused send spends nothing").toBe(spent);
  summary.budgetRefusal = refused.status();

  await override(request, userId, { budget: spent + 5_000_000, hour: null });
  const second = await completedTurn(request, chatId, model);
  summary.secondRunComplete = second.status === "complete";
  const spentAfterSecond = await knownSpend(userId);
  expect(spentAfterSecond).toBeGreaterThan(spent);

  const admittedLastHour = await prisma.usageMessageAdmission.count({
    where: { createdAt: { gt: new Date(Date.now() - 60 * 60 * 1000) }, userId }
  });
  await override(request, userId, { budget: null, hour: admittedLastHour });
  const limited = await send(request, chatId, model, "This must not reach the provider either.");
  expect(limited.status()).toBe(429);
  expect(await limited.json()).toMatchObject({ error: "message_rate_limited", usageLimit: { limit: admittedLastHour, window: "hour" } });
  summary.rateRefusal = limited.status();

  await prisma.usageLimit.deleteMany({ where: { userId } });
  const deleted = await request.post(`/api/chats/${chatId}/delete-permanently`, { data: {
    alsoForgetOriginMemories: false, confirmationCopyVersion: "memory-confirmation-v1", requestId: randomUUID()
  } });
  expect(deleted.status(), "permanent deletion is accepted").toBe(202);
  await poll(TURN_TIMEOUT_MS, async () => (await prisma.chat.findUnique({ where: { id: chatId } })) === null ? true : null);
  expect(await knownSpend(userId), "deleting the chat keeps its spend").toBe(spentAfterSecond);
  expect(await prisma.usageMessageAdmission.count({
    where: { createdAt: { gt: new Date(Date.now() - 60 * 60 * 1000) }, userId }
  }), "deleting the chat keeps message admissions").toBe(admittedLastHour);
  summary.spendKeptAfterDeletion = true;

  await testInfo.attach("budgets-paid-summary.json", { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
  console.log(`budgets_paid_summary ${JSON.stringify(summary)}`);
});
