import { describe, expect, it, vi } from "vitest";
import { RESEARCH_TASK_LIMITS, RESEARCHER_CONTEXT_CLEARING } from "../../contracts/research";
import { CALL_SUBAGENT_TOOL_NAME } from "../../contracts/subagents";
import { MODEL_CALL_RESEARCH_RETRY } from "../engine/modelCall";
import type { PrepareRunSubagentsInput } from "../engine/subagents/runSubagents";
import type { EngineTool } from "../engine/toolRegistry";
import { createResearchTurns } from "./turns";

/** What each kind of turn's host is built from: the run's own sub-agents' parts, with what that kind adds. */
const hosts = vi.hoisted(() => [] as PrepareRunSubagentsInput[]);
vi.mock("../engine/subagents/runSubagents", () => ({
  prepareRunSubagents: vi.fn(async (input: PrepareRunSubagentsInput) => {
    hosts.push(input);
    return null;
  })
}));

function turns() {
  hosts.length = 0;
  const store = { find: vi.fn(async () => null) };
  const subagentInput = {
    admittedRequest: { modelId: "fake-qsa", prompt: { developer: null, system: "Be brief." }, reasoningEffort: null },
    branchRunIds: [],
    buildRegistry: vi.fn(),
    chatId: "chat",
    deadlineAt: Date.now() + 60_000,
    engine: { subagentThreads: store, toolCalls: {} },
    runContextItems: [],
    runId: "run",
    scope: { userId: "user" },
    snapshot: { connectionId: "connection-1", model: { upstreamModelId: "fake-qsa" }, providerModelId: "model-1" },
    toolState: { calls: 0 }
  } as unknown as PrepareRunSubagentsInput;
  const notSet = Promise.resolve({ kind: "not_set" as const });
  return createResearchTurns({ researcherChoice: notSet, subagentInput, userMessage: "Choose.", verifierChoice: notSet });
}

describe("each kind of research turn's host", () => {
  it("gives researchers the task budget and the clearing, and no gate either: a gate's calls are the server's check", async () => {
    const research = turns();
    const signal = new AbortController().signal;
    const tool = { definition: { name: CALL_SUBAGENT_TOOL_NAME } } as unknown as EngineTool;
    await research.researcherCall(tool, { call: { arguments: { message: "Find the options.", name: "options" }, id: "call-1", name: CALL_SUBAGENT_TOOL_NAME },
      ordinal: 0, persistedToolCallId: "row-1", round: 1, signal });
    for (const [model, name] of [["main", "skeptic"], ["verifier", "verifier"], ["main", "gap-judge"]] as const) {
      await research.run({ brief: "Check it.", instructions: "i", model, name, tools: [] }, { attempt: 1, round: 1, signal });
    }
    expect(hosts).toHaveLength(4);
    const [researcher, ...gates] = hosts;
    expect(researcher).toMatchObject({ resultClearing: RESEARCHER_CONTEXT_CLEARING, turnToolCalls: RESEARCH_TASK_LIMITS.toolCalls });
    for (const gate of gates) {
      expect(gate).not.toHaveProperty("turnToolCalls");
      expect(gate).not.toHaveProperty("resultClearing");
    }
    // Researchers and gates alike keep sending a failed model request again for the research window.
    for (const host of hosts) expect(host.modelRetry).toBe(MODEL_CALL_RESEARCH_RETRY);
  });
});
