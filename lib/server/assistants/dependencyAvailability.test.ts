import { beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeRunAdmissionError, loadKnowledgeRunAdmissionPlan } from "../knowledge/runAdmission";
import { withAssistantDependencyAvailability } from "./dependencyAvailability";
import type { AssistantAccessEntry } from "./prismaRepository";

vi.mock("../knowledge/runAdmission", async (importOriginal) => ({
  ...await importOriginal<typeof import("../knowledge/runAdmission")>(), loadKnowledgeRunAdmissionPlan: vi.fn()
}));
const loadKnowledge = vi.mocked(loadKnowledgeRunAdmissionPlan);

function entry(overrides: Partial<AssistantAccessEntry> = {}): AssistantAccessEntry {
  return {
    id: "assistant", archived: false, owned: true, pinned: false, published: false, installationScope: false,
    memberGroupNames: [], ownerDisplayName: "Owner", updatedAt: new Date(), version: 1,
    content: { id: "assistant", avatar: {}, category: null, description: "", developerPrompt: null,
      mcpServerIds: [], name: "Reviewer", providerModelId: "model", runControls: {}, searchPlan: {}, skillIds: [],
      knowledgeSelection: { version: 1, mode: "explicit", baseIds: ["selected-base"], sourceIds: [] },
      starterPrompts: [], systemPrompt: "Review the task." },
    ...overrides
  };
}

describe("Assistant dependency preflight", () => {
  beforeEach(() => vi.clearAllMocks());

  it("batches Skill metadata and reuses identical Knowledge admission while preserving a ready subset", async () => {
    const findMany = vi.fn(async () => [
      { id: "ready", archivedAt: null, currentRevision: { name: "Ready workflow" } },
      { id: "archived", archivedAt: new Date(), currentRevision: { name: "Archived workflow" } }
    ]);
    loadKnowledge.mockResolvedValue({ sources: [{}], exclusions: [{ reason: "not_ready", count: 1 }] } as never);
    const owner = entry();
    owner.content.skillIds = ["ready", "revoked", "archived"];
    const entries = await withAssistantDependencyAvailability({ skillDefinition: { findMany } } as never, "runner", [owner, { ...owner, owned: false }]);
    expect(findMany).toHaveBeenCalledOnce();
    expect(JSON.stringify(findMany.mock.calls)).not.toContain("instructions");
    expect(loadKnowledge).toHaveBeenCalledOnce();
    expect(entries.map(({ dependencyAvailability }) => dependencyAvailability)).toEqual([
      { skills: false, knowledge: "ready" }, { skills: false, knowledge: "ready" }
    ]);
    expect(entries[0]!.content.skillSummaries).toEqual([
      { id: "ready", name: "Ready workflow", available: true }, { id: "revoked", name: "Unavailable Skill", available: false },
      { id: "archived", name: "Archived workflow", available: false }
    ]);
    expect(entries[1]!.content.skillSummaries?.map(({ id }) => id)).toEqual(["ready", "archived"]);
  });

  it("distinguishes authorized unready Knowledge from inaccessible Knowledge", async () => {
    loadKnowledge.mockResolvedValueOnce({ sources: [] } as never);
    expect((await withAssistantDependencyAvailability({} as never, "runner", [entry()]))[0]?.dependencyAvailability)
      .toEqual({ skills: true, knowledge: "not_ready" });
    loadKnowledge.mockRejectedValueOnce(new KnowledgeRunAdmissionError());
    expect((await withAssistantDependencyAvailability({} as never, "runner", [entry()]))[0]?.dependencyAvailability?.knowledge).toBe("access_denied");
  });

  it("isolates a failed dependency read and continues checking other Assistants", async () => {
    const good = entry();
    const broken = entry({ id: "broken", content: { ...good.content,
      knowledgeSelection: { version: 1, mode: "explicit", baseIds: ["broken-base"], sourceIds: [] } } });
    const later = entry({ id: "later", content: { ...good.content,
      knowledgeSelection: { version: 1, mode: "explicit", baseIds: ["later-base"], sourceIds: [] } } });
    loadKnowledge.mockResolvedValueOnce({ sources: [{}] } as never);
    loadKnowledge.mockRejectedValueOnce(new Error("database_read_failed"));
    loadKnowledge.mockResolvedValueOnce({ sources: [{}] } as never);
    const result = await withAssistantDependencyAvailability({} as never, "runner", [good, broken, later]);
    expect(result.map(({ id, dependencyAvailability }) => [id, dependencyAvailability?.knowledge]))
      .toEqual([["assistant", "ready"], ["broken", "unavailable"], ["later", "ready"]]);
    expect(JSON.stringify(result)).not.toContain("database_read_failed");
  });
});
