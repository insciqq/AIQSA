import { describe, expect, it } from "vitest";
import { decodeResourceChangeCard, foldResourceChangeCards, resourceChangeCardKey, type SubagentChangeCard } from "./resourceChanges";
import {
  decodeSubagentDefaultResponse,
  decodeSubagentDefaultUndoRequest,
  decodeSubagentDefaultUndoResponse,
  decodeSubagentDefaultUpdateRequest,
  decodeSubagentDefinitionDeleteRequest,
  decodeSubagentDefinitionDraft,
  decodeSubagentDefinitionListResponse,
  decodeSubagentDefinitionRestoreRequest,
  decodeSubagentDefinitionUpdateRequest,
  decodeSubagentDefinitionView,
  subagentDefinitionPath,
  subagentDefinitionRestorePath,
  subagentModelLabel,
  subagentModelReferenceKey
} from "./subagentDefinitions";
import { SUBAGENT_DEFINITION_LIMITS } from "./subagents";

const DRAFT = { description: " Long browsing. ", effort: "low", instructions: " Browse. ", modelId: "model-cheap", name: " Browser ",
  tools: ["web_search", "workspace"] };

const VIEW = { description: "Long browsing.", effort: "low", id: "def_1", instructions: "Browse.", modelAvailable: true, modelDisplayName: "Cheap",
  modelId: "model-cheap", name: "browser", previousRevisionId: null, revisionId: "rev_1", revisionNumber: 1, tools: null,
  updatedAt: "2026-10-30T10:00:00.000Z", version: 1 };

