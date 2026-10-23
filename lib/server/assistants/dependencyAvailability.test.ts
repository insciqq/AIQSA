import { beforeEach, describe, expect, it, vi } from "vitest";
import { withAssistantDependencyAvailability } from "./dependencyAvailability";
import type { AssistantAccessEntry } from "./prismaRepository";
import { assistantRowsFromLegacyFields } from "../../contracts/assistants";
import { estimateApproxTokens } from "../../domain/contextBudget";

function entry(overrides: Partial<AssistantAccessEntry> = {}): AssistantAccessEntry {
  return {
    id: "assistant", archived: false, audience: { everyone: false, groupNames: [] }, featured: false, featuredOrder: null, owned: true, pinned: false, published: false,
    installationScope: false, memberGroupNames: [], ownerDisplayName: "Owner", updatedAt: new Date(), version: 1,
    content: { answerRules: null, id: "assistant", avatar: {}, category: null, description: "",
      mcpServerIds: [], name: "Reviewer", providerModelId: "model", runControls: {}, searchPlan: {}, skillIds: [],
      rows: assistantRowsFromLegacyFields({
        mcpServerIds: [], providerModelId: "model", runControls: {}, searchPlan: { mode: "all_selected", optionIds: [] }, skillIds: []
      }),
      starterPrompts: [], systemPrompt: "Review the task." },
    ...overrides
  };
}

describe("Assistant dependency preflight", () => {
  beforeEach(() => vi.clearAllMocks());

  it("batches Skill metadata in one read for every Assistant", async () => {
    const findMany = vi.fn(async () => [
      { id: "ready", ownerUserId: "runner", archivedAt: null, currentRevision: { name: "Ready workflow", instructions: "Read carefully." } },
      { id: "archived", ownerUserId: "runner", archivedAt: new Date(), currentRevision: { name: "Archived workflow", instructions: "Old workflow." } }
    ]);
    const owner = entry();
    owner.content.skillIds = ["ready", "revoked", "archived"];
    const entries = await withAssistantDependencyAvailability({ skillDefinition: { findMany } } as never, "runner", [owner, { ...owner, owned: false }]);
    expect(findMany).toHaveBeenCalledOnce();
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { AND: [
      { id: { in: ["ready", "revoked", "archived"] }, deletedAt: null }, expect.any(Object)
    ] } }));
    expect(entries.map(({ dependencyAvailability }) => dependencyAvailability)).toEqual([
      { skills: false }, { skills: false }
    ]);
    expect(entries[0]!.content.skillSummaries).toEqual([
      { id: "ready", name: "Ready workflow", available: true, instructionApproxTokens: estimateApproxTokens("Read carefully.") },
      { id: "revoked", name: "Unavailable Skill", available: false },
      { id: "archived", name: "Archived workflow", available: false, instructionApproxTokens: estimateApproxTokens("Old workflow.") }
    ]);
    expect(entries[1]!.content.skillSummaries?.map(({ id }) => id)).toEqual(["ready", "archived"]);
    expect(JSON.stringify(entries)).not.toMatch(/Read carefully|Old workflow/);
  });

  it("reads nothing for Assistants without Skills", async () => {
    const findMany = vi.fn();
    const [assistant] = await withAssistantDependencyAvailability({ skillDefinition: { findMany } } as never, "runner", [entry()]);
    expect(findMany).not.toHaveBeenCalled();
    expect(assistant?.dependencyAvailability).toEqual({ skills: true });
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
    const result = await withAssistantDependencyAvailability({ skillDefinition: { findMany } } as never, "runner", [assistant]);
    expect(result[0]?.content.skillSummaries).toEqual([
      { id: "shared", name: "Approved workflow", available: true, instructionApproxTokens: estimateApproxTokens("Проверь 🙂") },
      { id: "owned", name: "My latest workflow", available: true, instructionApproxTokens: estimateApproxTokens("Current owned instructions") },
      { id: "invisible", name: "Unavailable Skill", available: false }
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Private revision name|Private current instructions|Current owned instructions|Проверь|My older approval/);
  });
});
