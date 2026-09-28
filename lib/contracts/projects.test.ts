import { describe, expect, it } from "vitest";
import {
  assistantContent,
  assistantSummary,
  catalog
} from "@/tests/support/assistantLibraryFixtures";
import {
  decodeProjectDeletionResponse,
  decodeProjectDefaults,
  decodeProjectDefaultsInput,
  decodeProjectPolicy,
  decodeProjectResponse,
  decodeProjectsResponse
} from "./projects";

function projectResponse(unavailableDefaults?: unknown) {
  return {
    project: {
      accessRevision: 1,
      audienceCount: 1,
      capabilities: {
        archiveChats: true,
        manageMembers: true,
        manageMemory: true,
        manageOwners: true,
        manageProject: true,
        mutateChats: true
      },
      chatCount: 0,
      createdAt: "2026-09-03T10:00:00.000Z",
      defaults: {},
      description: "Shared workspace",
      directRole: "OWNER",
      effectiveRole: "OWNER",
      grants: [],
      grantedThrough: [],
      id: "project-1",
      instructions: "",
      instructionsRevision: 1,
      memoryEnabled: false,
      memoryRevision: 1,
      name: "Project",
      policy: { externalToolsEnabled: true },
      policyRevision: 1,
      publicSharingEnabled: false,
      resources: [],
      status: "ACTIVE",
      unavailableDefaults,
      updatedAt: "2026-09-03T10:00:00.000Z"
    }
  };
}

describe("Project wire contracts", () => {
  it("distinguishes accepted, retryable and completed deletion", () => {
    for (const status of ["pending", "failed", "completed"] as const) {
      expect(decodeProjectDeletionResponse({ projectId: "project-1", status })).toEqual({ projectId: "project-1", status });
    }
    expect(decodeProjectDeletionResponse({ projectId: "project-1", deleted: true })).toBeNull();
    expect(decodeProjectDeletionResponse({ projectId: "project-1", status: "unknown" })).toBeNull();
    for (const deletionStatus of ["pending", "failed"] as const) {
      const raw = { project: { ...projectResponse().project, status: "DELETING", deletionStatus } };
      expect(decodeProjectResponse(raw)?.project.deletionStatus).toBe(deletionStatus);
      expect(decodeProjectResponse({ project: { ...raw.project, status: "ACTIVE" } })).toBeNull();
    }
  });

  it("preserves approved Skill instruction estimates and rejects malformed budgets", () => {
    const input = projectResponse();
    const resource = { id: "binding", resourceId: "skill", type: "skill", label: "Approved Skill",
      available: true, reason: null, instructionApproxTokens: 42 };
    const response = { project: { ...input.project, resources: [resource] } };
    expect(decodeProjectResponse(response)?.project.resources[0]?.instructionApproxTokens).toBe(42);
    for (const instructionApproxTokens of [-1, 1.5, "42", null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(decodeProjectResponse({ project: { ...input.project, resources: [{ ...resource, instructionApproxTokens }] } })).toBeNull();
    }
  });

  it("normalizes bounded defaults and keeps Off explicit", () => {
    expect(decodeProjectDefaults({})).toEqual({
      defaults: {
        assistantId: null,
        controlValues: {},
        knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
        mcpMode: "off",
        providerModelId: null,
        searchPlan: { mode: "all_selected", optionIds: [] }
      },
      ok: true
    });
    expect(decodeProjectDefaults({ mcpMode: "personal" })).toEqual({ ok: false });
    expect(decodeProjectDefaults({ assistantId: "   " })).toEqual({ ok: false });
    expect(decodeProjectDefaultsInput({ knowledgePlan: { baseIds: ["legacy-base"] } }))
      .toEqual({ ok: false });
    expect(decodeProjectDefaultsInput({
      knowledgePlan: {
        baseIds: ["base-1"], mode: "explicit", sourceIds: [], version: 1
      }
    })).toMatchObject({ ok: true });
    expect(decodeProjectDefaultsInput({
      knowledgePlan: {
        baseIds: [], mode: "all_my_knowledge", sourceIds: [], version: 1
      }
    })).toEqual({ ok: false });
    expect(decodeProjectDefaultsInput({
      knowledgePlan: {
        baseIds: [], inheritedFrom: "project", mode: "inherited", sourceIds: [], version: 1
      }
    })).toEqual({ ok: false });
    expect(decodeProjectPolicy({ externalToolsEnabled: false })).toEqual({
      ok: true,
      policy: { externalToolsEnabled: false }
    });
  });

  it("rejects malformed project summaries instead of guessing UI authority", () => {
    expect(decodeProjectsResponse({ projects: [{ id: "project" }] })).toBeNull();
    expect(decodeProjectsResponse({
      projects: [{
        accessRevision: 2,
        audienceCount: 3,
        chatCount: 1,
        description: "Shared",
        directRole: "OWNER",
        effectiveRole: "OWNER",
        grantedThrough: [],
        id: "project",
        name: "Research",
        status: "ACTIVE",
        updatedAt: "2026-08-17T00:00:00.000Z"
      }]
    })?.projects[0]?.name).toBe("Research");
  });

  it("decodes Project Assistant entries whose model the Project does not provide", () => {
    const rows = assistantContent().rows;
    const entry = {
      content: assistantContent({
        providerModelId: null,
        rows: {
          ...rows,
          knowledge: { policy: "adjustable", value: { baseIds: [], hiddenCount: 2, mode: "explicit", sourceIds: [] } },
          model: { policy: "adjustable", value: { mode: "model", modelId: null } }
        }
      }),
      promptCharacterCount: 17,
      summary: assistantSummary({
        owned: false,
        ownerDisplayName: "Project",
        rowAvailability: { knowledge: { reason: "knowledge_access" }, model: { reason: "model_access" } },
        scope: { kind: "project", projectName: "Launch" }
      })
    };
    const composer = {
      assistants: [entry],
      catalog: { ...catalog([]), providers: [] },
      knowledgeBases: [],
      knowledgeDocumentTotal: 0,
      knowledgeSources: [],
      mcpServers: []
    };
    const decoded = decodeProjectResponse({ project: { ...projectResponse().project, composer } })
      ?.project.composer?.assistants[0];

    expect(decoded?.summary).toMatchObject({ ownerDisplayName: "Project", scope: { kind: "project", projectName: "Launch" } });
    expect(decoded?.content.providerModelId).toBeNull();
    expect(decoded?.content.rows.model.value).toEqual({ mode: "model", modelId: null });
    expect(decoded?.content.rows.knowledge.value).toMatchObject({ hiddenCount: 2 });
    // An entry whose name disagrees with its summary is still malformed.
    expect(decodeProjectResponse({
      project: { ...projectResponse().project, composer: { ...composer, assistants: [{ ...entry, content: { ...entry.content, name: "Other" } }] } }
    })).toBeNull();
  });

  it("decodes only bounded privacy-safe unavailable default categories", () => {
    expect(decodeProjectResponse(projectResponse(["knowledge", "model"]))?.project)
      .toMatchObject({ unavailableDefaults: ["knowledge", "model"] });
    expect(decodeProjectResponse(projectResponse(undefined))?.project.unavailableDefaults)
      .toEqual([]);
    expect(decodeProjectResponse(projectResponse(["model", "model"]))).toBeNull();
    expect(decodeProjectResponse(projectResponse(["private-resource-id"]))).toBeNull();
  });
});