describe("custom sub-agent wire contract", () => {
  it("normalizes a draft and keeps tool groups in the vocabulary's order", () => {
    expect(decodeSubagentDefinitionDraft(DRAFT)).toEqual({ ok: true, draft: { description: "Long browsing.", effort: "low", instructions: "Browse.",
      modelId: "model-cheap", name: "browser", tools: ["workspace", "web_search"] } });
  });

  it("names the field of an invalid draft", () => {
    const field = (patch: Record<string, unknown>) => {
      const decoded = decodeSubagentDefinitionDraft({ ...DRAFT, ...patch });
      return decoded.ok ? null : [decoded.code, decoded.field];
    };
    expect(field({ name: "main" })).toEqual(["subagent_name_invalid", "name"]);
    expect(field({ name: "has space" })).toEqual(["subagent_name_invalid", "name"]);
    expect(field({ description: "" })).toEqual(["subagent_definition_invalid", "description"]);
    expect(field({ description: "x".repeat(SUBAGENT_DEFINITION_LIMITS.descriptionCharacters + 1) })).toEqual(["subagent_definition_invalid", "description"]);
    expect(field({ instructions: "a\0b" })).toEqual(["subagent_definition_invalid", "instructions"]);
    expect(field({ modelId: "" })).toEqual(["subagent_model_unavailable", "model"]);
    expect(field({ effort: 3 })).toEqual(["subagent_effort_unsupported", "effort"]);
    expect(field({ tools: ["workspace", "workspace"] })).toEqual(["subagent_definition_invalid", "tools"]);
    expect(field({ tools: ["call_subagent"] })).toEqual(["subagent_definition_invalid", "tools"]);
    expect(field({ extra: true })).not.toBeNull();
    expect(field({ effort: null, modelId: null, tools: null })).toBeNull();
  });

  it("decodes requests, views and lists exactly", () => {
    expect(decodeSubagentDefinitionUpdateRequest({ draft: DRAFT, expectedVersion: 2 })).toEqual({ draft: DRAFT, expectedVersion: 2 });
    expect(decodeSubagentDefinitionUpdateRequest({ draft: DRAFT, expectedVersion: 0 })).toBeNull();
    expect(decodeSubagentDefinitionDeleteRequest({ expectedVersion: 1 })).toEqual({ expectedVersion: 1 });
    expect(decodeSubagentDefinitionDeleteRequest({})).toBeNull();
    expect(decodeSubagentDefinitionRestoreRequest({ expectedVersion: 1, revisionId: "../x" })).toBeNull();
    expect(decodeSubagentDefinitionView(VIEW)).toEqual(VIEW);
    // A definition saved under the reserved type before it was reserved keeps reading, so the whole list never fails over it.
    expect(decodeSubagentDefinitionView({ ...VIEW, name: "built-in" })).toEqual({ ...VIEW, name: "built-in" });
    expect(decodeSubagentDefinitionView({ ...VIEW, ownerUserId: "u" })).toBeNull();
    expect(decodeSubagentDefinitionView({ ...VIEW, name: "Browser" })).toBeNull();
    const { instructions: _i, previousRevisionId: _p, revisionId: _r, ...summary } = VIEW;
    const models = [{ connectionName: "Codex LB", defaultEffort: null, displayName: "Cheap", efforts: ["low"], modelId: "model-cheap" }];
    const list = { defaultDefinitionId: null, definitions: [summary], limit: 50, models };
    expect(decodeSubagentDefinitionListResponse(list)).toEqual(list);
    expect(decodeSubagentDefinitionListResponse({ ...list, definitions: [VIEW] })).toBeNull();
    // A model always comes with its connection, so same-named models stay distinguishable.
    const { connectionName: _c, ...unlabelled } = models[0]!;
    expect(decodeSubagentDefinitionListResponse({ ...list, models: [unlabelled] })).toBeNull();
    expect(subagentModelLabel(models[0]!)).toBe("Cheap · Codex LB");
    expect(subagentModelReferenceKey(" GPT-6  Luna · Codex LB ")).toBe("gpt-6luna·codexlb");
    expect(subagentDefinitionPath("def/1")).toBe("/api/me/subagents/def%2F1");
    expect(subagentDefinitionRestorePath("def_1")).toBe("/api/me/subagents/def_1/restore");
  });

  it("reads the default only as one of the listed definitions, and fails a list that says otherwise", () => {
    const { instructions: _i, previousRevisionId: _p, revisionId: _r, ...summary } = VIEW;
    const list = { defaultDefinitionId: "def_1", definitions: [summary], limit: 50, models: [] };
    expect(decodeSubagentDefinitionListResponse(list)).toEqual(list);
    expect(decodeSubagentDefinitionListResponse({ ...list, defaultDefinitionId: "def_gone" })).toBeNull();
    expect(decodeSubagentDefinitionListResponse({ ...list, defaultDefinitionId: 7 })).toBeNull();
    const { defaultDefinitionId: _d, ...withoutDefault } = list;
    expect(decodeSubagentDefinitionListResponse(withoutDefault)).toBeNull();
  });

  it("decodes the default's routes exactly", () => {
    expect(decodeSubagentDefaultUpdateRequest({ definitionId: "def_1", expected: null })).toEqual({ definitionId: "def_1", expected: null });
    expect(decodeSubagentDefaultUpdateRequest({ definitionId: null, expected: "def_1" })).toEqual({ definitionId: null, expected: "def_1" });
    expect(decodeSubagentDefaultUpdateRequest({ definitionId: "def_1" })).toBeNull();
    expect(decodeSubagentDefaultUpdateRequest({ definitionId: "../x", expected: null })).toBeNull();
    const restore = { expected: "def_1", target: null };
    expect(decodeSubagentDefaultUndoRequest({ restore })).toEqual({ restore });
    const definition = { expectedVersion: 2, id: "def_1", revisionId: "rev_1" };
    expect(decodeSubagentDefaultUndoRequest({ definition, restore })).toEqual({ definition, restore });
    expect(decodeSubagentDefaultUndoRequest({ definition: { ...definition, revisionId: null }, restore })).toEqual({ definition: { ...definition, revisionId: null }, restore });
    expect(decodeSubagentDefaultUndoRequest({ definition: { ...definition, expectedVersion: 0 }, restore })).toBeNull();
    expect(decodeSubagentDefaultUndoRequest({ definition: { id: "def_1", revisionId: null }, restore })).toBeNull();
    expect(decodeSubagentDefaultUndoRequest({ restore: { expected: "def_1" } })).toBeNull();
    expect(decodeSubagentDefaultUndoRequest({ restore, extra: true })).toBeNull();
    expect(decodeSubagentDefaultResponse({ defaultDefinitionId: null })).toEqual({ defaultDefinitionId: null });
    expect(decodeSubagentDefaultResponse({ defaultDefinitionId: "" })).toBeNull();
    expect(decodeSubagentDefaultResponse({})).toBeNull();
    expect(decodeSubagentDefaultUndoResponse({ outcome: "target_gone" })).toEqual({ outcome: "target_gone" });
    expect(decodeSubagentDefaultUndoResponse({ outcome: "maybe" })).toBeNull();
  });
});

const CARD: SubagentChangeCard = { version: 1, resource: "subagent", action: "updated", definitionId: "def_1", definitionVersion: 2, name: "web",
  previousName: "browser", changes: [{ field: "name", summary: "browser → web" }, { field: "instructions", summary: null }],
  instructionsDiff: { lines: [{ kind: "add", text: "More." }], truncated: false }, undoRevisionId: "rev_1", consequences: null, proposalId: null };

