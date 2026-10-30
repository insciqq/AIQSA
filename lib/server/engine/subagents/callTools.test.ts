import { describe, expect, it, vi } from "vitest";
import {
  FakeSubagentBackgroundControl,
  FakeSubagentRunner,
  FakeSubagentTypeResolver,
  endedSubagentResult
} from "@/tests/support/subagentPorts";
import { SUBAGENT_BUILT_IN_TYPE, SUBAGENT_ERROR_CODES, type SubagentCallResult } from "../../../contracts/subagents";
import type { SubagentBackgroundControl, SubagentTypeSnapshot } from "../../subagents/ports";
import type { FrozenSubagentDefault } from "../../subagents/typeCatalog";
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

function setup(options: Readonly<{ background?: SubagentBackgroundControl; backgroundAllowed?: boolean; defaultType?: FrozenSubagentDefault;
  found?: SubagentThreadLookup | null; orphans?: number; parent?: SubagentCallDeps["parent"]; refuse?: "subagent_busy" | "subagent_limit_reached";
  result?: unknown; types?: FakeSubagentTypeResolver }> = {}) {
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
    endOrphanedTurns: vi.fn(async () => options.orphans ?? 0),
    ensureThread: vi.fn(async (input: Parameters<SubagentCallDeps["store"]["ensureThread"]>[0]) => ({ anchorRunId: "run",
      definitionId: input.definitionId, id: "thread-new", name: input.name, typeName: input.typeName })),
    find: vi.fn(async () => options.found ?? null),
    result: vi.fn(async () => "result" in options ? options.result : endedSubagentResult("shop", { report: "Earlier report" }))
  };
  const deps: SubagentCallDeps = {
    ...(options.background ? { background: options.background } : {}),
    backgroundAllowed: options.backgroundAllowed ?? true,
    branchRunIds: ["run-earlier", "run"], catalog, chatId: "chat", deadlineAt: () => new Date(Date.now() + 60_000),
    defaultType: options.defaultType ?? null, parent: options.parent ?? parent, runId: "run",
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

const BROWSER: SubagentTypeSnapshot = { definitionId: "definition-1", description: "Browses shops", instructions: "Be thorough.",
  name: "browser", providerModelId: "pm-luna", reasoningEffort: null, revisionId: "revision-1", toolGroups: ["workspace"] };
const GEMINI: SubagentTypeSnapshot = { definitionId: "definition-2", description: "Long research", instructions: "Cite sources.",
  name: "gemini-helper", providerModelId: "pm-luna", reasoningEffort: null, revisionId: "revision-2", toolGroups: ["web_search"] };
const frozenDefault = (type: SubagentTypeSnapshot): FrozenSubagentDefault => ({ definitionId: type.definitionId, name: type.name, version: 1 });

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

  it("runs a custom sub-agent on its type's model", async () => {
    const ctx = setup({ types: new FakeSubagentTypeResolver({ user: [BROWSER] }) });
    await executeCallSubagent(ctx.deps, execution({ message: "Browse", name: "laptops", type: "browser" }));
    expect(ctx.store.admitForeground).toHaveBeenCalledWith(expect.objectContaining({ binding: expect.objectContaining({
      modelSource: "type", providerModelId: "pm-luna" }), definitionId: "definition-1", definitionRevisionId: "revision-1",
    typeName: "browser" }));
  });
});

