import type { AssistantDraft } from "@/lib/contracts/assistants";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAssistant,
  deleteAssistant,
  duplicateAssistant,
  fetchAssistantDeletionConsequences,
  publishAssistant,
  requestAssistantListing,
  setAssistantFeaturedOrder,
  withdrawAssistantListingRequest
} from "./assistantsApi";

const mocks = vi.hoisted(() => ({ shellFetch: vi.fn() }));

vi.mock("@/components/app-shell/shellApi", () => ({ shellFetch: mocks.shellFetch }));

const avatar = {
  accents: [0, 4],
  backgroundShape: "circle",
  foregroundShape: "diamond",
  kind: "generated",
  paletteId: "ocean",
  recipeVersion: 1,
  rotations: [0, 2]
} as const satisfies AssistantDraft["avatar"];

const draft: AssistantDraft = {
  answerRules: null,
  avatar: { ...avatar, accents: [...avatar.accents], rotations: [...avatar.rotations] },
  category: null,
  description: "",
  name: "Reviewer",
  responseReminder: "",
  rows: {
    controls: { policy: "adjustable", value: {} },
    knowledge: { policy: "adjustable", value: { mode: "none" } },
    model: { policy: "adjustable", value: { mode: "inherit" } },
    search: { policy: "adjustable", value: { mode: "inherit" } },
    skills: { policy: "adjustable", value: { links: [], mode: "auto" } },
    tools: { policy: "adjustable", value: { mode: "inherit" } }
  },
  starterPrompts: [],
  systemPrompt: ""
};

const listing = {
  canRequest: false,
  canWithdraw: true,
  listed: false,
  request: {
    createdAt: "2026-09-28T00:00:00.000Z",
    definitionVersion: 3,
    id: "request-1",
    outdated: false,
    reviewNote: null,
    reviewedAt: null,
    state: "pending"
  }
};

function detailJson() {
  return {
    archived: false,
    audience: { everyone: false, groupNames: [] },
    availability: { ok: true },
    content: {
      answerRules: null,
      avatar,
      category: null,
      description: "",
      knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      mcpServerIds: [],
      name: "Reviewer (copy)",
      providerModelId: null,
      rows: draft.rows,
      runControls: {},
      searchPlan: { mode: "all_selected", optionIds: [] },
      skillIds: [],
      starterPrompts: [],
      systemPrompt: ""
    },
    featured: false,
    featuredOrder: null,
    id: "assistant-2",
    owned: true,
    ownerDisplayName: "Dana",
    pinned: false,
    rowAvailability: {},
    scope: { kind: "owner" },
    updatedAt: "2026-09-28T00:00:00.000Z",
    version: 1
  };
}

beforeEach(() => vi.resetAllMocks());

describe("Assistants API errors", () => {
  it("preserves bounded run-control field and limit metadata", async () => {
    mocks.shellFetch.mockResolvedValue(Response.json({
      error: "assistant_run_controls_invalid",
      field: "maxOutputTokens",
      limit: 8192,
      row: "controls"
    }, { status: 400 }));

    await expect(createAssistant(draft)).resolves.toEqual({
      code: "assistant_run_controls_invalid",
      field: "maxOutputTokens",
      limit: 8192,
      message: "The assistant request could not be completed.",
      ok: false,
      row: "controls",
      status: 400
    });
    expect(JSON.parse(mocks.shellFetch.mock.calls[0]![1].body)).toEqual(draft);
  });

  it("drops unknown or non-finite error metadata", async () => {
    mocks.shellFetch.mockResolvedValue(Response.json({
      error: "assistant_run_controls_invalid",
      field: "providerSecret",
      limit: "8192",
      row: "secrets",
      skills: "Reviewer"
    }, { status: 400 }));

    await expect(createAssistant(draft)).resolves.toEqual({
      code: "assistant_run_controls_invalid",
      message: "The assistant request could not be completed.",
      ok: false,
      status: 400
    });
  });

  it("names the Skills that block an audience", async () => {
    mocks.shellFetch.mockResolvedValue(Response.json({
      error: "assistant_skill_audience_mismatch",
      message: "Share every included Skill with this audience before publishing the Assistant.",
      skills: ["Incident brief", "", 4]
    }, { status: 409 }));

    await expect(publishAssistant("assistant-1", { groupId: "group-1", scope: "group" })).resolves.toMatchObject({
      code: "assistant_skill_audience_mismatch",
      ok: false,
      skills: ["Incident brief"],
      status: 409
    });
  });
});

