import { describe, expect, it, vi } from "vitest";
import {
  FakeSubagentBackgroundControl,
  FakeSubagentRunner,
  FakeSubagentTypeResolver,
  endedSubagentResult
} from "@/tests/support/subagentPorts";
import { SUBAGENT_ERROR_CODES, type SubagentCallResult } from "../../../contracts/subagents";
import type { SubagentTypeSnapshot } from "../../subagents/ports";
import type { ModelToolCall, ToolExecutionResult } from "../../tools/types";
import type { EngineToolExecution } from "../toolRegistry";
import { executeCallSubagent, executeStopSubagent, type SubagentCallDeps } from "./callTools";
import { freezeSubagentModels } from "./modelCatalog";
import type { HostedSubagentRunner } from "./runner";
import type { SubagentThreadLookup, SubagentTurnRecord } from "./threadStore";

const parent = { connectionId: "connection-1", effort: "high", efforts: ["low", "high"], providerModelId: "pm-sol", upstreamModelId: "gpt-6-sol" };

const catalog = freezeSubagentModels([{
  capabilities: { background: false, documentInputMode: "none", imageInput: false, nativeWebSearch: false, openRouterPerplexitySearch: false,
    reasoning: true, streaming: true, text: true, toolCalling: true },
  contextWindow: 100_000, defaultParams: {}, displayName: "Luna", modelId: "pm-luna",
  parameterControls: { reasoningEffort: { defaultValue: "low", options: ["low"], supported: true } } as never,
  provider: "connection-2", providerFamily: "openai", searchStrategyIds: [], upstreamModelId: "gpt-6-luna"
}]);

function turn(extra: Partial<SubagentTurnRecord> = {}): SubagentTurnRecord {
  return { definitionRevisionId: null, effortSource: "parent", id: "turn-0", mode: "foreground", modelId: "gpt-6-sol", modelSource: "parent",
    parentRunId: "run-earlier", provider: "connection-1", providerModelId: "pm-sol", reasoningEffort: "high", startedAt: new Date(),
    state: "done", threadId: "thread-1", ...extra };
}

function setup(options: Readonly<{ assistantRun?: boolean; background?: FakeSubagentBackgroundControl; found?: SubagentThreadLookup | null;
  refuse?: "subagent_busy" | "subagent_limit_reached"; types?: FakeSubagentTypeResolver }> = {}) {
  const fake = new FakeSubagentRunner((input) => endedSubagentResult(input.name, { model: { effort: input.binding.reasoningEffort,
    id: input.binding.modelId }, report: `Outcome: done\n${input.brief}` }));
  const runner: HostedSubagentRunner = {
    continue: (input) => fake.continue(input), deliver: (handle, message) => fake.deliver(handle, message),
    prepareRoute: vi.fn(async () => ({ ok: true as const, route: {} as never })), start: (input) => fake.start(input),
    stop: (handle, reason) => fake.stop(handle, reason), stopAll: vi.fn(async () => undefined), wait: (handle, signal) => fake.wait(handle, signal)
  };
  const store = {
    admitForeground: vi.fn(async (input: Parameters<SubagentCallDeps["store"]["admitForeground"]>[0]) => options.refuse
      ? { code: options.refuse, kind: "refused" as const }
      : { continued: Boolean(options.found), kind: "admitted" as const,
        thread: options.found?.thread ?? { anchorRunId: "run", definitionId: input.definitionId, id: "thread-new", name: input.name,
          typeName: input.typeName },
        turn: turn({ id: `turn-${input.parentToolCallId}`, parentRunId: "run", state: "running" }) }),
    ensureThread: vi.fn(async (input: Parameters<SubagentCallDeps["store"]["ensureThread"]>[0]) => ({ anchorRunId: "run",
      definitionId: null, id: "thread-new", name: input.name, typeName: null })),
    find: vi.fn(async () => options.found ?? null),
    result: vi.fn(async () => endedSubagentResult("shop", { report: "Earlier report" }))
  };
  const deps: SubagentCallDeps = {
    assistantRun: options.assistantRun ?? false, ...(options.background ? { background: options.background } : {}),
    branchRunIds: ["run-earlier", "run"], catalog, chatId: "chat", deadlineAt: () => new Date(Date.now() + 60_000), parent, runId: "run",
    runner, store, ...(options.types ? { types: options.types } : {}), userMessage: "Find me a laptop.", userId: "user"
  };
  return { deps, fake, runner, store };
}