describe("call_subagent refusing a type", () => {
  const types = () => new FakeSubagentTypeResolver({ user: [BROWSER, GEMINI] });

  it("lists the user's custom sub-agents for a near miss and sends the model to the right name or the user, never to drop type", async () => {
    const ctx = setup({ types: types() });
    const result = await executeCallSubagent(ctx.deps, execution({ message: "Go", name: "work", type: "gemini" }));
    expect(result.status).toBe("error");
    expect(value(result)).toEqual({ error: SUBAGENT_ERROR_CODES.typeUnavailable,
      message: "\"gemini\" is not one of the user's custom sub-agents. Their custom sub-agents: \"browser\", \"gemini-helper\". " +
        "Call again with the exact name of the one the user means, or tell the user it does not exist. " +
        "Do not drop type: that would start another sub-agent than the one asked for." });
    expect(ctx.store.admitForeground).not.toHaveBeenCalled();
    expect(ctx.fake.turns.size).toBe(0);
  });

  it("does the same for a type that is no valid name at all, and says so when the user has none", async () => {
    const malformed = await executeCallSubagent(setup({ types: types() }).deps, execution({ message: "Go", name: "work", type: "Gemini Helper" }));
    expect(value(malformed)).toMatchObject({ error: SUBAGENT_ERROR_CODES.typeUnavailable,
      message: expect.stringContaining("Their custom sub-agents: \"browser\", \"gemini-helper\".") });
    const none = await executeCallSubagent(setup({ types: new FakeSubagentTypeResolver({}) }).deps, execution({ message: "Go", name: "work", type: "gemini" }));
    expect(value(none)).toMatchObject({ message: expect.stringContaining("The user has no custom sub-agents.") });
    const unported = await executeCallSubagent(setup().deps, execution({ message: "Go", name: "work", type: "gemini" }));
    expect(value(unported)).toEqual({ error: SUBAGENT_ERROR_CODES.typeUnavailable,
      message: "Custom sub-agents are not available in this chat, so nothing started. Tell the user." });
    for (const refused of [malformed, none, unported]) expect(JSON.stringify(value(refused))).not.toMatch(/omit/iu);
  });

  it("refuses visibly when the types cannot be read: nothing started, so the call's effect is no unknown", async () => {
    const broken = types();
    vi.spyOn(broken, "resolve").mockRejectedValue(new Error("database down"));
    const ctx = setup({ types: broken });
    await expect(executeCallSubagent(ctx.deps, execution({ message: "Go", name: "work" }))).resolves.toMatchObject({ status: "error",
      content: [{ value: { error: SUBAGENT_ERROR_CODES.typeUnavailable,
        message: "The user's custom sub-agents could not be read right now, so nothing started. Tell the user." } }] });
    expect(ctx.store.admitForeground).not.toHaveBeenCalled();
  });

  it("refuses another user's custom sub-agent exactly like one that does not exist, and lists only the caller's", async () => {
    const ctx = setup({ types: new FakeSubagentTypeResolver({ other: [GEMINI], user: [BROWSER] }) });
    const result = value(await executeCallSubagent(ctx.deps, execution({ message: "Go", name: "work", type: "gemini-helper" })));
    expect(result).toMatchObject({ error: SUBAGENT_ERROR_CODES.typeUnavailable, message: expect.stringContaining("Their custom sub-agents: \"browser\".") });
    // A frozen default can name only the caller's own definition; one that did not resolve for them never runs.
    const foreign = setup({ defaultType: frozenDefault(GEMINI), types: new FakeSubagentTypeResolver({ other: [GEMINI], user: [BROWSER] }) });
    expect(value(await executeCallSubagent(foreign.deps, execution({ message: "Go", name: "work" }))).error).toBe(SUBAGENT_ERROR_CODES.typeUnavailable);
    expect(foreign.store.admitForeground).not.toHaveBeenCalled();
  });
});

