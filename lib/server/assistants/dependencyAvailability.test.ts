import { beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeRunAdmissionError, loadKnowledgeRunAdmissionPlan } from "../knowledge/runAdmission";
import { withAssistantDependencyAvailability } from "./dependencyAvailability";
import type { AssistantAccessEntry } from "./prismaRepository";
import { estimateApproxTokens } from "../../domain/contextBudget";

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
      { id: "ready", ownerUserId: "runner", archivedAt: null, currentRevision: { name: "Ready workflow", instructions: "Read carefully." } },
      { id: "archived", ownerUserId: "runner", archivedAt: new Date(), currentRevision: { name: "Archived workflow", instructions: "Old workflow." } }
    ]);
    loadKnowledge.mockResolvedValue({ sources: [{}], exclusions: [{ reason: "not_ready", count: 1 }] } as never);
    const owner = entry();
    owner.content.skillIds = ["ready", "revoked", "archived"];
    const entries = await withAssistantDependencyAvailability({ skillDefinition: { findMany } } as never, "runner", [owner, { ...owner, owned: false }]);
    expect(findMany).toHaveBeenCalledOnce();
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { AND: [
      { id: { in: ["ready", "revoked", "archived"] }, deletedAt: null }, expect.any(Object)
    ] } }));
    expect(loadKnowledge).toHaveBeenCalledOnce();
    expect(entries.map(({ dependencyAvailability }) => dependencyAvailability)).toEqual([
      { skills: false, knowledge: "ready" }, { skills: false, knowledge: "ready" }
    ]);
    expect(entries[0]!.content.skillSummaries).toEqual([
      { id: "ready", name: "Ready workflow", available: true, instructionApproxTokens: estimateApproxTokens("Read carefully.") },
      { id: "revoked", name: "Unavailable Skill", available: false },
      { id: "archived", name: "Archived workflow", available: false, instructionApproxTokens: estimateApproxTokens("Old workflow.") }
    ]);
    expect(entries[1]!.content.skillSummaries?.map(({ id }) => id)).toEqual(["ready", "archived"]);
    expect(JSON.stringify(entries)).not.toMatch(/Read carefully|Old workflow/);
  });

  it("distinguishes authorized unready Knowledge from inaccessible Knowledge", async () => {
    loadKnowledge.mockResolvedValueOnce({ sources: [] } as never);
    expect((await withAssistantDependencyAvailability({} as never, "runner", [entry()]))[0]?.dependencyAvailability)
      .toEqual({ skills: true, knowledge: "not_ready" });
    loadKnowledge.mockRejectedValueOnce(new KnowledgeRunAdmissionError());
    expect((await withAssistantDependencyAvailability({} as never, "runner", [entry()]))[0]?.dependencyAvailability?.knowledge).toBe("access_denied");
  });

  it("uses the caller's current or approved revision estimate and never exposes hidden instructions", async () => {
    const findMany = vi.fn(async () => [{ id: "shared", ownerUserId: "another-owner", archivedAt: null,
      currentRevision: { name: "Private revision name", instructions: "Private current instructions".repeat(100) },
      sharedRevision: { name: "Approved workflow", instructions: "Проверь 🙂" } },
    { id: "owned", ownerUserId: "runner", archivedAt: null,
      currentRevision: { name: "My latest workflow", instructions: "Current owned instructions" },
      sharedRevision: { name: "My older approval", instructions: "Old" } }]);
    const assistant = entry();
    assistant.content.skillIds = ["shared", "owned", "invisible"];
    assistant.content.knowledgeSelection = { version: 1, mode: "none", baseIds: [], sourceIds: [] };
    const result = await withAssistantDependencyAvailability({ skillDefinition: { findMany } } as never, "runner", [assistant]);
    expect(result[0]?.content.skillSummaries).toEqual([
      { id: "shared", name: "Approved workflow", available: true, instructionApproxTokens: estimateApproxTokens("Проверь 🙂") },
      { id: "owned", name: "My latest workflow", available: true, instructionApproxTokens: estimateApproxTokens("Current owned instructions") },
      { id: "invisible", name: "Unavailable Skill", available: false }
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Private revision name|Private current instructions|Current owned instructions|Проверь|My older approval/);
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
