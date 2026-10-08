import { describe, expect, it } from "vitest";
import { createFakeProviderAdapter } from "./fakeProvider";
import type { ProviderRunRequest, ProviderRunResult } from "./types";

const submit = { capability: "session", description: "Submit the review", inputSchema: { type: "object" }, name: "submit_answer_review" };
const decide = { capability: "session", description: "Record decisions", inputSchema: { type: "object" }, name: "record_review_decisions" };
const lookup = { capability: "mcp", description: "Look up a record", inputSchema: { type: "object" }, name: "mcp_records_lookup_0123456789" };
const done = { content: [{ type: "text", text: "ok" }], status: "complete", type: "fake_tool_result" };

/** A step's request: the chat's question and answer, then the server's turn. */
function request(question: string, turn: string, tools: unknown[], providerToolMessages: unknown[] = []): ProviderRunRequest {
  const text = (value: string) => ({ blocks: [{ text: value, type: "text" }] });
  return {
    content: text(turn),
    context: { messages: [
      { content: text(question), id: "question", role: "user" },
      { content: text("The answer is 42."), id: "answer", role: "assistant" },
      { content: text(turn), id: "turn", role: "user" }
    ] },
    providerToolMessages,
    searchPlan: { mode: "all_selected", options: [] },
    tools
  } as unknown as ProviderRunRequest;
}

async function run(input: ProviderRunRequest): Promise<ProviderRunResult> {
  const stream = createFakeProviderAdapter().stream(input);
  let next = await stream.next();
  while (!next.done) next = await stream.next();
  return next.value;
}

describe("fake provider answer review scenario", () => {
  it("reports one finding through the step's tool, then says so", async () => {
    const asked = await run(request("What is it? [AIQSA_REVIEW_E2E:findings]", "Review the answer.", [submit]));
    expect(asked.toolCalls).toEqual([{ arguments: { findings: [expect.objectContaining({ id: "F1", severity: "high" })],
      verdict: "changes_needed" }, id: "fake-submit-review", name: "submit_answer_review" }]);
    expect((await run(request("What is it? [AIQSA_REVIEW_E2E:findings]", "Review the answer.", [submit], [done]))).finalText)
      .toBe("Review submitted: one finding.");
  });

  it("reports no issues by default and never reports when told to skip", async () => {
    expect((await run(request("What is it?", "Review the answer.", [submit]))).toolCalls?.[0]?.arguments)
      .toEqual({ findings: [], verdict: "clean" });
    const skipped = await run(request("What is it? [AIQSA_REVIEW_E2E:skip]", "Review the answer.", [submit]));
    expect(skipped.toolCalls ?? []).toEqual([]);
    expect(skipped.finalText).toBe("The answer looks fine to me.");
  });

  it("first calls the run's MCP tool when the directive names one", async () => {
    const question = "What is it? [AIQSA_REVIEW_E2E:mcp:lookup:r-1]";
    expect((await run(request(question, "Review the answer.", [submit, lookup]))).toolCalls)
      .toEqual([{ arguments: { id: "r-1" }, id: "fake-review-mcp-r-1", name: lookup.name }]);
    expect((await run(request(question, "Review the answer.", [submit, lookup], [done]))).toolCalls?.[0]?.name).toBe("submit_answer_review");
  });

  it("decides every finding key of the revision turn, then writes the revised answer", async () => {
    const turn = "Decide [R1.1.F1] and [R1.2.F1], and [R1.1.F1] again.";
    const asked = await run(request("What is it? [AIQSA_REVIEW_E2E:findings]", turn, [decide]));
    expect(asked.toolCalls?.[0]).toMatchObject({ name: "record_review_decisions", arguments: { decisions: [
      expect.objectContaining({ decision: "accepted", findingId: "R1.1.F1" }),
      expect.objectContaining({ decision: "accepted", findingId: "R1.2.F1" })
    ] } });
    const rejected = await run(request("What is it? [AIQSA_REVIEW_E2E:reject]", turn, [decide]));
    expect(rejected.toolCalls?.[0]?.arguments.decisions).toEqual(expect.arrayContaining([expect.objectContaining({ decision: "rejected" })]));
    expect((await run(request("What is it?", turn, [decide], [done]))).finalText)
      .toBe("Revised answer: the figure is verified and its source is named.");
  });

  it("leaves runs without a step's tool to the other scenarios", async () => {
    const plain = await run(request("What is it? [AIQSA_REVIEW_E2E:findings]", "Thanks", []));
    expect(plain.toolCalls ?? []).toEqual([]);
    expect(plain.finalText).not.toContain("Review submitted");
  });
});