describe("call_subagent choosing a sub-agent for a new thread", () => {
  const types = () => new FakeSubagentTypeResolver({ user: [BROWSER, GEMINI] });
  const admitted = (ctx: ReturnType<typeof setup>) => ctx.store.admitForeground.mock.calls.at(-1)![0];

  it("starts the built-in sub-agent on the parent's model when nothing is named and no default is set", async () => {
    const ctx = setup({ types: types() });
    await executeCallSubagent(ctx.deps, execution({ message: "Go", name: "work" }));
    expect(admitted(ctx)).toMatchObject({ binding: { modelSource: "parent", providerModelId: "pm-sol" }, definitionId: null, typeName: null });
    expect([...ctx.fake.turns.values()][0]!.input.type).toBeNull();
  });

  it("starts the custom sub-agent whose name the new thread took, also with a default set", async () => {
    const ctx = setup({ types: types() });
    await executeCallSubagent(ctx.deps, execution({ message: "Go", name: "Gemini-Helper" }));
    expect(admitted(ctx)).toMatchObject({ binding: { modelSource: "type", providerModelId: "pm-luna" }, definitionId: GEMINI.definitionId,
      name: "gemini-helper", typeName: "gemini-helper" });
    const withDefault = setup({ defaultType: frozenDefault(BROWSER), types: types() });
    await executeCallSubagent(withDefault.deps, execution({ message: "Go", name: "gemini-helper" }));
    expect(admitted(withDefault)).toMatchObject({ definitionId: GEMINI.definitionId });
  });

  it("starts the default for a new thread with no type, on its own model and with its tool groups", async () => {
    const ctx = setup({ defaultType: frozenDefault(GEMINI), types: types() });
    const result = await executeCallSubagent(ctx.deps, execution({ message: "Go", name: "work" }));
    expect(value(result)).toMatchObject({ kind: "ended", model: { id: "gpt-6-luna" } });
    expect(admitted(ctx)).toMatchObject({ binding: { effortSource: "parent", modelId: "gpt-6-luna", modelSource: "type", provider: "connection-2",
      providerModelId: "pm-luna" }, definitionId: GEMINI.definitionId, definitionRevisionId: GEMINI.revisionId, name: "work", typeName: "gemini-helper" });
    expect([...ctx.fake.turns.values()][0]!.input.type).toEqual(GEMINI);
  });

  it("keeps the call's model and effort over the default's, as over any type", async () => {
    const ctx = setup({ defaultType: frozenDefault(GEMINI), types: types() });
    await executeCallSubagent(ctx.deps, execution({ effort: "low", message: "Go", model: "gpt-6-sol", name: "work" }));
    expect(admitted(ctx)).toMatchObject({ binding: { effortSource: "call", modelSource: "call", providerModelId: "pm-sol", reasoningEffort: "low" },
      definitionId: GEMINI.definitionId });
  });

  it("runs a type given that equals the default just as the default", async () => {
    const ctx = setup({ defaultType: frozenDefault(GEMINI), types: types() });
    await executeCallSubagent(ctx.deps, execution({ message: "Go", name: "work", type: "gemini-helper" }));
    expect(admitted(ctx)).toMatchObject({ binding: { modelSource: "type" }, definitionId: GEMINI.definitionId, typeName: "gemini-helper" });
  });

  it("starts the default's own background turn, by its thread and type", async () => {
    const background = new FakeSubagentBackgroundControl();
    const ctx = setup({ background, defaultType: frozenDefault(GEMINI), types: types() });
    await executeCallSubagent(ctx.deps, execution({ background: true, message: "Go", name: "work" }));
    expect(ctx.store.ensureThread).toHaveBeenCalledWith(expect.objectContaining({ definitionId: GEMINI.definitionId, typeName: "gemini-helper" }));
    expect(background.turns[0]!.input).toMatchObject({ binding: { modelSource: "type", providerModelId: "pm-luna" }, type: GEMINI });
  });

  it("runs the built-in sub-agent for the reserved type while a default is set, and for a new thread of that name", async () => {
    const ctx = setup({ defaultType: frozenDefault(GEMINI), types: types() });
    await executeCallSubagent(ctx.deps, execution({ message: "Go", name: "work", type: SUBAGENT_BUILT_IN_TYPE }));
    expect(admitted(ctx)).toMatchObject({ binding: { modelSource: "parent", providerModelId: "pm-sol" }, definitionId: null, typeName: null });
    await executeCallSubagent(ctx.deps, execution({ message: "Go", name: SUBAGENT_BUILT_IN_TYPE }, "c2"));
    expect(admitted(ctx)).toMatchObject({ binding: { modelSource: "parent" }, definitionId: null, name: SUBAGENT_BUILT_IN_TYPE, typeName: null });
    // With no default at all the value means the same.
    const none = setup({ types: types() });
    await executeCallSubagent(none.deps, execution({ message: "Go", name: "work", type: SUBAGENT_BUILT_IN_TYPE }));
    expect(admitted(none)).toMatchObject({ definitionId: null, typeName: null });
  });

  it("refuses the reserved value visibly while a definition saved before the reservation holds that name", async () => {
    const legacy = { ...BROWSER, definitionId: "definition-legacy", name: SUBAGENT_BUILT_IN_TYPE };
    const ctx = setup({ types: new FakeSubagentTypeResolver({ user: [legacy] }) });
    for (const args of [{ type: SUBAGENT_BUILT_IN_TYPE, name: "work" }, { name: SUBAGENT_BUILT_IN_TYPE }]) {
      expect(value(await executeCallSubagent(ctx.deps, execution({ ...args, message: "Go" })))).toEqual({ error: SUBAGENT_ERROR_CODES.typeUnavailable,
        message: "The user has a custom sub-agent named \"built-in\", so this value is ambiguous and nothing started. " +
          "Tell the user; renaming it in Studio > Sub-agents frees the name." });
    }
    expect(ctx.store.admitForeground).not.toHaveBeenCalled();
    // As the default it still runs, by its id.
    const asDefault = setup({ defaultType: frozenDefault(legacy), types: new FakeSubagentTypeResolver({ user: [legacy] }) });
    await executeCallSubagent(asDefault.deps, execution({ message: "Go", name: "work" }));
    expect(admitted(asDefault)).toMatchObject({ definitionId: "definition-legacy", typeName: SUBAGENT_BUILT_IN_TYPE });
  });
});

