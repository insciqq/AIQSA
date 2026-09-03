import { describe, expect, it } from "vitest";
import {
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

  it("decodes only bounded privacy-safe unavailable default categories", () => {
    expect(decodeProjectResponse(projectResponse(["knowledge", "model"]))?.project)
      .toMatchObject({ unavailableDefaults: ["knowledge", "model"] });
    expect(decodeProjectResponse(projectResponse(undefined))?.project.unavailableDefaults)
      .toEqual([]);
    expect(decodeProjectResponse(projectResponse(["model", "model"]))).toBeNull();
    expect(decodeProjectResponse(projectResponse(["private-resource-id"]))).toBeNull();
  });
});