describe("custom sub-agent change card", () => {
  it("decodes the three actions and keys changes by version and proposals by identity", () => {
    expect(decodeResourceChangeCard(CARD)).toEqual(CARD);
    const created = { ...CARD, action: "created", previousName: null, changes: [], instructionsDiff: null, undoRevisionId: null };
    expect(decodeResourceChangeCard(created)).toEqual(created);
    const proposal = { ...created, action: "delete_proposed", consequences: { threadCount: 2 }, proposalId: "p-1" };
    expect(decodeResourceChangeCard(proposal)).toEqual(proposal);
    expect(resourceChangeCardKey(CARD)).toBe("subagent:def_1:updated:2");
    expect(resourceChangeCardKey(proposal as SubagentChangeCard)).toBe("subagent:def_1:proposal:p-1");
  });

  it("drops cards whose fields do not fit their action", () => {
    expect(decodeResourceChangeCard({ ...CARD, undoRevisionId: null })).toBeNull();
    expect(decodeResourceChangeCard({ ...CARD, action: "created" })).toBeNull();
    expect(decodeResourceChangeCard({ ...CARD, consequences: { threadCount: 1 } })).toBeNull();
    expect(decodeResourceChangeCard({ ...CARD, proposalId: "p-1" })).toBeNull();
    expect(decodeResourceChangeCard({ ...CARD, name: "x".repeat(49) })).toBeNull();
    expect(decodeResourceChangeCard({ ...CARD, changes: [{ field: "owner", summary: null }] })).toBeNull();
    expect(decodeResourceChangeCard({ ...CARD, action: "delete_proposed", previousName: null, changes: [], instructionsDiff: null, undoRevisionId: null,
      consequences: null, proposalId: "p-1" })).toBeNull();
  });

  const CREATED = { ...CARD, action: "created", previousName: null, changes: [], instructionsDiff: null, undoRevisionId: null } as const;
  const MOVED = { ...CARD, changes: [{ field: "default", summary: "Now the default; before: the built-in sub-agent" }], instructionsDiff: null,
    previousName: null, undoRevisionId: null, defaultChange: { changeId: "move-1", isDefault: true, previous: null } } as const;

  it("carries a moved default on a creation and an edit, with or without a revision to restore", () => {
    const previous = { definitionId: "def_0", name: "browser" };
    const created = { ...CREATED, defaultChange: { changeId: "move-0", isDefault: true, previous } };
    expect(decodeResourceChangeCard(created)).toEqual(created);
    expect(decodeResourceChangeCard(MOVED)).toEqual(MOVED);
    const both = { ...CARD, changes: [...CARD.changes, { field: "default", summary: "Now the default" }], defaultChange: MOVED.defaultChange };
    expect(decodeResourceChangeCard(both)).toEqual(both);
    const cleared = { ...MOVED, defaultChange: { changeId: "move-2", isDefault: false, previous: { definitionId: "def_1", name: "web" } } };
    expect(decodeResourceChangeCard(cleared)).toEqual(cleared);
    // A card saved before defaults keeps its shape and its key.
    expect(resourceChangeCardKey(decodeResourceChangeCard(CARD) as SubagentChangeCard)).toBe("subagent:def_1:updated:2");
  });

  it("drops a moved default that does not fit its card", () => {
    expect(decodeResourceChangeCard({ ...MOVED, defaultChange: undefined })).toBeNull();
    expect(decodeResourceChangeCard({ ...MOVED, changes: [{ field: "name", summary: "a → b" }] })).toBeNull();
    expect(decodeResourceChangeCard({ ...MOVED, defaultChange: { changeId: "../x", isDefault: true, previous: null } })).toBeNull();
    expect(decodeResourceChangeCard({ ...MOVED, defaultChange: { changeId: "m", isDefault: "yes", previous: null } })).toBeNull();
    // Stopping being the default moves it from this one; becoming it, from anything else.
    expect(decodeResourceChangeCard({ ...MOVED, defaultChange: { changeId: "m", isDefault: false, previous: null } })).toBeNull();
    expect(decodeResourceChangeCard({ ...MOVED, defaultChange: { changeId: "m", isDefault: true, previous: { definitionId: "def_1", name: "web" } } })).toBeNull();
    expect(decodeResourceChangeCard({ ...CREATED, action: "delete_proposed", consequences: { threadCount: 0 }, proposalId: "p-1",
      defaultChange: MOVED.defaultChange })).toBeNull();
    expect(decodeResourceChangeCard({ ...MOVED, name: "web", defaultChange: { ...MOVED.defaultChange, previous: { definitionId: "def_0", name: "x".repeat(49) } } })).toBeNull();
  });

  it("keeps two moves of one answer apart, since neither changes the definition's version", () => {
    const off = { ...MOVED, defaultChange: { changeId: "move-off", isDefault: false, previous: { definitionId: "def_1", name: "web" } } };
    const onAgain = { ...MOVED, defaultChange: { ...MOVED.defaultChange, changeId: "move-again" } };
    expect(foldResourceChangeCards([MOVED, off, onAgain, MOVED]).map((card) => resourceChangeCardKey(card))).toEqual([
      "subagent:def_1:updated:2:default:move-1", "subagent:def_1:updated:2:default:move-off", "subagent:def_1:updated:2:default:move-again"]);
  });

  it("names a default in a deletion's consequences only when it is one", () => {
    const proposal = { ...CREATED, action: "delete_proposed", consequences: { isDefault: true, threadCount: 0 }, proposalId: "p-1" };
    expect(decodeResourceChangeCard(proposal)).toEqual(proposal);
    expect(decodeResourceChangeCard({ ...proposal, consequences: { isDefault: false, threadCount: 0 } })).toBeNull();
    expect(decodeResourceChangeCard({ ...proposal, consequences: { isDefault: true } })).toBeNull();
  });
});
