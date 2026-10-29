// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SUBAGENT_DEFINITION_LIMITS } from "@/lib/contracts/subagents";
import type { SubagentDefinitionDraft, SubagentModelOption } from "@/lib/contracts/subagentDefinitions";
import { MemorySubagentDefinitionStore, immediateTransactionDb } from "@/tests/support/subagentDefinitionStore";
import { createSubagentDefinitionService, type SubagentDefinitionDb } from "./definitionService";

const MODELS: SubagentModelOption[] = [
  { defaultEffort: "medium", displayName: "Cheap Model", efforts: ["low", "medium", "high"], modelId: "model-cheap" },
  { defaultEffort: null, displayName: "Plain Model", efforts: [], modelId: "model-plain" }
];

const draft = (patch: Partial<SubagentDefinitionDraft> = {}): SubagentDefinitionDraft => ({
  description: "Long browsing on a cheap model.", effort: "low", instructions: "Browse carefully and report sources.", modelId: "model-cheap",
  name: "browser", tools: ["workspace", "web_search"], ...patch
});

function setup(models: SubagentModelOption[] | null = MODELS) {
  const memory = new MemorySubagentDefinitionStore();
  const service = createSubagentDefinitionService({ db: immediateTransactionDb<SubagentDefinitionDb>(), models: async () => models,
    store: memory.store });
  return { memory, service };
}

