import { describe, expect, it, vi } from "vitest";
import type { AssistantRunMaterialization } from "../assistants/runMaterialization";
import { skillCatalogAuthorization } from "./catalogRelevanceAuthority";
import type { SkillRunResolver } from "./runMaterialization";

const pinned = { skillId: "p", revisionId: "p-r", name: "Pinned", instructions: "Pinned body" };
const available = { skillId: "a", revisionId: "a-r", name: "Available", description: "A procedure", instructions: "Available body" };
const assistant: AssistantRunMaterialization = {
  assistantId: "assistant", definitionVersion: 1, name: "Reviewer", developerPrompt: null, systemPrompt: "Review",
  identity: { name: "Reviewer", avatar: { kind: "generated", recipeVersion: 1, paletteId: "ember", backgroundShape: "circle", foregroundShape: "ring", accents: [], rotations: [0, 0] } },
  provider: "provider", providerModelId: "model", runControls: {}, mcpServerIds: [],
  knowledgeSelection: { version: 1, mode: "none", baseIds: [], sourceIds: [] },
  searchPlan: { mode: "all_selected", optionIds: [] }, skillIds: ["p", "a"], skillModes: { p: "pinned", a: "available" }
};

function setup(projectId?: string) {
  const skills = {
    listEnabledForRun: vi.fn<NonNullable<SkillRunResolver["listEnabledForRun"]>>(async () => [available]),
    resolveForRun: vi.fn<SkillRunResolver["resolveForRun"]>(async () => ({ ok: true, skills: [pinned, available] })),
    resolveForProject: vi.fn<NonNullable<SkillRunResolver["resolveForProject"]>>(async () => ({ ok: true, skills: [pinned, available] }))
  };
  const assistants = {
    resolveForRun: vi.fn(async () => ({ ok: true as const, assistant })),
    resolveForProject: vi.fn(async () => ({ ok: true as const, assistant }))
  };
  const authorizeScope = vi.fn(async () => undefined);
  const input = { userId: "owner", ...(projectId ? { projectId } : {}), assistant, assistants, skills,
    pinned: [pinned], available: [available], authorizeScope };
  return { input, skills, assistants, authorizeScope, authorize: skillCatalogAuthorization(input) };
}

describe("Skill relevance current authority", () => {
  it.each([undefined, "project"])("rechecks the complete Assistant dependencies within scope %s", async projectId => {
    const f = setup(projectId);
    await f.authorize();
    expect(f.authorizeScope).toHaveBeenCalledTimes(2);
    const resolver = projectId ? f.skills.resolveForProject : f.skills.resolveForRun;
    expect(resolver).toHaveBeenCalledWith(projectId ?? "owner", ["p", "a"]);
    expect(f.skills.listEnabledForRun).not.toHaveBeenCalled();
    if (projectId) { expect(f.skills.resolveForRun).not.toHaveBeenCalled(); expect(f.assistants.resolveForRun).not.toHaveBeenCalled(); }
  });

  it("rejects a revised or removed Assistant before reading dependencies", async () => {
    const f = setup();
    f.assistants.resolveForRun.mockResolvedValueOnce({ ok: true, assistant: { ...assistant, definitionVersion: 2 } });
    await expect(f.authorize()).rejects.toThrow("skill_catalog_authority_changed");
    expect(f.skills.resolveForRun).not.toHaveBeenCalled();
  });

  it("rejects a removed or replaced available dependency even if the selection would hide it", async () => {
    const f = setup("project");
    for (const replacement of [[pinned], [pinned, { ...available, revisionId: "replacement" }]]) {
      f.skills.resolveForProject.mockResolvedValueOnce({ ok: true, skills: replacement });
      await expect(f.authorize()).rejects.toThrow("skill_catalog_authority_changed");
    }
  });

  it("reauthorizes ordinary Project catalogs without reading personal enabled Skills", async () => {
    const f = setup("project");
    const authorize = skillCatalogAuthorization({ ...f.input, assistant: null });
    await authorize();
    expect(f.assistants.resolveForProject).not.toHaveBeenCalled();
    expect(f.skills.listEnabledForRun).not.toHaveBeenCalled();
    expect(f.skills.resolveForRun).not.toHaveBeenCalled();
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

  it("rejects scope loss during dependency reads", async () => {
    const f = setup();
    f.skills.resolveForRun.mockImplementation(async () => {
      f.authorizeScope.mockRejectedValueOnce(new Error("scope_revoked"));
      return { ok: true, skills: [pinned, available] };
    });
    await expect(f.authorize()).rejects.toThrow("scope_revoked");
  });
});