describe("Assistants API routes", () => {
  it("reads the duplicate report next to the copy", async () => {
    mocks.shellFetch.mockResolvedValue(Response.json({
      assistant: detailJson(),
      report: { downgradedRows: ["tools"], droppedSkillCount: 1 }
    }, { status: 201 }));

    await expect(duplicateAssistant("assistant-1")).resolves.toMatchObject({
      data: { assistant: { id: "assistant-2" }, report: { downgradedRows: ["tools"], droppedSkillCount: 1 } },
      ok: true
    });
    expect(mocks.shellFetch).toHaveBeenCalledWith("/api/me/assistants/assistant-1/duplicate", { method: "POST" });
  });

  it("reads the consequences and deletes at the confirmed version", async () => {
    mocks.shellFetch
      .mockResolvedValueOnce(Response.json({
        consequences: {
          audiences: { groupNames: ["Platform"], installation: false },
          chatCount: 3,
          hiddenProjectCount: 1,
          pendingListingRequest: false,
          projects: [{ isDefault: true, name: "Support" }],
          version: 7
        }
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(fetchAssistantDeletionConsequences("assistant-1")).resolves.toMatchObject({
      data: { chatCount: 3, projects: [{ isDefault: true, name: "Support" }], version: 7 },
      ok: true
    });
    await expect(deleteAssistant("assistant-1", 7)).resolves.toEqual({ data: undefined, ok: true });
    expect(mocks.shellFetch).toHaveBeenLastCalledWith("/api/me/assistants/assistant-1", {
      body: JSON.stringify({ expectedVersion: 7 }),
      headers: { "content-type": "application/json" },
      method: "DELETE"
    });
  });

  it("requests and withdraws listing with the owner's status in return", async () => {
    mocks.shellFetch
      .mockResolvedValueOnce(Response.json({ listing }))
      .mockResolvedValueOnce(Response.json({ listing: { ...listing, canRequest: true, canWithdraw: false, request: null } }));

    await expect(requestAssistantListing("assistant-1", 3)).resolves.toMatchObject({
      data: { canWithdraw: true, request: { id: "request-1", state: "pending" } },
      ok: true
    });
    expect(mocks.shellFetch.mock.calls[0]).toEqual(["/api/me/assistants/assistant-1/listing-requests", {
      body: JSON.stringify({ expectedVersion: 3 }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }]);
    await expect(withdrawAssistantListingRequest("assistant-1", "request-1")).resolves.toMatchObject({
      data: { canRequest: true, request: null },
      ok: true
    });
    expect(mocks.shellFetch.mock.calls[1]).toEqual([
      "/api/me/assistants/assistant-1/listing-requests/request-1",
      { method: "DELETE" }
    ]);
  });

  it("sets a Featured position and rejects a malformed order", async () => {
    mocks.shellFetch
      .mockResolvedValueOnce(Response.json({ featured: [{ assistantId: "assistant-1", featuredOrder: 0 }] }))
      .mockResolvedValueOnce(Response.json({ featured: [{ assistantId: "assistant-1", featuredOrder: 9 }] }));

    await expect(setAssistantFeaturedOrder("assistant-1", 0)).resolves.toEqual({
      data: [{ assistantId: "assistant-1", featuredOrder: 0 }],
      ok: true
    });
    expect(mocks.shellFetch.mock.calls[0]).toEqual(["/api/admin/assistants/assistant-1/featured", {
      body: JSON.stringify({ order: 0 }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }]);
    await expect(setAssistantFeaturedOrder("assistant-1", null)).resolves.toMatchObject({
      code: "assistant_response_invalid",
      ok: false
    });
  });
});
