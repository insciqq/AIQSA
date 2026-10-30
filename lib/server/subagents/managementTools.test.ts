// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { decodeResourceChangeCard, type SubagentChangeCard } from "@/lib/contracts/resourceChanges";
import type { SubagentModelOption } from "@/lib/contracts/subagentDefinitions";
import { MemorySubagentDefinitionStore, immediateTransactionDb } from "@/tests/support/subagentDefinitionStore";
import type { SelfServiceCallStore } from "../tools/selfServiceCall";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import type { SubagentDefinitionDb } from "./definitionService";
import {
  SUBAGENT_MANAGEMENT_TOOLS,
  executeSubagentManagementTool,
  subagentManagementToolNames,
  type SubagentManagementRunDeps
} from "./managementTools";
import { SUBAGENT_EXCLUDED_TOOL_NAMES } from "./tools";

const MODELS: SubagentModelOption[] = [
  { connectionName: "Codex LB", defaultEffort: "medium", displayName: "Cheap Model", efforts: ["low", "medium"], modelId: "model-cheap" },
  { connectionName: "Codex LB", defaultEffort: null, displayName: "Big Model", efforts: [], modelId: "model-big" }
];

function harness(initialModels: SubagentModelOption[] | null = MODELS) {
  const memory = new MemorySubagentDefinitionStore();
  const settled: ToolExecutionResult[] = [];
  let claim: Awaited<ReturnType<SelfServiceCallStore["claim"]>> = { kind: "open" };
  let models = initialModels;
  const store: SelfServiceCallStore = {
    claim: vi.fn(async () => claim),
    settle: vi.fn(async (_tx, result: ToolExecutionResult) => { settled.push(result); })
  };
  const deps: SubagentManagementRunDeps = { db: immediateTransactionDb<SubagentDefinitionDb>(), definitions: memory.store, models: async () => models,
    run: { chatId: "chat-1", runId: "run-1", userId: "user-a" } };
  let sequence = 0;
  async function call(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    sequence += 1;
    const execution = executeSubagentManagementTool(deps, { arguments: args, id: `call-${sequence}`, name } satisfies ModelToolCall,
      { callId: `persisted-${sequence}`, store });
    if (!execution) throw new Error("not a management tool");
    return execution;
  }
  return { call, memory, setClaim: (next: typeof claim) => { claim = next; }, setModels: (next: typeof models) => { models = next; }, settled, store };
}

const json = (result: ToolExecutionResult) => (result.content[0] as { value: Record<string, unknown> }).value;
function cardOf(result: ToolExecutionResult): SubagentChangeCard {
  const event = result.artifacts?.[0] as { data: { payload: unknown } } | undefined;
  const card = decodeResourceChangeCard(event?.data.payload);
  if (!card || card.resource !== "subagent") throw new Error("no sub-agent card");
  return card;
}

const BROWSER = { description: "Long browsing.", instructions: "Browse and report.", model: "Cheap Model", effort: "low", name: "browser",
  tools: ["workspace"] };

