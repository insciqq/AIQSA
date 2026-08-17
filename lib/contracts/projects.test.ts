import { describe, expect, it } from "vitest";
import {
  decodeProjectDefaults,
  decodeProjectKnowledgeCitationResponse,
  decodeProjectPolicy,
  decodeProjectsResponse
} from "./projects";

describe("Project wire contracts", () => {
  it("normalizes bounded defaults and keeps Off explicit", () => {
    expect(decodeProjectDefaults({})).toEqual({
      defaults: {
        assistantId: null,
        controlValues: {},
        knowledgePlan: { baseIds: [] },
        mcpMode: "off",
        providerModelId: null,
        searchPlan: { mode: "all_selected", optionIds: [] }
      },
      ok: true
    });
    expect(decodeProjectDefaults({ mcpMode: "personal" })).toEqual({ ok: false });
    expect(decodeProjectDefaults({ assistantId: "   " })).toEqual({ ok: false });
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

  it("accepts only bounded client-safe Project citation evidence", () => {
    const response = {
      citation: {
        baseName: "Engineering handbook",
        fileName: "retrieval-policy.pdf",
        handle: "K1.1",
        page: 18,
        text: "Accepted passage",
        textTruncated: false
      }
    };
    expect(decodeProjectKnowledgeCitationResponse(response)).toEqual(response);
    expect(decodeProjectKnowledgeCitationResponse({
      citation: { ...response.citation, handle: "K9.9" }
    })).toBeNull();
    expect(decodeProjectKnowledgeCitationResponse({
      citation: { ...response.citation, text: "x".repeat(64 * 1_024 + 1) }
    })).toBeNull();
  });
});
