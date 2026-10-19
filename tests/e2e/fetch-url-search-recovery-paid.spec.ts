/**
 * Opt-in, paid, bounded end-to-end check that a page link the answer model
 * composed itself is skipped quietly and the model turns to web search
 * instead of asking the user for it. Never a default lane: it runs only with
 * AIQSA_FETCH_URL_PAID_E2E=DISPOSABLE on a disposable stand with egress, and
 * needs CODEX_LB_API_KEY + CODEX_LB_BASE_URL (the Codex root ending in
 * `/backend-api/codex`) for the answer model and OPENROUTER_API_KEY for the
 * Perplexity Search source.
 *
 * The prompt spells the address in words, so no link in the user's text
 * authorizes it: the model writes the link, the page reader refuses it, and
 * the refusal tells a run with Search to find the page there. One turn; the
 * prompt allows one search. Oracles are the stand's database and the Process
 * rows, never the model's wording; prompts, answers and keys are never
 * printed. The attached summary holds counts and booleans only.
 */
import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { journeyRunParams } from "../../scripts/context-compaction-journey-support";
import { signInWithLocalToken } from "./support/localAuth";
import {
  completedPaidTurn,
  connectionSearchSource,
  deletePaidChat,
  newExcludedChat,
  openRouterConnection,
  paidEnv,
  setupCodexLbAnswerModel,
  waitForCatalogModels,
  type PaidAnswerModel
} from "./support/paidProviders";

const prisma = new PrismaClient();
const enabled = process.env.AIQSA_FETCH_URL_PAID_E2E === "DISPOSABLE";

test.skip(!enabled, "paid: requires AIQSA_FETCH_URL_PAID_E2E=DISPOSABLE on a disposable stand");
// A retry would pay for the turn again.
test.describe.configure({ retries: 0 });
test.afterAll(() => prisma.$disconnect());

const SPELLED_ADDRESS_PROMPT = "I want Digi Spain's current fibre plus mobile bundle prices. Their tariffs page is at " +
  "www dot digi dot es slash tarifas slash fibra-movil; write it as a normal https address and read it with the page " +
  "reader first. If the reader refuses it, follow the reader's guidance. Use web search at most once, with a single " +
  "query. Then answer in two short sentences.";

type FetchFacts = Readonly<{ outcome?: unknown; url?: unknown }>;

function fetchFacts(result: unknown): FetchFacts | null {
  const preview = typeof result === "object" && result !== null ? (result as { rawPreview?: { fetchUrl?: FetchFacts } }).rawPreview : null;
  return preview?.fetchUrl ?? null;
}

test("a link the model composed is skipped, sends the model to web search and shows as a neutral step", async ({ page }, testInfo) => {
  const openRouterKey = paidEnv("OPENROUTER_API_KEY");
  test.skip(!openRouterKey || !paidEnv("CODEX_LB_API_KEY") || !paidEnv("CODEX_LB_BASE_URL"),
    "paid: OPENROUTER_API_KEY, CODEX_LB_API_KEY and CODEX_LB_BASE_URL are required");
  test.setTimeout(1_800_000);
  await signInWithLocalToken(page);
  const request = page.request;
  const summary: Record<string, unknown> = {};

  const searchConnection = await openRouterConnection(request, openRouterKey!);
  const source = await connectionSearchSource(request, searchConnection, "perplexity_search",
    { preferModel: /sonar|perplexity/iu, protocol: "openrouter_perplexity_chat" });
  const codex = await setupCodexLbAnswerModel(request, { label: "Page reader recovery", nativeSearch: false });
  const codexCanSearch = (await waitForCatalogModels(request, codex.connectionId, (candidate) => candidate.modelId === codex.modelId))
    .some((candidate) => candidate.searchStrategyIds.includes(source.strategyId));
  summary.answerRoute = codexCanSearch ? "codex-lb" : "openrouter";
  let model: PaidAnswerModel = codex;
  if (!codexCanSearch) {
    // A Search source a codex-lb model cannot use: an OpenRouter answer model that can.
    const answer = (await waitForCatalogModels(request, searchConnection, (candidate) =>
      candidate.capabilities.toolCalling === true && candidate.searchStrategyIds.includes(source.strategyId) &&
      !/perplexity|sonar/iu.test(candidate.upstreamModelId ?? candidate.displayName)))[0]!;
    model = { connectionId: searchConnection, displayName: answer.displayName, modelId: answer.modelId,
      params: journeyRunParams(answer, 512), upstreamModelId: answer.upstreamModelId ?? answer.modelId };
  }

  const chatId = await newExcludedChat(request, "Page reader recovery check");
  try {
    const run = await completedPaidTurn(request, prisma, { chatId, model, searchOptionIds: [source.strategyId], text: SPELLED_ADDRESS_PROMPT });
    const calls = await prisma.modelRunToolCall.findMany({
      orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }],
      select: { result: true, roundIndex: true, toolName: true }, where: { modelRunId: run.id }
    });
    const fetches = calls.filter((call) => call.toolName === "fetch_url").map((call) => ({ ...call, facts: fetchFacts(call.result) }));
    const refused = fetches.find((call) => call.facts?.outcome === "fetch_url_not_in_conversation");
    const searches = calls.filter((call) => call.toolName.startsWith("search_"));
    summary.toolCalls = calls.length;
    summary.fetchCalls = fetches.length;
    summary.refusedFetch = Boolean(refused);
    summary.searchCalls = searches.length;
    summary.searchAfterRefusal = Boolean(refused && searches.some((call) => call.roundIndex > refused.roundIndex));
    summary.readAfterSearch = fetches.some((call) => call.facts?.outcome === "read" &&
      searches.some((search) => search.roundIndex < call.roundIndex));
    summary.searchRuns = await prisma.searchRun.count({ where: { modelRunId: run.id } });

    expect(refused, "the model composed the spelled address and the page reader refused it").toBeTruthy();
    expect(summary.searchAfterRefusal, "after the refusal the model searched instead of asking the user").toBe(true);

    for (const size of [{ height: 844, name: "phone", width: 390 }, { height: 900, name: "desktop", width: 1440 }] as const) {
      await page.setViewportSize(size);
      await page.goto(`/c/${chatId}`);
      const disclosure = page.getByTestId("tool-activity-disclosure").last();
      await expect(disclosure).toBeVisible({ timeout: 60_000 });
      if (!(await disclosure.evaluate((element) => (element as HTMLDetailsElement).open))) await disclosure.locator("summary").click();
      const skipped = disclosure.locator(".v2-answer-process-steps > li").filter({ hasText: /^Skipped (www\.)?digi\.es/u });
      await expect(skipped.first()).toBeVisible();
      await expect(skipped.first().locator(".v2-answer-process-mark")).toHaveAttribute("data-status", "cancelled");
      await expect(skipped.first()).not.toContainText("Failed");
      await skipped.first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`skipped-link-${size.name}.png`) });
    }
  } finally {
    await testInfo.attach("fetch-url-search-recovery-summary.json", { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
    console.log(`fetch_url_search_recovery_paid_summary ${JSON.stringify(summary)}`);
    await deletePaidChat(request, chatId);
  }
});
