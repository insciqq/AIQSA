/**
 * Opt-in, paid, bounded end-to-end check of web search accounting on a
 * DISPOSABLE stand. Never a default lane: it runs only with
 * AIQSA_BUDGETS_PAID_E2E=DISPOSABLE; each case also needs its key and skips
 * with a reason without it.
 *
 * - OpenRouter Perplexity Search (OPENROUTER_API_KEY): the OpenRouter
 *   connection (reused, else Quick Setup) and its Perplexity Search source;
 *   one search-enabled turn on an OpenRouter answer model leaves a
 *   `web_search` row on the run whose cost is known (OpenRouter reports it).
 * - OpenAI native search (OPENAI_API_KEY): the OpenAI connection through
 *   Quick Setup and its hosted web search source; one turn of the cheapest
 *   offered model that searches leaves its billed search count on the
 *   `chat_answer` row, whose cost is the token cost plus count × the model's
 *   per-search price. (codex-lb rejects the hosted web search check with
 *   400, so its models get no native search route to measure.)
 *
 * Each case pays for exactly one turn; the prompt asks for exactly one
 * search. Oracles are the stand's database and HTTP status codes, never the
 * model's wording; prompts, answers and keys are never printed. The attached
 * summaries hold counts, costs in micro-dollars and booleans only.
 */
import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import type { CatalogModel } from "../../lib/contracts/catalog";
import { estimateCostMicros, type TokenUsage } from "../../lib/domain/usage";
import { modelSearchPricing, modelSearchPricingSelect } from "../../lib/server/providers/modelTokenPricing";
import { journeyRunParams } from "../../scripts/context-compaction-journey-support";
import { authenticateWithLocalToken } from "./support/localAuth";
import {
  completedPaidTurn,
  connectionSearchSource,
  deletePaidChat,
  newExcludedChat,
  openRouterConnection,
  paidEnv,
  quickSetupConnection,
  waitForCatalogModels,
  type PaidAnswerModel
} from "./support/paidProviders";

const prisma = new PrismaClient();
const enabled = process.env.AIQSA_BUDGETS_PAID_E2E === "DISPOSABLE";

test.skip(!enabled, "paid: requires AIQSA_BUDGETS_PAID_E2E=DISPOSABLE on a disposable stand");
test.describe.configure({ mode: "serial" });

let userId = "";
test.afterAll(async () => {
  if (userId) await prisma.usageLimit.deleteMany({ where: { userId } });
  await prisma.$disconnect();
});

const ONE_SEARCH_PROMPT = "Use web search exactly once, with a single query, to find the latest stable release number of Node.js. " +
  "Do not search again. Then answer in one short sentence.";

/** Cheaper OpenRouter answer models first; Perplexity models are engines, not answers. */
const OPENROUTER_ANSWER_PREFERENCE = [/flash/iu, /luna(?!-pro)/iu, /deepseek/iu];

function preferredOpenRouterAnswer(models: readonly CatalogModel[]): CatalogModel | null {
  const answers = models.filter((model) => !/perplexity|sonar/iu.test(model.upstreamModelId ?? model.displayName));
  for (const preference of OPENROUTER_ANSWER_PREFERENCE) {
    const match = answers.find((model) => preference.test(model.upstreamModelId ?? model.displayName));
    if (match) return match;
  }
  return answers[0] ?? null;
}