describe("sub-agent management tools", () => {
  it("are offered only to the main agent of an interactive web chat", () => {
    const names = SUBAGENT_MANAGEMENT_TOOLS.map((tool) => tool.name);
    expect(subagentManagementToolNames({ assistant: false })).toEqual(names);
    for (const blocked of [{ assistant: true }, { assistant: false, telegram: true }, { assistant: false, scheduled: true },
      { assistant: false, monitoring: true }, { assistant: false, subagent: true }]) {
      expect(subagentManagementToolNames(blocked)).toEqual([]);
    }
    for (const name of names) expect(SUBAGENT_EXCLUDED_TOOL_NAMES).toContain(name);
    expect(executeSubagentManagementTool({} as SubagentManagementRunDeps, { arguments: {}, id: "x", name: "manage_skill" },
      { callId: "x", store: {} as SelfServiceCallStore })).toBeNull();
  });

  it("creates through the service, settles the call with its card and resolves the model by name", async () => {
    const { call, memory, settled } = harness();
    const result = await call("create_subagent", BROWSER);
    expect(result.status).toBe("complete");
    expect(json(result)).toMatchObject({ action: "created", saved: true, subagent: { effort: "low", model: "Cheap Model · Codex LB", modelId: "model-cheap", name: "browser",
      version: 1 } });
    expect(cardOf(result)).toMatchObject({ action: "created", definitionVersion: 1, name: "browser", proposalId: null, undoRevisionId: null });
    expect(settled).toEqual([result]);
    const [row] = [...memory.rows.values()];
    expect(row).toMatchObject({ ownerUserId: "user-a", version: 1 });
    expect(await memory.store.find({} as never, "user-a", { name: "browser" })).toMatchObject({ providerModelId: "model-cheap", toolGroups: ["workspace"] });
  });

  it("refuses an unknown model, an unsupported effort and a duplicate name without writing", async () => {
    const { call, memory, settled } = harness();
    const unknown = await call("create_subagent", { ...BROWSER, model: "Someone Else's Model" });
    expect(unknown.status).toBe("error");
    expect(json(unknown)).toMatchObject({ code: "subagent_model_unavailable", saved: false });
    expect(String(json(unknown).message)).toContain("Their models: \"model-cheap\" (Cheap Model · Codex LB), \"model-big\" (Big Model · Codex LB).");
    expect(json(await call("create_subagent", { ...BROWSER, effort: "high" }))).toMatchObject({ code: "subagent_effort_unsupported" });
    expect(memory.rows.size).toBe(0);
    await call("create_subagent", BROWSER);
    expect(json(await call("create_subagent", BROWSER))).toMatchObject({ code: "subagent_definition_exists" });
    expect(memory.rows.size).toBe(1);
    expect(settled).toHaveLength(1);
  });

  it("tells same-named models apart by their connection and never guesses between them", async () => {
    const twins: SubagentModelOption[] = [
      { connectionName: "OpenRouter", defaultEffort: null, displayName: "GPT-6 Luna", efforts: ["low", "high"], modelId: "pm-luna-or" },
      { connectionName: "Codex LB", defaultEffort: null, displayName: "GPT-6 Luna", efforts: ["low", "high"], modelId: "pm-luna-lb" }
    ];
    const { call, memory } = harness(twins);
    const ambiguous = await call("create_subagent", { ...BROWSER, model: "gpt-6 luna" });
    expect(json(ambiguous)).toMatchObject({ code: "subagent_model_unavailable", saved: false });
    expect(String(json(ambiguous).message)).toBe("Several of the user's models are named \"gpt-6 luna\": " +
      "\"pm-luna-or\" (GPT-6 Luna · OpenRouter), \"pm-luna-lb\" (GPT-6 Luna · Codex LB). " +
      "Pass the exact id of the one the user means; if their words do not tell which, ask them.");
    expect(memory.rows.size).toBe(0);
    const labelled = await call("create_subagent", { ...BROWSER, model: "GPT-6 Luna · Codex LB" });
    expect(json(labelled)).toMatchObject({ saved: true, subagent: { model: "GPT-6 Luna · Codex LB", modelId: "pm-luna-lb" } });
    const exact = await call("edit_subagent", { name: "browser", model: "pm-luna-or" });
    expect(json(exact)).toMatchObject({ saved: true, subagent: { model: "GPT-6 Luna · OpenRouter", modelId: "pm-luna-or" } });
    expect(cardOf(exact).changes.find((change) => change.field === "model")?.summary).toBe("GPT-6 Luna · OpenRouter");
  });

  it("edits only the fields passed, shows what changed and offers Undo of that revision", async () => {
    const { call, memory } = harness();
    const created = cardOf(await call("create_subagent", BROWSER));
    const before = await memory.store.find({} as never, "user-a", { name: "browser" });
    const result = await call("edit_subagent", { name: "browser", newName: "web", model: null, instructions: "Browse, then summarize." });
    expect(json(result)).toMatchObject({ action: "updated", changed: ["name", "instructions", "model"], subagent: { name: "web", version: 2 } });
    const card = cardOf(result);
    expect(card).toMatchObject({ action: "updated", definitionId: created.definitionId, definitionVersion: 2, name: "web", previousName: "browser",
      undoRevisionId: before!.revisionId });
    expect(card.changes.find((change) => change.field === "model")?.summary).toBe("The caller's model");
    expect(card.instructionsDiff?.lines.some((line) => line.kind === "add")).toBe(true);
    const after = await memory.store.find({} as never, "user-a", { name: "web" });
    // Unchanged fields stay: description, effort and tools.
    expect(after).toMatchObject({ description: "Long browsing.", providerModelId: null, reasoningEffort: "low", toolGroups: ["workspace"] });
  });

  it("refuses a stale expectedVersion with the current definition and reports an edit that changes nothing", async () => {
    const { call } = harness();
    await call("create_subagent", BROWSER);
    await call("edit_subagent", { name: "browser", description: "Second." });
    const stale = await call("edit_subagent", { name: "browser", expectedVersion: 1, description: "Third." });
    expect(json(stale)).toMatchObject({ code: "subagent_definition_conflict", current: { description: "Second.", version: 2 } });
    const same = await call("edit_subagent", { name: "browser", description: "Second." });
    expect(same.status).toBe("complete");
    expect(json(same)).toMatchObject({ saved: false, unchanged: true });
    expect(same.artifacts).toBeUndefined();
  });

  it("proposes deletion with its consequences and deletes nothing", async () => {
    const { call, memory, settled } = harness();
    const created = cardOf(await call("create_subagent", BROWSER));
    memory.threads.set(created.definitionId, 3);
    const result = await call("delete_subagent", { name: "browser" });
    expect(json(result)).toMatchObject({ deleted: false, deletionProposed: true });
    expect(cardOf(result)).toMatchObject({ action: "delete_proposed", consequences: { threadCount: 3 }, definitionVersion: 1 });
    expect(cardOf(result).proposalId).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(memory.rows.size).toBe(1);
    // A proposal changes nothing, so it does not settle through the change store.
    expect(settled).toHaveLength(1);
    expect(json(await call("delete_subagent", { name: "nobody" }))).toMatchObject({ code: "subagent_not_found" });
  });

  it("never touches another user's definition", async () => {
    const { memory, call } = harness();
    await memory.store.create({} as never, "user-b", { description: "B's.", effort: null, instructions: "B.", modelId: null, name: "browser", tools: null });
    expect(json(await call("edit_subagent", { name: "browser", description: "Mine now." }))).toMatchObject({ code: "subagent_not_found" });
    expect(json(await call("delete_subagent", { name: "browser" }))).toMatchObject({ code: "subagent_not_found" });
    expect(json(await call("create_subagent", BROWSER))).toMatchObject({ saved: true });
  });

  it("returns the settled result of a repeated call and refuses once the run can no longer change anything", async () => {
    const { call, memory, setClaim } = harness();
    const first = await call("create_subagent", BROWSER);
    setClaim({ kind: "settled", result: first });
    expect(await call("create_subagent", { ...BROWSER, name: "other" })).toBe(first);
    setClaim({ kind: "unavailable" });
    expect(json(await call("create_subagent", { ...BROWSER, name: "third" }))).toMatchObject({ code: "subagent_change_unavailable" });
    expect(memory.rows.size).toBe(1);
  });

  it("validates arguments with the shared parsers", async () => {
    const { call } = harness();
    expect(json(await call("create_subagent", { ...BROWSER, name: "Not A Slug" }))).toMatchObject({ code: "subagent_name_invalid" });
    expect(json(await call("create_subagent", { ...BROWSER, tools: ["manage_skill"] }))).toMatchObject({ code: "subagent_arguments_invalid" });
    expect(json(await call("edit_subagent", { name: "browser" }))).toMatchObject({ code: "subagent_arguments_invalid" });
    expect(json(await call("create_subagent", { ...BROWSER, default: "yes" }))).toMatchObject({ code: "subagent_arguments_invalid" });
  });

  it("refuses the reserved type as a new name, and says why", async () => {
    const { call, memory } = harness();
    const created = json(await call("create_subagent", { ...BROWSER, name: "built-in" }));
    expect(created).toMatchObject({ code: "subagent_name_invalid", saved: false });
    expect(String(created.message)).toContain("not \"main\" or \"built-in\"");
    expect(memory.rows.size).toBe(0);
    await call("create_subagent", BROWSER);
    expect(json(await call("edit_subagent", { name: "browser", newName: "built-in" }))).toMatchObject({ code: "subagent_name_invalid", saved: false });
    expect(await memory.store.find({} as never, "user-a", { name: "browser" })).toMatchObject({ version: 1 });
  });
});