describe("call_subagent with a default that cannot run", () => {
  it("says the models could not be read when admission froze none, and starts nothing", async () => {
    const ctx = setup({ defaultType: frozenDefault(GEMINI), types: new FakeSubagentTypeResolver({ user: [GEMINI] }) });
    const result = await executeCallSubagent({ ...ctx.deps, catalog: null }, execution({ message: "Go", name: "work" }));
    expect(value(result)).toMatchObject({ error: SUBAGENT_ERROR_CODES.typeUnavailable,
      message: expect.stringContaining("could not read the user's models") });
    expect(ctx.store.admitForeground).not.toHaveBeenCalled();
  });

  it("refuses a default whose model left the frozen list, never replacing it, and tells the model to tell the user", async () => {
    const gone = { ...GEMINI, providerModelId: "pm-gone" };
    const ctx = setup({ defaultType: frozenDefault(gone), types: new FakeSubagentTypeResolver({ user: [gone] }) });
    const result = await executeCallSubagent(ctx.deps, execution({ message: "Go", name: "work" }));
    expect(value(result)).toEqual({ error: SUBAGENT_ERROR_CODES.typeUnavailable,
      message: "The user's default sub-agent \"gemini-helper\" runs on a model that is not available in this chat, so nothing started. " +
        "Tell the user; they can choose another model in Studio > Sub-agents. Do not start another sub-agent or model in its place unless they ask." });
    expect(ctx.store.admitForeground).not.toHaveBeenCalled();
    // The same for one the call named: it says who it is.
    const named = setup({ types: new FakeSubagentTypeResolver({ user: [gone] }) });
    expect(value(await executeCallSubagent(named.deps, execution({ message: "Go", name: "work", type: "gemini-helper" })))).toMatchObject({
      error: SUBAGENT_ERROR_CODES.typeUnavailable, message: expect.stringContaining("The custom sub-agent \"gemini-helper\" runs on a model") });
    // The user's own model override still works: the model is the call's, the instructions the default's.
    await executeCallSubagent(ctx.deps, execution({ message: "Go", model: "gpt-6-sol", name: "work" }, "c2"));
    expect(ctx.store.admitForeground).toHaveBeenCalledWith(expect.objectContaining({ binding: expect.objectContaining({ modelSource: "call" }),
      definitionId: GEMINI.definitionId }));
  });

  it("refuses a default whose route is gone by the time it starts, whatever the frozen list says", async () => {
    const ctx = setup({ defaultType: frozenDefault(GEMINI), types: new FakeSubagentTypeResolver({ user: [GEMINI] }) });
    vi.mocked(ctx.runner.prepareRoute).mockResolvedValueOnce({ code: SUBAGENT_ERROR_CODES.modelUnavailable, ok: false });
    expect(value(await executeCallSubagent(ctx.deps, execution({ message: "Go", name: "work" })))).toMatchObject({
      error: SUBAGENT_ERROR_CODES.typeUnavailable, message: expect.stringContaining("Tell the user") });
    expect(ctx.store.admitForeground).not.toHaveBeenCalled();
  });

  it("refuses a default's effort the model does not take in words that do not loop", async () => {
    const effortful = { ...GEMINI, providerModelId: null, reasoningEffort: "max" };
    const ctx = setup({ defaultType: frozenDefault(effortful), types: new FakeSubagentTypeResolver({ user: [effortful] }) });
    expect(value(await executeCallSubagent(ctx.deps, execution({ message: "Go", name: "work" })))).toEqual({ error: SUBAGENT_ERROR_CODES.effortUnsupported,
      message: "The user's default sub-agent \"gemini-helper\" asks for the reasoning effort \"max\", which this model does not take, so nothing started. " +
        "Pass an effort the model supports, or tell the user." });
    await executeCallSubagent(ctx.deps, execution({ effort: "low", message: "Go", name: "work" }, "c2"));
    expect(ctx.store.admitForeground).toHaveBeenCalledWith(expect.objectContaining({ binding: expect.objectContaining({ effortSource: "call", reasoningEffort: "low" }),
      definitionId: GEMINI.definitionId }));
  });

  it("refuses a frozen default deleted before the call, never the built-in", async () => {
    const ctx = setup({ defaultType: frozenDefault(GEMINI), types: new FakeSubagentTypeResolver({ user: [BROWSER] }) });
    expect(value(await executeCallSubagent(ctx.deps, execution({ message: "Go", name: "work" })))).toEqual({ error: SUBAGENT_ERROR_CODES.typeUnavailable,
      message: "The user's default sub-agent \"gemini-helper\" is no longer available, so nothing started. " +
        "Tell the user; they can choose another in Studio > Sub-agents. Do not start another sub-agent in its place unless they ask." });
    expect(ctx.store.admitForeground).not.toHaveBeenCalled();
  });

  it("refuses when the default could not be read at admission, and still runs what the call names", async () => {
    const ctx = setup({ defaultType: { unreadable: true, version: 1 }, types: new FakeSubagentTypeResolver({ user: [BROWSER] }) });
    expect(value(await executeCallSubagent(ctx.deps, execution({ message: "Go", name: "work" }))).error).toBe(SUBAGENT_ERROR_CODES.typeUnavailable);
    expect(ctx.store.admitForeground).not.toHaveBeenCalled();
    await executeCallSubagent(ctx.deps, execution({ message: "Go", name: "work", type: "browser" }, "c2"));
    await executeCallSubagent(ctx.deps, execution({ message: "Go", name: "plain", type: SUBAGENT_BUILT_IN_TYPE }, "c3"));
    expect(ctx.store.admitForeground).toHaveBeenCalledTimes(2);
  });

  it("offers nothing but the refusal to a run whose ports have no resolver", async () => {
    const ctx = setup({ defaultType: frozenDefault(GEMINI) });
    expect(value(await executeCallSubagent(ctx.deps, execution({ message: "Go", name: "work" }))).error).toBe(SUBAGENT_ERROR_CODES.typeUnavailable);
  });
});