describe("custom sub-agent definitions service", () => {
  it("creates, lists and reads a definition with its model's current name", async () => {
    const { service } = setup();
    const created = await service.create("user-a", draft({ name: "  Browser " }));
    expect(created).toMatchObject({ ok: true, value: { modelAvailable: true, modelDisplayName: "Cheap Model", name: "browser", previousRevisionId: null,
      revisionNumber: 1, version: 1 } });
    const list = await service.list("user-a");
    expect(list.definitions.map((entry) => entry.name)).toEqual(["browser"]);
    expect(list.limit).toBe(SUBAGENT_DEFINITION_LIMITS.perUser);
    expect(list.models).toEqual(MODELS);
    expect(Object.keys(list.definitions[0]!)).not.toContain("instructions");
  });

  it("validates bounds, the model and the effort before writing anything", async () => {
    const { memory, service } = setup();
    expect(await service.create("user-a", draft({ name: "Main" }))).toMatchObject({ ok: false, refusal: { code: "subagent_name_invalid", field: "name" } });
    expect(await service.create("user-a", draft({ description: " " }))).toMatchObject({ ok: false, refusal: { field: "description" } });
    expect(await service.create("user-a", draft({ instructions: "x".repeat(SUBAGENT_DEFINITION_LIMITS.instructionsCharacters + 1) })))
      .toMatchObject({ ok: false, refusal: { code: "subagent_definition_invalid", field: "instructions" } });
    expect(await service.create("user-a", draft({ modelId: "someone-elses-model" })))
      .toMatchObject({ ok: false, refusal: { code: "subagent_model_unavailable", field: "model" } });
    expect(await service.create("user-a", draft({ effort: "xhigh" }))).toMatchObject({ ok: false, refusal: { code: "subagent_effort_unsupported" } });
    expect(await service.create("user-a", draft({ effort: "low", modelId: "model-plain" }))).toMatchObject({ ok: false, refusal: { code: "subagent_effort_unsupported" } });
    // Without a model the effort must be one some model of the user takes; the call refuses it later on a parent model without it.
    expect(await service.create("user-a", draft({ effort: "xhigh", modelId: null }))).toMatchObject({ ok: false, refusal: { code: "subagent_effort_unsupported" } });
    expect(await service.create("user-a", { ...draft(), tools: ["workspace", "manage_skill"] })).toMatchObject({ ok: false, refusal: { field: "tools" } });
    expect(memory.rows.size).toBe(0);
    expect(await service.create("user-a", draft({ effort: null, modelId: null, tools: null }))).toMatchObject({ ok: true });
  });

  it("refuses visibly when the user's models cannot be read", async () => {
    const { service } = setup(null);
    expect(await service.create("user-a", draft())).toMatchObject({ ok: false, refusal: { code: "subagent_catalog_unavailable" } });
    // A definition on the caller's model needs no catalog.
    expect(await service.create("user-a", draft({ effort: null, modelId: null }))).toMatchObject({ ok: true });
  });

  it("keeps names unique per user and counts the limit per user", async () => {
    const { memory, service } = setup();
    await service.create("user-a", draft());
    expect(await service.create("user-a", draft())).toMatchObject({ ok: false, refusal: { code: "subagent_definition_exists" } });
    expect(await service.create("user-b", draft())).toMatchObject({ ok: true });
    for (let index = 1; index < SUBAGENT_DEFINITION_LIMITS.perUser; index += 1) await service.create("user-a", draft({ name: `agent-${index}` }));
    expect(await service.create("user-a", draft({ name: "one-more" }))).toMatchObject({ ok: false, refusal: { code: "subagent_definition_limit" } });
    expect([...memory.rows.values()].filter((row) => row.ownerUserId === "user-a")).toHaveLength(SUBAGENT_DEFINITION_LIMITS.perUser);
  });

  it("revises under the version guard and undoes an edit by restoring the previous revision as a new one", async () => {
    const { service } = setup();
    const created = await service.create("user-a", draft());
    if (!created.ok) throw new Error("create failed");
    const edited = await service.update("user-a", created.value.id, 1, draft({ instructions: "New instructions.", name: "web" }));
    expect(edited).toMatchObject({ ok: true, value: { name: "web", previousRevisionId: created.value.revisionId, revisionNumber: 2, version: 2 } });
    if (!edited.ok) throw new Error("edit failed");
    expect(await service.update("user-a", created.value.id, 1, draft({ instructions: "Stale." })))
      .toMatchObject({ ok: false, refusal: { code: "subagent_definition_conflict" } });
    const undone = await service.restore("user-a", created.value.id, 2, edited.value.previousRevisionId!);
    expect(undone).toMatchObject({ ok: true, value: { instructions: "Browse carefully and report sources.", name: "browser", revisionNumber: 3, version: 3 } });
    // The edit's revision is kept: Undo of the undo brings it back.
    expect(await service.restore("user-a", created.value.id, 3, edited.value.revisionId)).toMatchObject({ ok: true, value: { name: "web", version: 4 } });
    expect(await service.restore("user-a", created.value.id, 4, "rev_unknown")).toMatchObject({ ok: false, refusal: { code: "subagent_revision_unknown" } });
  });

  it("treats another user's definition exactly like a missing one", async () => {
    const { service } = setup();
    const created = await service.create("user-a", draft());
    if (!created.ok) throw new Error("create failed");
    const id = created.value.id;
    expect(await service.get("user-b", id)).toBeNull();
    expect(await service.get("user-b", "def_missing")).toBeNull();
    for (const userId of ["user-b"]) {
      expect(await service.update(userId, id, 1, draft())).toEqual(await service.update(userId, "def_missing", 1, draft()));
      expect(await service.remove(userId, id, 1)).toEqual({ ok: false, refusal: { code: "subagent_not_found" } });
      expect(await service.restore(userId, id, 1, created.value.revisionId)).toEqual({ ok: false, refusal: { code: "subagent_not_found" } });
    }
    expect((await service.list("user-b")).definitions).toEqual([]);
    expect(await service.get("user-a", id)).not.toBeNull();
  });

  it("deletes only at the version the caller saw", async () => {
    const { service } = setup();
    const created = await service.create("user-a", draft());
    if (!created.ok) throw new Error("create failed");
    await service.update("user-a", created.value.id, 1, draft({ description: "Changed." }));
    expect(await service.remove("user-a", created.value.id, 1)).toMatchObject({ ok: false, refusal: { code: "subagent_definition_conflict" } });
    expect(await service.remove("user-a", created.value.id, 2)).toEqual({ ok: true, value: null });
    expect(await service.get("user-a", created.value.id)).toBeNull();
  });

  it("marks a definition whose model left the user's catalog, without hiding it", async () => {
    const memory = new MemorySubagentDefinitionStore();
    let models: SubagentModelOption[] = MODELS;
    const service = createSubagentDefinitionService({ db: immediateTransactionDb<SubagentDefinitionDb>(), models: async () => models, store: memory.store });
    await service.create("user-a", draft());
    models = [MODELS[1]!];
    expect((await service.list("user-a")).definitions[0]).toMatchObject({ modelAvailable: false, modelDisplayName: null, modelId: "model-cheap" });
  });
});
