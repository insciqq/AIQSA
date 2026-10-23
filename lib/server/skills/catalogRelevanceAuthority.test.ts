import { describe, expect, it, vi } from "vitest";
import { assistantRowsFromLegacyFields } from "../../contracts/assistants";
import type { AssistantRunMaterialization } from "../assistants/runMaterialization";
import { skillCatalogAuthorization } from "./catalogRelevanceAuthority";
import type { SkillRunResolver } from "./runMaterialization";

const pinned = { skillId: "p", revisionId: "p-r", name: "Pinned", instructions: "Pinned body" };
const available = { skillId: "a", revisionId: "a-r", name: "Available", description: "A procedure", instructions: "Available body" };
const assistant: AssistantRunMaterialization = {
  assistantId: "assistant", definitionVersion: 1, name: "Reviewer", systemPrompt: "Review",
  identity: { name: "Reviewer", avatar: { kind: "generated", recipeVersion: 1, paletteId: "ember", backgroundShape: "circle", foregroundShape: "ring", accents: [], rotations: [0, 0] } },
  provider: "provider", providerModelId: "model", runControls: {}, mcpServerIds: [],
  searchPlan: { mode: "all_selected", optionIds: [] }, skillIds: ["p", "a"], skillModes: { p: "pinned", a: "available" },
  rows: assistantRowsFromLegacyFields({
    mcpServerIds: [], providerModelId: "model", runControls: {}, searchPlan: { mode: "all_selected", optionIds: [] },
    skillIds: ["p", "a"], skillModes: { p: "pinned", a: "available" } })
};

function setup() {
  const skills = {
    listEnabledForRun: vi.fn<NonNullable<SkillRunResolver["listEnabledForRun"]>>(async () => [available]),
    resolveForRun: vi.fn<SkillRunResolver["resolveForRun"]>(async () => ({ ok: true, skills: [pinned, available] }))
  };
  const assistants = {
    resolveForRun: vi.fn(async () => ({ ok: true as const, assistant }))
  };
  const authorizeScope = vi.fn(async () => undefined);
  const input = { userId: "owner", assistant, assistants, skills, pinned: [pinned], available: [available], authorizeScope };
  return { input, skills, assistants, authorizeScope, authorize: skillCatalogAuthorization(input) };
}

describe("Skill relevance current authority", () => {
  it("rechecks the complete Assistant dependencies for the run's user", async () => {
    const f = setup();
    await f.authorize();
    expect(f.authorizeScope).toHaveBeenCalledTimes(2);
    expect(f.assistants.resolveForRun).toHaveBeenCalledWith("owner", "assistant");
    expect(f.skills.resolveForRun).toHaveBeenCalledWith("owner", ["p", "a"]);
    expect(f.skills.listEnabledForRun).not.toHaveBeenCalled();
  });

  it("rejects a revised or removed Assistant before reading dependencies", async () => {
    const f = setup();
    f.assistants.resolveForRun.mockResolvedValueOnce({ ok: true, assistant: { ...assistant, definitionVersion: 2 } });
    await expect(f.authorize()).rejects.toThrow("skill_catalog_authority_changed");
    expect(f.skills.resolveForRun).not.toHaveBeenCalled();
  });

  it("rejects a removed or replaced available dependency even if the selection would hide it", async () => {
    const f = setup();
    for (const replacement of [[pinned], [pinned, { ...available, revisionId: "replacement" }]]) {
      f.skills.resolveForRun.mockResolvedValueOnce({ ok: true, skills: replacement });
      await expect(f.authorize()).rejects.toThrow("skill_catalog_authority_changed");
    }
  });

  it("detects personal preference and cohort expansion as well as pinned revision changes", async () => {
    const f = setup();
    f.skills.resolveForRun.mockResolvedValue({ ok: true, skills: [pinned] });
    const authorize = skillCatalogAuthorization({ ...f.input, assistant: null });
    await authorize();
    f.skills.listEnabledForRun.mockResolvedValueOnce([available, { ...available, skillId: "new" }]);
    await expect(authorize()).rejects.toThrow("skill_catalog_authority_changed");
    f.skills.resolveForRun.mockResolvedValueOnce({ ok: true, skills: [{ ...pinned, revisionId: "new" }] });
    await expect(authorize()).rejects.toThrow("skill_catalog_authority_changed");
  });

  it("authorizes an Assistant without links over its runner's own enabled Skills (#48)", async () => {
    const f = setup();
    const unlinked: AssistantRunMaterialization = { ...assistant, skillIds: [], skillModes: {},
      rows: assistantRowsFromLegacyFields({ mcpServerIds: [], providerModelId: "model", runControls: {},
        searchPlan: { mode: "all_selected", optionIds: [] }, skillIds: [] }) };
    f.assistants.resolveForRun.mockResolvedValue({ ok: true, assistant: unlinked });
    f.skills.resolveForRun.mockResolvedValue({ ok: true, skills: [pinned] });
    // `p` is the runner's own manual pin on top of the Assistant.
    const authorize = skillCatalogAuthorization({ ...f.input, userId: "runner", assistant: unlinked });
    await authorize();
    expect(f.assistants.resolveForRun).toHaveBeenCalledWith("runner", "assistant");
    expect(f.skills.resolveForRun).toHaveBeenCalledWith("runner", ["p"]);
    expect(f.skills.listEnabledForRun).toHaveBeenCalledWith("runner");
    f.skills.listEnabledForRun.mockResolvedValueOnce([available, { ...available, skillId: "new" }]);
    await expect(authorize()).rejects.toThrow("skill_catalog_authority_changed");
    // Linking a Skill since admission replaces the personal catalog, so the authority changed.
    f.assistants.resolveForRun.mockResolvedValueOnce({ ok: true, assistant });
    await expect(authorize()).rejects.toThrow("skill_catalog_authority_changed");
  });

  it("rejects scope loss during dependency reads", async () => {
    const f = setup();
    f.skills.resolveForRun.mockImplementation(async () => {
      f.authorizeScope.mockRejectedValueOnce(new Error("scope_revoked"));
      return { ok: true, skills: [pinned, available] };
    });
    await expect(f.authorize()).rejects.toThrow("scope_revoked");
  });
});