describe("call_subagent continuing a thread", () => {
  const typed = (type: SubagentTypeSnapshot) => visible({ thread: { anchorRunId: "run-earlier", definitionId: type.definitionId, id: "thread-1", name: "shop",
    typeName: type.name } });

  it("keeps a built-in thread built-in after a default was set", async () => {
    const ctx = setup({ defaultType: frozenDefault(GEMINI), found: visible(), types: new FakeSubagentTypeResolver({ user: [GEMINI] }) });
    await executeCallSubagent(ctx.deps, execution({ message: "Again", name: "shop" }));
    expect(ctx.store.admitForeground).toHaveBeenCalledWith(expect.objectContaining({ binding: expect.objectContaining({ modelSource: "parent",
      providerModelId: "pm-sol" }), definitionId: null, typeName: null }));
    expect([...ctx.fake.turns.values()][0]!.input.type).toBeNull();
    await executeCallSubagent(ctx.deps, execution({ message: "Again", name: "shop", type: SUBAGENT_BUILT_IN_TYPE }, "c2"));
    expect(ctx.store.admitForeground).toHaveBeenCalledTimes(2);
    expect(value(await executeCallSubagent(ctx.deps, execution({ message: "Again", name: "shop", type: "gemini-helper" }, "c3")))).toEqual({
      error: SUBAGENT_ERROR_CODES.typeUnavailable, message: "This sub-agent is the built-in sub-agent; start another name for another type." });
  });

  it("keeps a custom thread its type after the default moved, by the id it started with", async () => {
    const ctx = setup({ defaultType: frozenDefault(GEMINI), found: typed(BROWSER), types: new FakeSubagentTypeResolver({ user: [BROWSER, GEMINI] }) });
    await executeCallSubagent(ctx.deps, execution({ message: "Again", name: "shop" }));
    expect([...ctx.fake.turns.values()][0]!.input.type).toEqual(BROWSER);
  });

  it("resumes a thread by name without looking for a custom sub-agent of that name", async () => {
    const twin = { ...BROWSER, definitionId: "definition-shop", name: "shop" };
    const resolver = new FakeSubagentTypeResolver({ user: [twin] });
    const lookup = vi.spyOn(resolver, "resolve");
    const ctx = setup({ found: visible(), types: resolver });
    await executeCallSubagent(ctx.deps, execution({ message: "Again", name: "shop" }));
    expect(lookup).not.toHaveBeenCalled();
    expect([...ctx.fake.turns.values()][0]!.input.type).toBeNull();
  });

  it("refuses a thread whose custom sub-agent was deleted, and offers no other in its place", async () => {
    const deleted = visible({ thread: { anchorRunId: "run-earlier", definitionId: null, id: "thread-1", name: "shop", typeName: "browser" } });
    const ctx = setup({ defaultType: frozenDefault(GEMINI), found: deleted, types: new FakeSubagentTypeResolver({ user: [GEMINI] }) });
    expect(value(await executeCallSubagent(ctx.deps, execution({ message: "Again", name: "shop" })))).toEqual({ error: SUBAGENT_ERROR_CODES.typeUnavailable,
      message: "The custom sub-agent \"browser\" is no longer available, so this sub-agent cannot continue. " +
        "Tell the user; do not start another sub-agent in its place unless they ask." });
    expect(ctx.store.admitForeground).not.toHaveBeenCalled();
  });
});

