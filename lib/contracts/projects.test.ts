import { describe, expect, it } from "vitest";
import {
  decodeProjectDefaults,
  decodeProjectDefaultsInput,
  decodeProjectPolicy,
  decodeProjectsResponse
} from "./projects";

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
});
