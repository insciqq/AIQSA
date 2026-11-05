import { describe, expect, it, vi } from "vitest";
import { toolResultOutputText } from "../engine/toolResults";
import type { ResearchEvidenceRepository } from "../research/evidenceRepository";
import { createResearchEvidenceStore } from "../research/evidenceStore";
import { checkQuotes } from "../research/quoteCheck";
import { createResearchSources } from "../research/sources";
import { extractPage } from "../webFetch/extract";
import { WebFetchError } from "../webFetch/transport";
import { fetchUrlDigest } from "../webFetch/urls";
import { BOT_CHECK_PAGES, CAPTCHA_ARTICLES, htmlPage } from "./botCheckPage.testFixtures";
import { createFetchUrlSession, type FetchUrlSessionDeps } from "./fetchUrl";
import type { ToolExecutionResult } from "./types";

const url = "https://page.example/item";
const signal = new AbortController().signal;
const call = { arguments: { url }, id: "call", name: "fetch_url" };
const response = (html: string) => ({ body: new TextEncoder().encode(html), contentType: "text/html; charset=utf-8", finalUrl: url, status: 200 });
const session = (html: string, options: Partial<FetchUrlSessionDeps> = {}) => createFetchUrlSession({
  browserStep: () => "user", extractPage: async (input) => extractPage(input), fetchPage: vi.fn(async () => response(html)),
  plan: { userUrlDigests: [fetchUrlDigest(url)], version: 1 }, scheduled: false, ...options
});
const json = (result: ToolExecutionResult) => {
  const content = result.content[0];
  if (content?.type !== "json") throw new Error("Expected JSON.");
  return content.value as Record<string, unknown>;
};

describe.each([false, true])("a bot check in fetch_url (research: %s)", (researching) => {
  const research = async () => researching ? new Map<string, string>() : null;

  it.each(BOT_CHECK_PAGES)("refuses $name with the same next step as an HTTP refusal", async ({ html }) => {
    const result = await session(html, { research }).execute(call, { signal });
    expect(result.status).toBe("error");
    expect(json(result)).toMatchObject({ error: "fetch_http_status", httpStatus: 200 });
    expect(json(result)).not.toHaveProperty("text");
    expect(json(result)).not.toHaveProperty("title");
    expect(result.rawPreview).toMatchObject({ fetchUrl: { dispatched: true, httpStatus: 200, outcome: "fetch_http_status" } });
    const message = String(json(result).message);
    const refusal = await session(html, { research, fetchPage: async () => { throw new WebFetchError("fetch_http_status", { dispatched: true, httpStatus: 403 }); } })
      .execute(call, { signal });
    expect(message).toBe(String(json(refusal).message).replace("The site answered with HTTP status 403", "The site returned a bot check instead of the page"));
    expect(message).toContain("Workspace browser");
    expect(message.includes("browser_handoff")).toBe(!researching);
  });

  it.each(CAPTCHA_ARTICLES)("returns $name as page text", async ({ html, quote }) => {
    const result = await session(html, { research }).execute(call, { signal });
    expect(result.status).toBe("complete");
    expect(json(result).text).toContain(quote);
  });

  it("does not cache the challenge as a read or close the site", async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce(response(BOT_CHECK_PAGES[0].html))
      .mockResolvedValueOnce(response(htmlPage("Current offer", "<p>The current price is 42.</p>")));
    const reader = session("", { fetchPage, research });
    expect((await reader.execute(call, { signal })).status).toBe("error");
    expect(json(await reader.execute(call, { signal })).text).toBe("The current price is 42.");
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});

describe("bot checks never become research evidence", () => {
  it.each([
    ...BOT_CHECK_PAGES.map((fixture) => ({ ...fixture, blocked: true, quote: "Please wait while the connection is checked." })),
    ...CAPTCHA_ARTICLES.map((fixture) => ({ ...fixture, blocked: false }))
  ])("keeps no challenge page or quote source for $name, but preserves articles", async ({ blocked, html, quote }) => {
    const result = await session(html, { research: async () => new Map() }).execute(call, { signal });
    const run = { branchRunIds: [], chatId: "chat", researchRunId: "run", runId: "run", userId: "user" };
    const savedResults = { read: vi.fn(async () => null) };
    const sources = createResearchSources({ ...run, run, savedResults, items: () => [
      { arguments: JSON.stringify(call.arguments), callId: call.id, id: "call-item", kind: "tool_call", name: call.name },
      { callId: call.id, id: "result-item", kind: "tool_result", name: call.name, outcome: result.status, output: toolResultOutputText(result) }
    ], threads: { backgroundRunIds: async () => [], threadEffectItems: async () => [] } });
    const opened = await sources.opened(signal);
    expect(opened).toHaveLength(blocked ? 0 : 1);
    expect(checkQuotes([{ quote, url }], opened)[0]?.status).toBe(blocked ? "unsupported" : "found");

    const append = vi.fn<ResearchEvidenceRepository["append"]>(async (_scope, write) => ({ kind: "recorded", record: {
      ...write.record, author: write.author, createdAt: "2026-11-05T00:00:00.000Z", id: "record", pageId: write.page ? "page" : null,
      publishedOn: null, quoteCheck: write.quoteCheck.kept, registrableDomain: null, runId: "run", sequence: 0, textGroupKey: null
    } }));
    // Feed even the failed call to the store: production also filters these out by their persisted state.
    const row = { arguments: call.arguments, id: "row", observationId: null, providerCallId: call.id, result, toolName: call.name };
    const evidence = createResearchEvidenceStore({ repository: {
      agentCalls: () => ({ calls: async () => [row], fetchCalls: async () => [row], recentCalls: async () => [] }), append,
      chain: async () => ["run"], page: async () => null, records: async () => [], supersessions: async () => new Map()
    }, savedResults, threads: { backgroundRunIds: async () => [] } })({
      ...run, extendTurn: () => undefined, now: () => 0, sources, turnEndsAt: () => 60_000, userFollowups: async () => [], userMessage: "Read the page."
    });
    await evidence.record({ author: { name: "reader", threadId: null }, record: {
      claim: quote, criterionKey: null, kind: "finding", quote, rowKey: null, sourceClass: "primary_official", standing: "claimed", supersedes: null, url
    } }, signal);
    expect(append).toHaveBeenCalledOnce();
    const write = append.mock.calls[0]![1];
    if (blocked) {
      expect(write.page).toBeNull();
      expect(write.quoteCheck.kept?.status).toBe("unsupported");
    } else {
      expect(write.page).toMatchObject({ obtainedBy: "tool", text: expect.stringContaining(quote), url });
      expect(write.quoteCheck.kept?.status).toBe("found");
    }
    expect(savedResults.read).not.toHaveBeenCalled();
  });
});