describe("the default sub-agent from a chat", () => {
  const change = (result: ToolExecutionResult) => cardOf(result).defaultChange;

  it("creates one on a model and makes it the default in one call, one settled card and one Undo", async () => {
    const { call, memory, settled } = harness();
    const result = await call("create_subagent", { ...BROWSER, default: true });
    expect(json(result)).toMatchObject({ action: "created", saved: true, subagent: { isDefault: true, modelId: "model-cheap", name: "browser" } });
    // This answer keeps the default it started with, and the model is told how to start the new one now.
    expect(String(json(result).note)).toContain("The new default applies from the user's next message on");
    expect(String(json(result).note)).toContain("type \"browser\"");
    expect(settled).toEqual([result]);
    const [row] = [...memory.rows.values()];
    expect(memory.defaults.get("user-a")).toBe(row!.id);
    expect(cardOf(result)).toMatchObject({ action: "created", changes: [], definitionVersion: 1, undoRevisionId: null,
      defaultChange: { isDefault: true, previous: null } });
    expect(change(result)?.changeId).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it("creates without touching the default unless asked, and names the earlier default when it moves", async () => {
    const { call, memory } = harness();
    const first = await call("create_subagent", { ...BROWSER, default: true });
    const other = await call("create_subagent", { ...BROWSER, name: "other" });
    expect(change(other)).toBeUndefined();
    expect(json(other)).toMatchObject({ subagent: { isDefault: false } });
    expect(String(json(other).note)).not.toContain("default");
    expect(memory.defaults.get("user-a")).toBe(cardOf(first).definitionId);
    const third = await call("create_subagent", { ...BROWSER, default: true, name: "third" });
    expect(change(third)).toMatchObject({ isDefault: true, previous: { definitionId: cardOf(first).definitionId, name: "browser" } });
    expect(memory.defaults.get("user-a")).toBe(cardOf(third).definitionId);
  });

  it("moves the default with an edit that changes nothing else: no new version, no revision to restore", async () => {
    const { call, memory, settled } = harness();
    const created = cardOf(await call("create_subagent", BROWSER));
    settled.length = 0;
    const result = await call("edit_subagent", { default: true, name: "browser" });
    expect(json(result)).toMatchObject({ action: "updated", changed: ["default"], saved: true, subagent: { isDefault: true, version: 1 } });
    expect(cardOf(result)).toMatchObject({ action: "updated", definitionId: created.definitionId, definitionVersion: 1, instructionsDiff: null,
      changes: [{ field: "default", summary: "Now the default; before: the built-in sub-agent" }], undoRevisionId: null,
      defaultChange: { isDefault: true, previous: null } });
    expect(settled).toEqual([result]);
    expect(memory.rows.get(created.definitionId)).toMatchObject({ version: 1 });
    const off = await call("edit_subagent", { default: false, name: "browser" });
    expect(json(off)).toMatchObject({ changed: ["default"], subagent: { isDefault: false } });
    expect(cardOf(off)).toMatchObject({ changes: [{ field: "default", summary: "No longer the default; new sub-agents use the built-in one" }],
      defaultChange: { isDefault: false, previous: { definitionId: created.definitionId, name: "browser" } }, undoRevisionId: null });
    expect(memory.defaults.has("user-a")).toBe(false);
    // Each move is its own card, though neither changes the version.
    expect(change(off)?.changeId).not.toBe(change(result)?.changeId);
  });

  it("moves the default with other changes in one card whose Undo has both", async () => {
    const { call, memory } = harness();
    await call("create_subagent", { ...BROWSER, default: true });
    const before = await memory.store.find({} as never, "user-a", { name: "browser" });
    await call("create_subagent", { ...BROWSER, name: "other" });
    const result = await call("edit_subagent", { default: true, instructions: "New.", name: "other" });
    expect(json(result)).toMatchObject({ changed: ["instructions", "default"], subagent: { isDefault: true, name: "other", version: 2 } });
    const card = cardOf(result);
    expect(card.undoRevisionId).toMatch(/^rev_/u);
    expect(card.defaultChange).toMatchObject({ isDefault: true, previous: { definitionId: before!.id, name: "browser" } });
    expect(card.changes.find((entry) => entry.field === "default")?.summary).toBe("Now the default; before: “browser”");
  });

  it("reports nothing changed for the default it already is, and leaves another's default alone", async () => {
    const { call, memory, settled } = harness();
    const created = cardOf(await call("create_subagent", { ...BROWSER, default: true }));
    await call("create_subagent", { ...BROWSER, name: "other" });
    settled.length = 0;
    const again = await call("edit_subagent", { default: true, name: "browser" });
    expect(json(again)).toMatchObject({ saved: false, subagent: { isDefault: true }, unchanged: true });
    expect(again.artifacts).toBeUndefined();
    const notIt = await call("edit_subagent", { default: false, name: "other" });
    expect(json(notIt)).toMatchObject({ saved: false, subagent: { isDefault: false }, unchanged: true });
    expect(memory.defaults.get("user-a")).toBe(created.definitionId);
    expect(settled).toEqual([]);
  });

  it("moves nothing when the write is refused", async () => {
    const { call, memory } = harness();
    const created = cardOf(await call("create_subagent", { ...BROWSER, default: true }));
    expect(json(await call("create_subagent", { ...BROWSER, default: true }))).toMatchObject({ code: "subagent_definition_exists" });
    expect(json(await call("create_subagent", { ...BROWSER, default: true, model: "Someone Else's Model", name: "other" }))).toMatchObject({ code: "subagent_model_unavailable" });
    expect(json(await call("edit_subagent", { default: false, expectedVersion: 9, name: "browser" }))).toMatchObject({ code: "subagent_definition_conflict" });
    expect(memory.defaults.get("user-a")).toBe(created.definitionId);
  });

  it("refuses making a sub-agent the default on a model the user lost, and lets one stop being it", async () => {
    const { call, memory, setModels } = harness();
    await call("create_subagent", { ...BROWSER, default: true });
    await call("create_subagent", { ...BROWSER, name: "other" });
    setModels([]);
    expect(json(await call("edit_subagent", { default: true, name: "other" }))).toMatchObject({ code: "subagent_model_unavailable", saved: false });
    expect(json(await call("edit_subagent", { default: false, name: "browser" }))).toMatchObject({ saved: true, subagent: { isDefault: false } });
    expect(memory.defaults.has("user-a")).toBe(false);
    // Nor does the catalog being unreadable stop it, or a rename.
    setModels(null);
    expect(json(await call("edit_subagent", { name: "other", newName: "renamed" }))).toMatchObject({ saved: true });
  });

  it("names the default among a deletion's consequences, and clears it only on the confirmed deletion", async () => {
    const { call, memory } = harness();
    const created = cardOf(await call("create_subagent", { ...BROWSER, default: true }));
    expect(cardOf(await call("delete_subagent", { name: "browser" })).consequences).toEqual({ isDefault: true, threadCount: 0 });
    expect(memory.defaults.get("user-a")).toBe(created.definitionId);
    await call("create_subagent", { ...BROWSER, name: "other" });
    expect(cardOf(await call("delete_subagent", { name: "other" })).consequences).toEqual({ threadCount: 0 });
  });

  it("never reaches another user's definition or default", async () => {
    const { call, memory } = harness();
    const write = await memory.store.create({} as never, "user-b", { description: "B's.", effort: null, instructions: "B.", modelId: null, name: "theirs", tools: null });
    if (write.kind !== "written") throw new Error("create failed");
    await memory.store.setDefault({} as never, "user-b", { target: write.record.id });
    expect(json(await call("edit_subagent", { default: true, name: "theirs" }))).toMatchObject({ code: "subagent_not_found" });
    expect(memory.defaults.has("user-a")).toBe(false);
    expect(memory.defaults.get("user-b")).toBe(write.record.id);
    // Moving this user's default names nothing of theirs as what came before.
    expect(change(await call("create_subagent", { ...BROWSER, default: true }))).toMatchObject({ previous: null });
  });
});
