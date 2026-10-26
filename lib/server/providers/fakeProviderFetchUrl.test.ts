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
    expect(first.toolCalls).toEqual([{ arguments: { url: "http://127.0.0.1/e2e-page" }, id: "fake-fetch-url-0", name: "fetch_url" }]);
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

  it("gives each turn's call its own id, so the engine pairs a later turn's result with its own call", async () => {
    const asked = (text: string) => ({ currentInput: true as const, text, type: "user" as const });
    const historyRequest = (history: readonly unknown[]) =>
      ({ ...request(""), history, providerToolMessages: undefined }) as unknown as ProviderRunRequest;
    const first = await run(historyRequest([asked("Read http://127.0.0.1/e2e-page [AIQSA_FETCH_URL_E2E:first_link]")]));
    const firstId = first.toolCalls?.[0]?.id;
    const second = await run(historyRequest([
      { text: "Read http://127.0.0.1/e2e-page [AIQSA_FETCH_URL_E2E:first_link]", type: "user" },
      { arguments: "{}", callId: firstId, name: "fetch_url", type: "tool_call" },
      { callId: firstId, isError: true, name: "fetch_url", output: "{\"error\":\"fetch_blocked_address\"}", type: "tool_result" },
      { text: "Page reading finished: fetch_blocked_address.", type: "assistant_text" },
      asked("Summarize [AIQSA_FETCH_URL_E2E:unlisted]")
    ]));
    expect(second.toolCalls?.[0]).toMatchObject({ arguments: { url: "https://unlisted.example/private" }, name: "fetch_url" });
    expect(second.toolCalls?.[0]?.id).not.toBe(firstId);
  });

  it("never answers a context summary request with the scenario, even when the history holds its marker", async () => {
    // A summary request carries no tools; the fake provider answers in plain text,
    // which is no summary object, so fake specs must fit their window (see workspaceFixture).
    const { tools: _tools, ...withoutTools } = request("<context-source>\nRead http://127.0.0.1/e2e-page " +
      "[AIQSA_FETCH_URL_E2E:first_link]\n</context-source>");
    const summary = await run({ ...withoutTools, toolMode: "none" } as ProviderRunRequest);
    expect(summary.toolCalls ?? []).toEqual([]);
    expect(summary.finalText).toMatch(/^Fake answer: /u);
  });
});
