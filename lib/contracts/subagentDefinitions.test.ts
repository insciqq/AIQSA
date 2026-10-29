import { describe, expect, it } from "vitest";
import { decodeResourceChangeCard, resourceChangeCardKey, type SubagentChangeCard } from "./resourceChanges";
import {
  decodeSubagentDefinitionDeleteRequest,
  decodeSubagentDefinitionDraft,
  decodeSubagentDefinitionListResponse,
  decodeSubagentDefinitionRestoreRequest,
  decodeSubagentDefinitionUpdateRequest,
  decodeSubagentDefinitionView,
  subagentDefinitionPath,
  subagentDefinitionRestorePath
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
    expect(decodeSubagentDefinitionView({ ...VIEW, ownerUserId: "u" })).toBeNull();
    expect(decodeSubagentDefinitionView({ ...VIEW, name: "Browser" })).toBeNull();
    const { instructions: _i, previousRevisionId: _p, revisionId: _r, ...summary } = VIEW;
    const models = [{ defaultEffort: null, displayName: "Cheap", efforts: ["low"], modelId: "model-cheap" }];
    expect(decodeSubagentDefinitionListResponse({ definitions: [summary], limit: 50, models })).toEqual({ definitions: [summary], limit: 50, models });
    expect(decodeSubagentDefinitionListResponse({ definitions: [VIEW], limit: 50, models })).toBeNull();
    expect(subagentDefinitionPath("def/1")).toBe("/api/me/subagents/def%2F1");
    expect(subagentDefinitionRestorePath("def_1")).toBe("/api/me/subagents/def_1/restore");
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
});