describe("call_subagent in an Assistant chat", () => {
  // The Assistant fixed its model: the parent's route is outside the runner's list of models, and it binds only the main agent.
  const assistantParent = { connectionId: "connection-assistant", effort: null, efforts: [], providerModelId: "pm-assistant", upstreamModelId: "assistant-model" };

  it("runs the runner's named custom sub-agent on its own model, a call's model, and the runner's default", async () => {
    const types = new FakeSubagentTypeResolver({ owner: [BROWSER], user: [GEMINI] });
    const ctx = setup({ parent: assistantParent, types });
    await executeCallSubagent(ctx.deps, execution({ message: "Go", name: "named", type: "gemini-helper" }));
    expect(ctx.store.admitForeground).toHaveBeenLastCalledWith(expect.objectContaining({ binding: expect.objectContaining({ modelSource: "type", providerModelId: "pm-luna" }),
      definitionId: GEMINI.definitionId }));
    await executeCallSubagent(ctx.deps, execution({ message: "Go", model: "gpt-6-luna", name: "by-model" }, "c2"));
    expect(ctx.store.admitForeground).toHaveBeenLastCalledWith(expect.objectContaining({ binding: expect.objectContaining({ modelSource: "call", providerModelId: "pm-luna" }) }));
    const defaulted = setup({ defaultType: frozenDefault(GEMINI), parent: assistantParent, types });
    await executeCallSubagent(defaulted.deps, execution({ message: "Go", name: "work" }));
    expect(defaulted.store.admitForeground).toHaveBeenLastCalledWith(expect.objectContaining({ binding: expect.objectContaining({ providerModelId: "pm-luna" }),
      definitionId: GEMINI.definitionId }));
    // A definition of anyone but the runner, the Assistant's owner included, is never reachable.
    expect(value(await executeCallSubagent(ctx.deps, execution({ message: "Go", name: "other", type: "browser" }, "c3"))).error)
      .toBe(SUBAGENT_ERROR_CODES.typeUnavailable);
  });
});