test("OpenRouter Perplexity Search leaves a web_search row with a known reported cost", async ({ request }, testInfo) => {
  const secret = paidEnv("OPENROUTER_API_KEY");
  test.skip(!secret, "paid: OPENROUTER_API_KEY is not set; the OpenRouter Perplexity Search case is skipped");
  test.setTimeout(1_800_000);
  await authenticateWithLocalToken(request);
  userId = (await (await request.get("/api/me")).json()).user.id as string;
  await prisma.usageLimit.deleteMany({ where: { userId } });
  const summary: Record<string, unknown> = {};

  const connectionId = await openRouterConnection(request, secret!);
  const source = await connectionSearchSource(request, connectionId, "perplexity_search",
    { preferModel: /sonar|perplexity/iu, protocol: "openrouter_perplexity_chat" });
  summary.sourceEnabled = source.enabled;
  const answer = preferredOpenRouterAnswer(await waitForCatalogModels(request, connectionId,
    (candidate) => candidate.capabilities.toolCalling === true && candidate.searchStrategyIds.includes(source.strategyId)));
  expect(answer, "an OpenRouter answer model can use the Perplexity Search source").not.toBeNull();
  const model: PaidAnswerModel = {
    connectionId, displayName: answer!.displayName, modelId: answer!.modelId, params: journeyRunParams(answer!, 512),
    upstreamModelId: answer!.upstreamModelId ?? answer!.modelId
  };
  summary.answerModel = model.upstreamModelId;

  const chatId = await newExcludedChat(request, "Search usage check");
  try {
    const run = await completedPaidTurn(request, prisma, { chatId, model, searchOptionIds: [source.strategyId], text: ONE_SEARCH_PROMPT });
    const rows = await prisma.usageEvent.findMany({ where: { modelRunId: run.id } });
    const searches = rows.filter((row) => row.purpose === "web_search");
    summary.runRows = rows.length;
    summary.webSearchRows = searches.length;
    summary.webSearchOperations = searches.reduce((sum, row) => sum + (row.operationCount ?? 0), 0);
    summary.webSearchCostMicros = searches.map((row) => row.estimatedCostMicros);
    expect(searches.length, "the search-enabled turn ran the Perplexity Search source").toBeGreaterThan(0);
    for (const row of searches) {
      expect(row.estimatedCostMicros, "OpenRouter reports the cost of a Perplexity Search call").not.toBeNull();
      expect(row.estimatedCostMicros!).toBeGreaterThan(0);
      expect({ chatId: row.chatId, userId: row.userId }).toEqual({ chatId, userId });
    }
  } finally {
    await testInfo.attach("search-openrouter-summary.json", { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
    console.log(`search_openrouter_paid_summary ${JSON.stringify(summary)}`);
    await deletePaidChat(request, chatId);
  }
});

test("OpenAI native search puts its search count and per-search price on the answer row", async ({ request }, testInfo) => {
  const secret = paidEnv("OPENAI_API_KEY");
  test.skip(!secret, "paid: OPENAI_API_KEY is not set; the OpenAI native search case is skipped");
  test.setTimeout(1_800_000);
  await authenticateWithLocalToken(request);
  userId = (await (await request.get("/api/me")).json()).user.id as string;
  await prisma.usageLimit.deleteMany({ where: { userId } });
  const summary: Record<string, unknown> = {};

  const connectionId = await quickSetupConnection(request, "openai", secret!, /luna/iu);
  const source = await connectionSearchSource(request, connectionId, "web_search", { protocol: "openai_responses_web_search" });
  const answer = (await waitForCatalogModels(request, connectionId,
    (candidate) => candidate.searchStrategyIds.includes(source.strategyId)))
    .sort((left, right) => Number(/luna/iu.test(right.displayName)) - Number(/luna/iu.test(left.displayName)))[0]!;
  const model: PaidAnswerModel = {
    connectionId, displayName: answer.displayName, modelId: answer.modelId, params: journeyRunParams(answer, 512),
    upstreamModelId: answer.upstreamModelId ?? answer.modelId
  };
  summary.answerModel = model.upstreamModelId;

  const chatId = await newExcludedChat(request, "Native search usage check");
  try {
    // Model choice admits the source's hosted route: the answer model searches natively.
    const run = await completedPaidTurn(request, prisma, {
      chatId, model, searchMode: "model_choice", searchOptionIds: [source.strategyId], text: ONE_SEARCH_PROMPT
    });
    const rows = await prisma.usageEvent.findMany({ where: { modelRunId: run.id } });
    const answers = rows.filter((row) => row.purpose === "chat_answer");
    summary.runRows = rows.length;
    summary.answerRows = answers.length;
    summary.webSearchRows = rows.filter((row) => row.purpose === "web_search").length;
    const row = answers.find((candidate) => (candidate.webSearchCount ?? 0) > 0);
    summary.answerWebSearchCount = row?.webSearchCount ?? null;
    expect(row, "the answer row carries the provider-reported web search count").toBeTruthy();

    const deployment = await prisma.providerModel.findUniqueOrThrow({ where: { id: row!.providerModelId ?? model.modelId },
      select: modelSearchPricingSelect });
    const pricing = modelSearchPricing(deployment);
    const perThousand = pricing.webSearchPriceUsdPerThousand ?? null;
    summary.webSearchPriceUsdPerThousand = perThousand;
    expect(perThousand, "the OpenAI model carries the catalog per-search price").not.toBeNull();
    expect(perThousand!).toBeGreaterThan(0);
    const usage: TokenUsage = {
      cachedInputTokens: row!.cachedInputTokens, cacheWriteInputTokens: row!.cacheWriteInputTokens,
      completeness: row!.usageCompleteness === "COMPLETE" ? "complete" : row!.usageCompleteness === "PARTIAL" ? "partial" : "unavailable",
      inputTokens: row!.inputTokens, outputTokens: row!.outputTokens, reasoningTokens: row!.reasoningTokens,
      totalTokens: row!.totalTokens, webSearchCount: row!.webSearchCount
    };
    const expected = estimateCostMicros(usage, pricing);
    const tokensOnly = estimateCostMicros({ ...usage, webSearchCount: null }, pricing);
    // USD per thousand searches is a thousandth of the micro-dollars per search.
    const searchFeeMicros = Math.round(row!.webSearchCount! * perThousand! * 1_000);
    Object.assign(summary, { costMicros: row!.estimatedCostMicros, expectedCostMicros: expected, searchFeeMicros, tokensOnlyCostMicros: tokensOnly });
    expect(expected, "the answer usage is complete and priced").not.toBeNull();
    expect(tokensOnly).not.toBeNull();
    expect(row!.estimatedCostMicros, "the stored cost is the token cost plus the search fee").toBe(expected);
    expect(Math.abs(expected! - tokensOnly! - searchFeeMicros), "the cost includes count × the per-search price").toBeLessThanOrEqual(1);
    expect(row!.estimatedCostMicros!).toBeGreaterThanOrEqual(searchFeeMicros);
  } finally {
    await testInfo.attach("search-openai-summary.json", { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
    console.log(`search_openai_paid_summary ${JSON.stringify(summary)}`);
    await deletePaidChat(request, chatId);
  }
});
