import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeResearchPlanProposal, decodeResearchStart, PROPOSE_RESEARCH_PLAN_TOOL_NAME, START_RESEARCH_TOOL_NAME } from "../../contracts/research";
import { createFakeProviderAdapter } from "./fakeProvider";
import type { ProviderHistoryItem } from "./history";
import type { ProviderRunRequest, ProviderRunResult } from "./types";

const question = "Find the quietest kettle [AIQSA_RESEARCH_PLAN_E2E:0]";
const tools = [START_RESEARCH_TOOL_NAME, PROPOSE_RESEARCH_PLAN_TOOL_NAME].map((name) => ({ capability: "harness", description: name, inputSchema: { type: "object" }, name }));

afterEach(() => vi.unstubAllEnvs());

function request(results: readonly string[] = []): ProviderRunRequest {
  const history: ProviderHistoryItem[] = [{ currentInput: true, text: question, type: "user" },
    ...results.map((output, index) => ({ callId: `fake-research-0-${index}`, name: "tool", output, type: "tool_result" as const }))];
  return { content: { blocks: [{ text: question, type: "text" }] }, history, searchPlan: { mode: "all_selected", options: [] }, tools } as unknown as ProviderRunRequest;
}

async function run(input: ProviderRunRequest, signal?: AbortSignal): Promise<ProviderRunResult> {
  const stream = createFakeProviderAdapter().stream(input, { signal });
  let next = await stream.next();
  while (!next.done) next = await stream.next();
  return next.value;
}

describe("fake provider research plan scenario", () => {
  it("starts, proposes a plan the server accepts, and proposes again only for a changed plan", async () => {
    vi.stubEnv("AIQSA_TEST_MODE", "1");
    const [start] = (await run(request())).toolCalls ?? [];
    expect(start?.name).toBe(START_RESEARCH_TOOL_NAME);
    expect(decodeResearchStart(start?.arguments).ok).toBe(true);
    const [proposal] = (await run(request(["{}"]))).toolCalls ?? [];
    expect(proposal?.name).toBe(PROPOSE_RESEARCH_PLAN_TOOL_NAME);
    expect(decodeResearchPlanProposal(proposal?.arguments).ok).toBe(true);
    const [rebuilt] = (await run(request(["{}", '{"status":"released","changed":true}']))).toolCalls ?? [];
    expect(rebuilt?.name).toBe(PROPOSE_RESEARCH_PLAN_TOOL_NAME);
    expect(rebuilt?.id).toBe("fake-research-0-2");
  });

  it("then waits for Stop", async () => {
    vi.stubEnv("AIQSA_TEST_MODE", "1");
    await expect(run(request(["{}", '{"status":"released","changed":false}']), AbortSignal.timeout(20))).rejects.toThrow("provider_run_aborted");
  });

  it("never runs outside test mode or in production, or where research is not offered", async () => {
    vi.stubEnv("AIQSA_TEST_MODE", "0");
    expect((await run(request())).toolCalls ?? []).toEqual([]);
    vi.stubEnv("AIQSA_TEST_MODE", "1");
    vi.stubEnv("NODE_ENV", "production");
    expect((await run(request())).toolCalls ?? []).toEqual([]);
    vi.unstubAllEnvs();
    vi.stubEnv("AIQSA_TEST_MODE", "1");
    expect((await run({ ...request(), tools: [] })).toolCalls ?? []).toEqual([]);
  });
});
