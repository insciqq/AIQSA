/**
 * Opt-in, paid, bounded check of web Search through the product on a
 * DISPOSABLE stand: every working engine answers a Russian question for a
 * Codex LB answer model with sources, several engines answer one call
 * together, the model searches a time-sensitive question on its own, and the
 * Search controls and sources are captured at desktop, tablet and phone
 * sizes. Never a default lane: it runs only with
 * AIQSA_FEATURES_PAID_E2E=DISPOSABLE plus CODEX_LB_API_KEY and
 * CODEX_LB_BASE_URL; each engine needs its own key (DEEPSEEK_API_KEY,
 * OPENROUTER_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY) and is left out
 * without it. The disposable-target guard runs first.
 *
 * Paid calls: Codex LB custom setup once; Quick Setup and its model checks
 * once per keyed provider (plus the Search source's one probe search); then
 * one answer turn per engine (one or two Codex LB requests and one engine
 * search each), one fan-out turn over two engines and one unprompted turn.
 *
 * Oracles are the persisted runs, tool calls, Search rows and usage rows;
 * prompts, answers, sources and keys are never printed. The attached summary
 * holds counts, statuses and booleans only.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient, type ModelRun } from "@prisma/client";
import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";
import type { AdminSearchIntegration } from "../../lib/contracts/adminSearch";
import { authenticateWithLocalToken } from "./support/localAuth";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import {
  completedPaidTurn,
  connectionSearchSource,
  deletePaidChat,
  newExcludedChat,
  paidEnv,
  quickSetupConnection,
  setupCodexLbAnswerModel,
  waitForCatalogModel,
  type PaidAnswerModel
} from "./support/paidProviders";

const prisma = new PrismaClient();
const enabled = process.env.AIQSA_FEATURES_PAID_E2E === "DISPOSABLE";
test.skip(!enabled, "paid: requires AIQSA_FEATURES_PAID_E2E=DISPOSABLE on a disposable stand");
test.describe.configure({ mode: "serial" });
test.afterAll(async () => { await prisma.$disconnect(); });

const VIEWPORTS = [
  { height: 900, name: "desktop", width: 1440 },
  { height: 1112, name: "tablet-portrait", width: 834 },
  { height: 834, name: "tablet-landscape", width: 1112 },
  { height: 844, name: "phone-portrait", width: 390 },
  { height: 390, name: "phone-landscape", width: 844 }
] as const;

type Engine = Readonly<{
  key: string;
  kind: AdminSearchIntegration["kind"];
  name: string;
  prefer: RegExp;
  provider: "deepseek" | "gemini" | "openai" | "openrouter";
}>;

const ENGINES: readonly Engine[] = [
  { key: "DEEPSEEK_API_KEY", kind: "deepseek_search_api", name: "deepseek-search-api", prefer: /pro/iu, provider: "deepseek" },
  { key: "OPENROUTER_API_KEY", kind: "perplexity_search", name: "perplexity", prefer: /flash/iu, provider: "openrouter" },
  { key: "OPENAI_API_KEY", kind: "web_search", name: "openai", prefer: /luna/iu, provider: "openai" },
  { key: "GEMINI_API_KEY", kind: "gemini_google_search", name: "google", prefer: /flash-lite|flash/iu, provider: "gemini" }
];

const ASKED_TO_SEARCH = "Найди в интернете, какая сейчас последняя стабильная (не LTS-only) версия Node.js. " +
  "Ответь одним коротким предложением и дай ссылку на источник.";
const NOT_ASKED = "Какой официальный курс доллара США установил ЦБ РФ на сегодня?";

let model: PaidAnswerModel | null = null;
const sources = new Map<string, AdminSearchIntegration>();
const chats: string[] = [];
let shownChatId: string | null = null;

async function searchEvidence(run: ModelRun) {
  const calls = await prisma.modelRunToolCall.findMany({ orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }],
    select: { state: true, toolName: true }, where: { modelRunId: run.id } });
  const searchRuns = await prisma.searchRun.findMany({ select: { artifacts: true, status: true, strategyId: true },
    where: { modelRunId: run.id } });
  const usage = await prisma.usageEvent.findMany({ select: { estimatedCostMicros: true, purpose: true },
    where: { modelRunId: run.id } });
  return {
    calls: calls.map((call) => `${call.toolName}:${call.state}`),
    searchCalls: calls.filter((call) => /^search_(?:selected_engines|engine_[1-3])$/u.test(call.toolName)).length,
    searchRuns: searchRuns.map((row) => ({ sources: Array.isArray((row.artifacts as { sources?: unknown })?.sources)
      ? ((row.artifacts as { sources: unknown[] }).sources).length : 0, status: row.status, strategyId: row.strategyId })),
    webSearchUsageRows: usage.filter((row) => row.purpose === "web_search").length,
    webSearchCostKnown: usage.some((row) => row.purpose === "web_search" && row.estimatedCostMicros !== null)
  };
}

async function answerHasLink(run: ModelRun): Promise<boolean> {
  const message = run.assistantMessageId
    ? await prisma.message.findUnique({ select: { content: true }, where: { id: run.assistantMessageId } }) : null;
  return /https?:\/\//u.test(JSON.stringify(message?.content ?? ""));
}

async function shots(page: Page, testInfo: TestInfo, name: string, prepare: (page: Page) => Promise<void>): Promise<void> {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });
    await prepare(page);
    await expectNoHorizontalOverflow(page);
    const path = testInfo.outputPath(`${name}-${viewport.name}.png`);
    await page.screenshot({ path });
  }
}

async function touchShot(browser: Browser, baseURL: string, testInfo: TestInfo, name: string, path: string,
  prepare: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ baseURL, deviceScaleFactor: 2, hasTouch: true, isMobile: true, reducedMotion: "reduce",
    viewport: { height: 844, width: 390 } });
  try {
    await authenticateWithLocalToken(context.request);
    const phone = await context.newPage();
    await phone.goto(path, { timeout: 600_000 });
    await expect(phone.getByTestId("app-shell")).toBeVisible({ timeout: 120_000 });
    await prepare(phone);
    await expectNoHorizontalOverflow(phone);
    await phone.screenshot({ path: testInfo.outputPath(`${name}-touch-phone.png`) });
  } finally {
    await context.close();
  }
}

test("engines are set up and every keyed engine answers with sources", async ({ request }, testInfo) => {
  test.setTimeout(90 * 60_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  await authenticateWithLocalToken(request);
  const summary: Record<string, unknown> = {};
  model = await setupCodexLbAnswerModel(request, { label: "Search engines", nativeSearch: false,
    preferredModel: paidEnv("AIQSA_FEATURES_CODEX_MODEL") });
  summary.answerModel = model.upstreamModelId;
  for (const engine of ENGINES) {
    const secret = paidEnv(engine.key);
    if (!secret) { summary[engine.name] = "skipped: no key"; continue; }
    const connectionId = await quickSetupConnection(request, engine.provider, secret, engine.prefer, { reuse: false });
    const source = await connectionSearchSource(request, connectionId, engine.kind);
    sources.set(engine.name, source);
    await waitForCatalogModel(request, model.connectionId, (candidate) => candidate.modelId === model!.modelId &&
      candidate.searchStrategyIds.includes(source.strategyId));
    const chatId = await newExcludedChat(request, `Search ${engine.name} ${randomUUID().slice(0, 8)}`);
    chats.push(chatId);
    const run = await completedPaidTurn(request, prisma, { chatId, model, searchOptionIds: [source.strategyId], text: ASKED_TO_SEARCH });
    const evidence = await searchEvidence(run);
    summary[engine.name] = { ...evidence, answerHasLink: await answerHasLink(run), readiness: source.readiness, status: run.status };
    if (engine.name === "deepseek-search-api" || !shownChatId) shownChatId = chatId;
    expect.soft(evidence.searchCalls, `${engine.name}: the model searched`).toBeGreaterThanOrEqual(1);
    expect.soft(evidence.searchRuns.some((row) => row.status === "complete" && row.sources > 0),
      `${engine.name}: a Search call completed with sources`).toBe(true);
    expect.soft(evidence.webSearchUsageRows, `${engine.name}: the search was accounted`).toBeGreaterThanOrEqual(1);
  }
  await testInfo.attach("search-engines-summary.json", { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
  process.stdout.write(`search_engines_paid_summary ${JSON.stringify(summary)}\n`);
  expect(sources.size, "at least one engine was keyed").toBeGreaterThanOrEqual(1);
});

test("two engines answer one search together, and the model searches a time-sensitive question unasked", async ({ request }, testInfo) => {
  test.setTimeout(30 * 60_000);
  test.skip(!model || sources.size === 0, "no answer model or engine");
  await authenticateWithLocalToken(request);
  const summary: Record<string, unknown> = {};
  const pair = [sources.get("deepseek-search-api"), sources.get("perplexity") ?? sources.get("openai") ?? sources.get("google")]
    .filter((source): source is AdminSearchIntegration => Boolean(source));
  if (pair.length === 2) {
    const chatId = await newExcludedChat(request, `Search fan-out ${randomUUID().slice(0, 8)}`);
    chats.push(chatId);
    const run = await completedPaidTurn(request, prisma, { chatId, model: model!, searchMode: "all_selected",
      searchOptionIds: pair.map((source) => source.strategyId), text: ASKED_TO_SEARCH });
    const evidence = await searchEvidence(run);
    summary.fanOut = evidence;
    expect.soft(new Set(evidence.searchRuns.filter((row) => row.status === "complete" && row.sources > 0)
      .map((row) => row.strategyId)).size, "both engines answered").toBe(2);
  }
  const first = [...sources.values()][0]!;
  const chatId = await newExcludedChat(request, `Search unasked ${randomUUID().slice(0, 8)}`);
  chats.push(chatId);
  const run = await completedPaidTurn(request, prisma, { chatId, model: model!, searchOptionIds: [first.strategyId], text: NOT_ASKED });
  const evidence = await searchEvidence(run);
  summary.unasked = { ...evidence, answerHasLink: await answerHasLink(run) };
  await testInfo.attach("search-fanout-summary.json", { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
  process.stdout.write(`search_fanout_paid_summary ${JSON.stringify(summary)}\n`);
  expect.soft(evidence.searchCalls, "the model searched a time-sensitive question on its own").toBeGreaterThanOrEqual(1);
});

test("Search controls and answer sources at every size", async ({ page, browser, baseURL }, testInfo) => {
  test.setTimeout(30 * 60_000);
  test.skip(!shownChatId, "no answered chat to show");
  await page.goto("/", { timeout: 600_000 });
  await authenticateWithLocalToken(page.request);

  // An answer with its sources.
  await shots(page, testInfo, "01-answer-sources", async (current) => {
    await current.goto(`/c/${shownChatId}`, { timeout: 600_000 });
    const toggle = current.getByTestId("answer-sources-toggle").last();
    await expect(toggle).toBeVisible({ timeout: 120_000 });
    await toggle.click();
    await expect(current.getByTestId("answer-sources").last()).toBeVisible();
    await current.getByTestId("answer-sources").last().scrollIntoViewIfNeeded();
  });

  // The composer's Search chip, open.
  await shots(page, testInfo, "02-search-chip", async (current) => {
    await current.goto(`/c/${shownChatId}`, { timeout: 600_000 });
    await current.getByRole("button", { name: /^Choose web search/u }).click();
    await expect(current.getByRole("dialog", { name: "Web search" })).toBeVisible();
  });

  // Chat defaults: the Web search row and the turn-off confirmation, which is cancelled.
  await shots(page, testInfo, "03-chat-defaults-turn-off", async (current) => {
    await current.goto("/?library=defaults", { timeout: 600_000 });
    const settings = current.getByTestId("library-v2");
    await expect(settings).toBeVisible({ timeout: 120_000 });
    const summary = settings.getByLabel("Web search default");
    await summary.click();
    await settings.getByRole("button", { name: "Turn off web search" }).click();
    await expect(current.getByRole("dialog", { name: "Turn off web search" })).toBeVisible();
  });
  await page.getByRole("dialog", { name: "Turn off web search" }).getByRole("button", { name: "Keep search on" }).click();

  // Administrator Search: sources and the recommendation.
  await shots(page, testInfo, "04-admin-search", async (current) => {
    await current.goto("/admin?section=search", { timeout: 600_000 });
    await expect(current.getByTestId("admin-search-plan")).toBeVisible({ timeout: 120_000 });
  });

  await touchShot(browser, baseURL!, testInfo, "05-search-chip", `/c/${shownChatId}`, async (phone) => {
    await phone.getByRole("button", { name: /^Choose web search/u }).click();
    await expect(phone.getByRole("dialog", { name: "Web search" })).toBeVisible();
  });
  for (const chatId of chats) await deletePaidChat(page.request, chatId);
});
