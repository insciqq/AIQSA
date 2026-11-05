import { describe, expect, it, vi } from "vitest";
import { RESEARCH_SOURCE_CLASSES, START_RESEARCH_TOOL_NAME } from "../../contracts/research";
import { CALL_SUBAGENT_TOOL_NAME } from "../../contracts/subagents";
import type { EngineTool, EngineToolExecution } from "../engine/toolRegistry";
import type { TranscriptItem } from "../engine/transcript";
import { researchMatrixCoverage } from "./matrix";
import { NOOP_RESEARCH_PORTS } from "./ports";
import { FRAME } from "./report.testFixtures";
import { createRunResearch } from "./run";

// Capture exactly what the run hands to the researcher host; no provider or persisted store is involved.
vi.mock("./turns", async (original) => ({ ...await original<typeof import("./turns")>(), createResearchTurns: () => ({
  researcherCall: (tool: EngineTool, execution: EngineToolExecution) => tool.execute(execution),
  runningInBackground: async () => false
}) }));

describe("the model's researcher message through server assembly", () => {
  it.each(["Проверь критерий reviews для строки x1. ", "Проверь критерийreviews для строкиx1. "])("keeps the call argument verbatim: %s", async (message) => {
    const plan = { goal: "Сравнить модели x1 и x2", questions: [{ question: "Проверить критерий reviews?", sites: [], source_classes: [...RESEARCH_SOURCE_CLASSES] }], skipped_source_classes: [] };
    const items: TranscriptItem[] = [{ arguments: JSON.stringify(plan), callId: "start", id: "start", kind: "tool_call", name: START_RESEARCH_TOOL_NAME }];
    const coverage = { ...NOOP_RESEARCH_PORTS.coverage, coverage: async () => researchMatrixCoverage(FRAME, []), frame: async () => FRAME };
    const research = createRunResearch({ chatId: "chat", deps: { gates: [], ports: { coverage: () => coverage } }, gatesEndAt: 2_000_000,
      items: () => items, now: () => 1_000_000, onPlan: async () => undefined, rearmReservedCall: () => undefined, runId: "run", savedResults: { read: async () => null },
      subagentInput: { admittedRequest: { modelId: "main" }, branchRunIds: [], engine: {}, snapshot: {} } as never,
      threads: { backgroundRunIds: async () => [], threadEffectItems: async () => [] } as never, toolTimeLeft: () => true, userId: "user", userMessage: "Compare." });
    research.resume(items);
    const execute = vi.fn(async ({ call }: EngineToolExecution) => ({ callId: call.id, content: [], name: call.name, status: "complete" as const }));
    const tool = { definition: { name: CALL_SUBAGENT_TOOL_NAME }, execute } as unknown as EngineTool;
    const wrapped = research.withResearcherBriefs([tool])[0]!;
    // JSON round trip represents the model's decoded call arguments, including its original spaces (or lack of them).
    const args = JSON.parse(JSON.stringify({ background: true, message, name: "reviews" })) as Record<string, unknown>;
    for (const round of [1, 2]) {
      const result = await wrapped.execute({ call: { arguments: args, id: `call-${round}`, name: CALL_SUBAGENT_TOOL_NAME }, persistedToolCallId: `row-${round}`,
        round, signal: new AbortController().signal } as EngineToolExecution);
      expect(result.status).toBe("complete");
      const received = execute.mock.calls.at(-1)![0].call.arguments;
      expect((received.message as string).slice(0, message.length)).toBe(message);
      expect(received.message).toContain("\n\n# The matrix (from the server)");
      expect((received.message as string).includes("# Research method")).toBe(round === 1);
      expect(received).not.toHaveProperty("background");
    }
    expect(args.message).toBe(message);
  });
});
