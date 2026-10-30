// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SUBAGENT_DEFINITION_LIMITS } from "@/lib/contracts/subagents";
import type { SubagentDefinitionDraft, SubagentModelOption } from "@/lib/contracts/subagentDefinitions";
import { MemorySubagentDefinitionStore, immediateTransactionDb } from "@/tests/support/subagentDefinitionStore";
import { createSubagentDefinitionService, type SubagentDefinitionDb, type SubagentDefinitionService } from "./definitionService";

const MODELS: SubagentModelOption[] = [
  { connectionName: "Codex LB", defaultEffort: "medium", displayName: "Cheap Model", efforts: ["low", "medium", "high"], modelId: "model-cheap" },
  { connectionName: "Codex LB", defaultEffort: null, displayName: "Plain Model", efforts: [], modelId: "model-plain" }
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
    expect(created).toMatchObject({ ok: true, value: { modelAvailable: true, modelDisplayName: "Cheap Model · Codex LB", name: "browser", previousRevisionId: null,
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

  it("keeps the reserved type out of new names, and lets a definition that holds it from before stay and rename away", async () => {
    const { memory, service } = setup();
    expect(await service.create("user-a", draft({ name: "built-in" }))).toEqual({ ok: false, refusal: { code: "subagent_name_invalid", field: "name" } });
    const created = await service.create("user-a", draft());
    if (!created.ok) throw new Error("create failed");
    expect(await service.update("user-a", created.value.id, 1, draft({ name: "built-in" }))).toEqual({ ok: false,
      refusal: { code: "subagent_name_invalid", field: "name" } });
    // The row as an earlier release could have saved it.
    const row = memory.rows.get(created.value.id)!;
    const legacy = { draft: draft({ name: "built-in" }), id: "rev_legacy", number: 2 };
    row.revisions.push(legacy);
    row.current = legacy.id;
    row.version = 2;
    expect((await service.list("user-a")).definitions.map((entry) => entry.name)).toEqual(["built-in"]);
    expect(await service.update("user-a", row.id, 2, draft({ description: "Edited.", name: "built-in" }))).toMatchObject({ ok: true, value: { name: "built-in", version: 3 } });
    expect(await service.update("user-a", row.id, 3, draft({ name: "renamed" }))).toMatchObject({ ok: true, value: { name: "renamed", version: 4 } });
    // Undo of that rename would take the reserved name again: refused, nothing changes.
    expect(await service.restore("user-a", row.id, 4, "rev_legacy")).toEqual({ ok: false, refusal: { code: "subagent_name_invalid", field: "name" } });
    expect(await service.get("user-a", row.id)).toMatchObject({ name: "renamed", version: 4 });
  });
});

describe("the user's default sub-agent", () => {
  async function two(service: SubagentDefinitionService, userId = "user-a") {
    const first = await service.create(userId, draft({ name: "first" }));
    const second = await service.create(userId, draft({ name: "second" }));
    if (!first.ok || !second.ok) throw new Error("create failed");
    return { first: first.value, second: second.value };
  }

  it("has none until set, moves between definitions so at most one is the default, and clears", async () => {
    const { service } = setup();
    const { first, second } = await two(service);
    expect((await service.list("user-a")).defaultDefinitionId).toBeNull();
    expect(await service.readDefault("user-a")).toBeNull();
    expect(await service.setDefault("user-a", first.id, null)).toEqual({ ok: true, value: first.id });
    expect((await service.list("user-a")).defaultDefinitionId).toBe(first.id);
    expect(await service.setDefault("user-a", second.id, first.id)).toEqual({ ok: true, value: second.id });
    expect(await service.readDefault("user-a")).toBe(second.id);
    expect(await service.setDefault("user-a", null, second.id)).toEqual({ ok: true, value: null });
    expect((await service.list("user-a")).defaultDefinitionId).toBeNull();
    // Setting what it already is succeeds and writes nothing.
    expect(await service.setDefault("user-a", null, null)).toEqual({ ok: true, value: null });
  });

  it("refuses a move from a default that moved meanwhile", async () => {
    const { service } = setup();
    const { first, second } = await two(service);
    await service.setDefault("user-a", first.id, null);
    expect(await service.setDefault("user-a", second.id, null)).toEqual({ ok: false, refusal: { code: "subagent_default_conflict" } });
    expect(await service.readDefault("user-a")).toBe(first.id);
  });

  it("treats another user's definition exactly like a missing one, and keeps each user's default apart", async () => {
    const { service } = setup();
    const { first } = await two(service);
    const { second: theirs } = await two(service, "user-b");
    await service.setDefault("user-b", theirs.id, null);
    expect(await service.setDefault("user-a", theirs.id, null)).toEqual(await service.setDefault("user-a", "def_missing", null));
    expect(await service.setDefault("user-a", theirs.id, null)).toEqual({ ok: false, refusal: { code: "subagent_not_found" } });
    expect(await service.readDefault("user-a")).toBeNull();
    await service.setDefault("user-a", first.id, null);
    expect(await service.readDefault("user-b")).toBe(theirs.id);
    // An Undo naming their definition reads it as gone, and their deletion route as missing.
    expect(await service.undoDefaultChange("user-a", { restore: { expected: first.id, target: theirs.id } })).toEqual({ ok: true, value: "target_gone" });
    expect(await service.readDefault("user-a")).toBeNull();
    expect(await service.undoDefaultChange("user-a", { definition: { expectedVersion: 1, id: theirs.id, revisionId: null }, restore: { expected: null, target: null } }))
      .toEqual({ ok: false, refusal: { code: "subagent_not_found" } });
    expect(await service.get("user-b", theirs.id)).not.toBeNull();
  });

  it("refuses a definition on a model the user lost, or when their models cannot be read, and always lets the default go", async () => {
    const memory = new MemorySubagentDefinitionStore();
    let models: SubagentModelOption[] | null = MODELS;
    const service = createSubagentDefinitionService({ db: immediateTransactionDb<SubagentDefinitionDb>(), models: async () => models, store: memory.store });
    const { first, second } = await two(service);
    await service.setDefault("user-a", first.id, null);
    models = [MODELS[1]!];
    expect(await service.setDefault("user-a", second.id, first.id)).toMatchObject({ ok: false, refusal: { code: "subagent_model_unavailable" } });
    models = null;
    expect(await service.setDefault("user-a", second.id, first.id)).toMatchObject({ ok: false, refusal: { code: "subagent_catalog_unavailable" } });
    expect(await service.readDefault("user-a")).toBe(first.id);
    expect(await service.setDefault("user-a", null, first.id)).toEqual({ ok: true, value: null });
  });

  it("goes back to the built-in when the default is deleted", async () => {
    const { service } = setup();
    const { first, second } = await two(service);
    await service.setDefault("user-a", first.id, null);
    await service.remove("user-a", second.id, 1);
    expect(await service.readDefault("user-a")).toBe(first.id);
    await service.remove("user-a", first.id, 1);
    expect(await service.readDefault("user-a")).toBeNull();
    expect((await service.list("user-a")).defaultDefinitionId).toBeNull();
  });

  describe("Undo of a change that moved it", () => {
    it("deletes a created default and puts the earlier default back, or the built-in", async () => {
      const { service } = setup();
      const { first, second } = await two(service);
      await service.setDefault("user-a", second.id, null);
      await service.setDefault("user-a", first.id, second.id);
      expect(await service.undoDefaultChange("user-a", { definition: { expectedVersion: 1, id: first.id, revisionId: null },
        restore: { expected: first.id, target: second.id } })).toEqual({ ok: true, value: "restored" });
      expect(await service.get("user-a", first.id)).toBeNull();
      expect(await service.readDefault("user-a")).toBe(second.id);
      expect(await service.undoDefaultChange("user-a", { definition: { expectedVersion: 1, id: second.id, revisionId: null },
        restore: { expected: second.id, target: null } })).toEqual({ ok: true, value: "restored" });
      expect(await service.readDefault("user-a")).toBeNull();
    });

    it("restores an edit's revision and the earlier default together", async () => {
      const { service } = setup();
      const { first, second } = await two(service);
      await service.setDefault("user-a", first.id, null);
      const edited = await service.update("user-a", second.id, 1, draft({ instructions: "Edited.", name: "second" }));
      if (!edited.ok) throw new Error("edit failed");
      await service.setDefault("user-a", second.id, first.id);
      expect(await service.undoDefaultChange("user-a", { definition: { expectedVersion: 2, id: second.id, revisionId: second.revisionId },
        restore: { expected: second.id, target: first.id } })).toEqual({ ok: true, value: "restored" });
      expect(await service.get("user-a", second.id)).toMatchObject({ instructions: second.instructions, version: 3 });
      expect(await service.readDefault("user-a")).toBe(first.id);
    });

    it("puts a move alone back, a cleared default included, even onto a model the user lost", async () => {
      const memory = new MemorySubagentDefinitionStore();
      let models: SubagentModelOption[] = MODELS;
      const service = createSubagentDefinitionService({ db: immediateTransactionDb<SubagentDefinitionDb>(), models: async () => models, store: memory.store });
      const { first } = await two(service);
      await service.setDefault("user-a", first.id, null);
      await service.setDefault("user-a", null, first.id);
      models = [];
      expect(await service.undoDefaultChange("user-a", { restore: { expected: null, target: first.id } })).toEqual({ ok: true, value: "restored" });
      expect(await service.readDefault("user-a")).toBe(first.id);
    });

    it("keeps a later move of the default, and still reverses the definition's own change", async () => {
      const { service } = setup();
      const { first, second } = await two(service);
      await service.setDefault("user-a", first.id, null);
      await service.setDefault("user-a", second.id, first.id);
      expect(await service.undoDefaultChange("user-a", { restore: { expected: first.id, target: null } })).toEqual({ ok: true, value: "changed" });
      expect(await service.readDefault("user-a")).toBe(second.id);
      expect(await service.undoDefaultChange("user-a", { definition: { expectedVersion: 1, id: first.id, revisionId: null },
        restore: { expected: first.id, target: null } })).toEqual({ ok: true, value: "changed" });
      expect(await service.get("user-a", first.id)).toBeNull();
      expect(await service.readDefault("user-a")).toBe(second.id);
    });

    it("leaves the built-in when the earlier default no longer exists, and says so", async () => {
      const { service } = setup();
      const { first, second } = await two(service);
      await service.setDefault("user-a", first.id, null);
      await service.setDefault("user-a", second.id, first.id);
      await service.remove("user-a", first.id, 1);
      expect(await service.undoDefaultChange("user-a", { restore: { expected: second.id, target: first.id } })).toEqual({ ok: true, value: "target_gone" });
      expect(await service.readDefault("user-a")).toBeNull();
    });

    it("changes nothing when the definition moved on", async () => {
      const { service } = setup();
      const { first, second } = await two(service);
      await service.setDefault("user-a", first.id, null);
      await service.setDefault("user-a", second.id, first.id);
      await service.update("user-a", second.id, 1, draft({ instructions: "Edited.", name: "second" }));
      expect(await service.undoDefaultChange("user-a", { definition: { expectedVersion: 1, id: second.id, revisionId: null },
        restore: { expected: second.id, target: first.id } })).toMatchObject({ ok: false, refusal: { code: "subagent_definition_conflict" } });
      expect(await service.get("user-a", second.id)).not.toBeNull();
      expect(await service.readDefault("user-a")).toBe(second.id);
    });
  });
});