function execution(args: Record<string, unknown>, id = "c1"): EngineToolExecution {
  const call: ModelToolCall = { arguments: args, id, name: "call_subagent" };
  return { call, ordinal: 0, persistedToolCallId: `row-${id}`, round: 1, signal: new AbortController().signal };
}

const value = (result: ToolExecutionResult) => (result.content[0] as { value: SubagentCallResult & { error?: string } }).value;

const visible = (extra: Partial<SubagentThreadLookup> = {}): SubagentThreadLookup => ({ active: null, latest: turn(),
  thread: { anchorRunId: "run-earlier", definitionId: null, id: "thread-1", name: "shop", typeName: null }, ...extra });

describe("call_subagent", () => {
  it("starts a new name on the parent's exact model and effort, waits and returns the result", async () => {
    const ctx = setup();
    const result = await executeCallSubagent(ctx.deps, execution({ message: "Compare laptops.", name: "Shop" }));
    expect(result.status).toBe("complete");
    expect(value(result)).toMatchObject({ kind: "ended", model: { effort: "high", id: "gpt-6-sol" }, name: "shop", state: "done" });
    expect(ctx.store.admitForeground).toHaveBeenCalledWith(expect.objectContaining({ binding: { effortSource: "parent",
      modelId: "gpt-6-sol", modelSource: "parent", provider: "connection-1", providerModelId: "pm-sol", reasoningEffort: "high" },
    name: "shop", parentRunId: "run", parentToolCallId: "row-c1" }));
    const [started] = [...ctx.fake.turns.values()];
    expect(started).toMatchObject({ input: { brief: "Compare laptops.", hostRunId: "run", userMessage: "Find me a laptop." }, kind: "start" });
  });

  it("continues a visible thread by name with its own context", async () => {
    const ctx = setup({ found: visible() });
    await executeCallSubagent(ctx.deps, execution({ message: "Which is cheapest?", name: "shop" }));
    expect([...ctx.fake.turns.values()][0]).toMatchObject({ input: { threadId: "thread-1" }, kind: "continue" });
  });

  it("refuses a busy thread, the 21st running sub-agent and background without its port", async () => {
    const busy = setup({ found: visible({ active: turn({ parentRunId: "run", state: "running" }) }) });
    expect(value(await executeCallSubagent(busy.deps, execution({ message: "Again", name: "shop" }))).error)
      .toBe(SUBAGENT_ERROR_CODES.busy);
    const limited = setup({ refuse: "subagent_limit_reached" });
    expect(value(await executeCallSubagent(limited.deps, execution({ message: "Go", name: "twenty-one" }))).error)
      .toBe(SUBAGENT_ERROR_CODES.limitReached);
    expect(limited.fake.turns.size).toBe(0);
    const telegram = setup();
    expect(value(await executeCallSubagent(telegram.deps, execution({ background: true, message: "Go", name: "shop" }))).error)
      .toBe(SUBAGENT_ERROR_CODES.backgroundUnavailable);
    // The same call without background still works.
    expect(value(await executeCallSubagent(telegram.deps, execution({ message: "Go", name: "shop" }, "c2")))).toMatchObject({ kind: "ended" });
  });

  it("starts a background turn through its port, and delivers a message to one that runs on this branch", async () => {
    const background = new FakeSubagentBackgroundControl();
    const ctx = setup({ background });
    expect(value(await executeCallSubagent(ctx.deps, execution({ background: true, message: "Go", name: "shop" }))))
      .toEqual({ continued: false, kind: "started", name: "shop", state: "running" });
    expect(ctx.store.ensureThread).toHaveBeenCalled();
    expect(background.turns[0]!.input).toMatchObject({ kind: "start", threadId: "thread-new", userMessage: "Find me a laptop." });
    const running = setup({ background, found: visible({ active: turn({ id: "background-turn-1", mode: "background", parentRunId: "run",
      state: "running", threadId: "thread-new" }), thread: { anchorRunId: "run", definitionId: null, id: "thread-new", name: "shop",
      typeName: null } }) });
    expect(value(await executeCallSubagent(running.deps, execution({ message: "Also check prices", name: "shop" }, "c3"))))
      .toEqual({ kind: "delivered", name: "shop", state: "running" });
    expect(background.turns[0]!.messages).toEqual([{ nonce: "c3", origin: "main_agent", text: "Also check prices" }]);
    expect(value(await executeCallSubagent(running.deps, execution({ message: "x", model: "gpt-6-luna", name: "shop" }, "c4"))).error)
      .toBe(SUBAGENT_ERROR_CODES.busy);
  });

  it("takes a frozen model the call names and refuses one outside the list or a route that is gone", async () => {
    const ctx = setup();
    await executeCallSubagent(ctx.deps, execution({ message: "Browse", model: "gpt-6-luna", name: "browser" }));
    expect(ctx.store.admitForeground).toHaveBeenCalledWith(expect.objectContaining({ binding: { effortSource: "parent",
      modelId: "gpt-6-luna", modelSource: "call", provider: "connection-2", providerModelId: "pm-luna", reasoningEffort: "low" } }));
    expect(value(await executeCallSubagent(ctx.deps, execution({ message: "Browse", model: "gpt-9", name: "other" }, "c2"))).error)
      .toBe(SUBAGENT_ERROR_CODES.modelUnavailable);
    vi.mocked(ctx.runner.prepareRoute).mockResolvedValueOnce({ code: SUBAGENT_ERROR_CODES.modelUnavailable, ok: false });
    expect(value(await executeCallSubagent(ctx.deps, execution({ message: "Browse", model: "gpt-6-luna", name: "third" }, "c3"))).error)
      .toBe(SUBAGENT_ERROR_CODES.modelUnavailable);
  });

  it("runs a custom sub-agent on its type's model, and only the default sub-agent in an Assistant chat", async () => {
    const type: SubagentTypeSnapshot = { definitionId: "definition-1", description: "Browses shops", instructions: "Be thorough.",
      name: "browser", providerModelId: "pm-luna", reasoningEffort: null, revisionId: "revision-1", toolGroups: ["workspace"] };
    const ctx = setup({ types: new FakeSubagentTypeResolver({ user: [type] }) });
    await executeCallSubagent(ctx.deps, execution({ message: "Browse", name: "laptops", type: "browser" }));
    expect(ctx.store.admitForeground).toHaveBeenCalledWith(expect.objectContaining({ binding: expect.objectContaining({
      modelSource: "type", providerModelId: "pm-luna" }), definitionId: "definition-1", definitionRevisionId: "revision-1",
    typeName: "browser" }));
    const assistant = setup({ assistantRun: true, types: new FakeSubagentTypeResolver({ user: [type] }) });
    expect(value(await executeCallSubagent(assistant.deps, execution({ message: "Browse", name: "laptops", type: "browser" }))).error)
      .toBe(SUBAGENT_ERROR_CODES.typeUnavailable);
  });
});

describe("stop_subagent", () => {
  it("returns how an ended sub-agent ended, and refuses an unknown name", async () => {
    const ctx = setup({ found: visible() });
    const stopped = await executeStopSubagent(ctx.deps, { ...execution({ name: "shop" }), call: { arguments: { name: "shop" }, id: "c1",
      name: "stop_subagent" } });
    expect(value(stopped)).toMatchObject({ kind: "ended", report: "Earlier report" });
    const none = setup();
    expect(value(await executeStopSubagent(none.deps, { ...execution({ name: "nobody" }), call: { arguments: { name: "nobody" }, id: "c1",
      name: "stop_subagent" } })).error).toBe(SUBAGENT_ERROR_CODES.notFound);
  });
});