describe("call_subagent with the background port", () => {
  it("withholds background mode where the run may not start one (a Telegram turn), whatever the port says", async () => {
    const background = new FakeSubagentBackgroundControl();
    const availability = vi.spyOn(background, "availability");
    const ctx = setup({ background, backgroundAllowed: false });
    expect(value(await executeCallSubagent(ctx.deps, execution({ background: true, message: "Go", name: "shop" }))).error)
      .toBe(SUBAGENT_ERROR_CODES.backgroundUnavailable);
    expect(availability).not.toHaveBeenCalled();
    expect(background.turns).toHaveLength(0);
  });

  it("refuses a message to a full mailbox visibly", async () => {
    const background = new FakeSubagentBackgroundControl();
    vi.spyOn(background, "deliver").mockRejectedValue(Object.assign(new Error("mailbox_full"), { code: "subagent_message_invalid" }));
    const ctx = setup({ background, found: visible({ active: turn({ mode: "background", parentRunId: "run", state: "running" }) }) });
    const result = await executeCallSubagent(ctx.deps, execution({ message: "One more thing", name: "shop" }));
    expect(result.status).toBe("error");
    expect(value(result).error).toBe(SUBAGENT_ERROR_CODES.messageInvalid);
  });
});

describe("stop_subagent", () => {
  it("returns how an ended sub-agent ended, and refuses an unknown name", async () => {
    const ctx = setup({ found: visible() });
    const stopped = await executeStopSubagent(ctx.deps, { ...execution({ name: "shop" }), call: { arguments: { name: "shop" }, id: "c1",
      name: "stop_subagent" } });
    expect(value(stopped)).toMatchObject({ kind: "ended", report: "Earlier report" });
    // A foreground turn a restart left behind ends as interrupted when it is stopped, and that is how it ended.
    const orphan = setup({ found: visible({ latest: turn({ state: "running" }) }), orphans: 1 });
    vi.mocked(orphan.store.result).mockResolvedValueOnce(null).mockResolvedValueOnce(endedSubagentResult("shop", { outcome: undefined,
      reason: "restart", state: "interrupted" }));
    expect(value(await executeStopSubagent(orphan.deps, { ...execution({ name: "shop" }), call: { arguments: { name: "shop" }, id: "c1",
      name: "stop_subagent" } }))).toMatchObject({ reason: "restart", state: "interrupted" });
    expect(orphan.store.endOrphanedTurns).toHaveBeenCalledWith({ chatId: "chat", userId: "user" });
    const none = setup();
    expect(value(await executeStopSubagent(none.deps, { ...execution({ name: "nobody" }), call: { arguments: { name: "nobody" }, id: "c1",
      name: "stop_subagent" } })).error).toBe(SUBAGENT_ERROR_CODES.notFound);
  });
});
