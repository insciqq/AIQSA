import { describe, expect, it } from "vitest";
import { fetchUrlTool } from "../tools/fetchUrlPlan";
import { createFakeProviderAdapter } from "./fakeProvider";
import type { ProviderRunRequest, ProviderRunResult } from "./types";

function request(text: string, providerToolMessages: unknown[] = []): ProviderRunRequest {
  return { content: { blocks: [{ text, type: "text" }] }, providerToolMessages, searchPlan: { mode: "all_selected", options: [] },
    tools: [fetchUrlTool] } as unknown as ProviderRunRequest;
}

async function run(input: ProviderRunRequest): Promise<ProviderRunResult> {
  const stream = createFakeProviderAdapter().stream(input);
  let next = await stream.next();
  while (!next.done) next = await stream.next();
  return next.value;
}

describe("fake provider page-reader scenario", () => {
  it("asks for the question's first link, then names the server's outcome", async () => {
    const first = await run(request("Read http://127.0.0.1/e2e-page [AIQSA_FETCH_URL_E2E:first_link]"));
    expect(first.toolCalls).toEqual([{ arguments: { url: "http://127.0.0.1/e2e-page" }, id: "fake-fetch-url-1", name: "fetch_url" }]);
    const refused = { content: [{ type: "json", value: { error: "fetch_blocked_address" } }], status: "error", type: "fake_tool_result" };
    expect((await run(request("Read http://127.0.0.1/e2e-page [AIQSA_FETCH_URL_E2E:first_link]", [refused]))).finalText)
      .toBe("Page reading finished: fetch_blocked_address.");
  });

  it("asks for a link the question never contained and ignores the scenario without the tool", async () => {
    expect((await run(request("Summarize [AIQSA_FETCH_URL_E2E:unlisted]"))).toolCalls?.[0]?.arguments)
      .toEqual({ url: "https://unlisted.example/private" });
    const plain = await run({ ...request("Summarize [AIQSA_FETCH_URL_E2E:unlisted]"), tools: [] });
    expect(plain.toolCalls ?? []).toEqual([]);
  });
});
