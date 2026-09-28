import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminAssistantReviewNames } from "@/lib/contracts/adminAssistants";
import {
  AdminAssistantsRequestError,
  decideAdminAssistantRequest,
  loadAdminAssistantRequest,
  loadAdminAssistants,
  loadAdminAssistantsPendingCount,
  setAdminAssistantFeatured,
  unlistAdminAssistant
} from "./adminAssistantsApi";
import { adminAssistantsErrorMessage, assistantSetupRows } from "./adminAssistantsPresentation";

const avatar = { accents: [1, 4], backgroundShape: "hexagon", foregroundShape: "circle", kind: "generated", paletteId: "ocean", recipeVersion: 1, rotations: [0, 3] };
const listed = { assistantId: "assistant-1", name: "HR Helper", avatar, ownerDisplayName: "Local Operator", updatedAt: "2026-09-24T10:00:00.000Z",
  listedAt: "2026-09-20T10:00:00.000Z", featuredOrder: 0, chatCount30Days: 38 };
const summary = { id: "request-1", state: "pending", definitionVersion: 3, outdated: false, createdAt: "2026-09-25T10:00:00.000Z",
  reviewedAt: null, reviewNote: null, assistantId: "assistant-2", name: "Writing editor", avatar: null, ownerDisplayName: "Camila Collaborator",
  updatedAt: "2026-09-25T09:00:00.000Z", canReview: true };
const rows = {
  model: { policy: "adjustable", value: { mode: "inherit" } },
  controls: { policy: "adjustable", value: {} },
  search: { policy: "fixed", value: { mode: "off" } },
  tools: { policy: "adjustable", value: { mode: "exact", serverIds: ["mcp-docs"], hiddenCount: 1 } },
  knowledge: { policy: "fixed", value: { mode: "explicit", baseIds: [], sourceIds: [], hiddenCount: 1 } },
  skills: { policy: "adjustable", value: { mode: "auto", links: [{ skillId: "style", delivery: "always" }] } }
} as const;
const names = { knowledgeBases: [], knowledgeSources: [], mcpServers: [{ id: "mcp-docs", name: "Docs search" }], models: [],
  searchOptions: [], skills: [{ id: "style", name: "Style guide" }] };
const definition = { version: 3, name: "Writing editor", description: "Edits drafts", category: "writing", avatar, instructions: "Be concise.",
  answerRules: "", responseReminder: "Cite sources.", starterPrompts: ["Tighten this paragraph"], rows, names };

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => status === 204 ? new Response(null, { status }) : Response.json(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("adminAssistantsApi", () => {
  it("loads each view with its state, page size and cursor and decodes the rows", async () => {
    const fetchMock = stubFetch({ state: "listed", assistants: [listed], nextCursor: "next", pendingCount: 2 });
    await expect(loadAdminAssistants("listed", "cursor-1")).resolves.toEqual({ state: "listed", assistants: [listed], nextCursor: "next", pendingCount: 2 });
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/assistants?state=listed&limit=30&cursor=cursor-1", { signal: undefined });

    stubFetch({ state: "requests", requests: [summary, { ...summary, id: "request-2", outdated: true, canReview: false }], nextCursor: null, pendingCount: 1 });
    const requests = await loadAdminAssistants("requests");
    expect(requests.state === "requests" && requests.requests.map((request) => request.outdated)).toEqual([false, true]);

    const countFetch = stubFetch({ state: "requests", requests: [summary], nextCursor: "more", pendingCount: 4 });
    await expect(loadAdminAssistantsPendingCount()).resolves.toBe(4);
    expect(countFetch).toHaveBeenCalledWith("/api/admin/assistants?state=requests&limit=1", { signal: undefined });
  });

  it("fails visibly on malformed or mismatched responses instead of guessing", async () => {
    stubFetch({ state: "requests", assistants: [listed], nextCursor: null, pendingCount: 0 });
    await expect(loadAdminAssistants("listed")).rejects.toMatchObject({ code: "admin_assistants_response_invalid" });
    stubFetch({ state: "listed", assistants: [{ ...listed, featuredOrder: 8 }], nextCursor: null, pendingCount: 0 });
    await expect(loadAdminAssistants("listed")).rejects.toMatchObject({ code: "admin_assistants_response_invalid" });
    stubFetch({ state: "listed", assistants: [{ ...listed, avatar: { kind: "uploaded" } }], nextCursor: null, pendingCount: 0 });
    await expect(loadAdminAssistants("listed")).rejects.toMatchObject({ code: "admin_assistants_response_invalid" });
    stubFetch({ state: "requests", requests: [{ ...summary, outdated: true }], nextCursor: null, pendingCount: 0 });
    await expect(loadAdminAssistants("requests")).rejects.toMatchObject({ code: "admin_assistants_response_invalid" });
  });

  it("reads a request with its definition, or with none once it can no longer be decided", async () => {
    const fetchMock = stubFetch({ request: { ...summary, definition } });
    const detail = await loadAdminAssistantRequest("request/1");
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/assistant-listing-requests/request%2F1", { signal: undefined });
    expect(detail.definition).toEqual(definition);
    stubFetch({ request: { ...summary, outdated: true, canReview: false, definition: null } });
    await expect(loadAdminAssistantRequest("request-1")).resolves.toMatchObject({ outdated: true, definition: null });
    for (const broken of [
      { ...definition, rows: { ...rows, tools: { policy: "adjustable", value: { mode: "all" } } } },
      { ...definition, rows: { ...rows, search: { policy: "fixed", value: { mode: "inherit" } } } },
      { ...definition, rows: { ...rows, knowledge: { policy: "fixed", value: { mode: "explicit", baseIds: [], sourceIds: [], hiddenCount: 0 } } } },
      { ...definition, names: { ...names, skills: [{ id: "style" }] } },
      { ...definition, names: { ...names, projects: [] } },
      { ...definition, names: undefined }
    ]) {
      stubFetch({ request: { ...summary, definition: broken } });
      await expect(loadAdminAssistantRequest("request-1")).rejects.toMatchObject({ code: "admin_assistants_response_invalid" });
    }
  });

  it("sends decisions, Featured positions and unlisting to their routes", async () => {
    const decide = stubFetch({ request: { ...summary, state: "approved", canReview: false, reviewedAt: "2026-09-26T00:00:00.000Z", reviewNote: "Looks good" } });
    await expect(decideAdminAssistantRequest("request-1", { action: "approve", note: "Looks good" })).resolves.toMatchObject({ state: "approved" });
    expect(decide).toHaveBeenCalledWith("/api/admin/assistant-listing-requests/request-1/decision", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "approve", note: "Looks good" })
    });

    const featured = stubFetch({ featured: [{ assistantId: "assistant-1", featuredOrder: 0 }, { assistantId: "assistant-2", featuredOrder: 1 }] });
    await expect(setAdminAssistantFeatured("assistant-2", 7)).resolves.toEqual([
      { assistantId: "assistant-1", featuredOrder: 0 }, { assistantId: "assistant-2", featuredOrder: 1 }
    ]);
    expect(featured).toHaveBeenCalledWith("/api/admin/assistants/assistant-2/featured", expect.objectContaining({ body: JSON.stringify({ order: 7 }) }));

    const unlist = stubFetch(null, 204);
    await expect(unlistAdminAssistant("assistant-1")).resolves.toBeUndefined();
    expect(unlist).toHaveBeenCalledWith("/api/admin/assistants/assistant-1/publications/installation", { method: "DELETE" });
  });

  it("keeps the server code and blocking Skills and turns them into human copy", async () => {
    stubFetch({ error: "assistant_skill_audience_mismatch", skills: ["Style guide", "Tone"], message: "Share every included Skill…" }, 409);
    const failure = await decideAdminAssistantRequest("request-1", { action: "approve" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AdminAssistantsRequestError);
    expect(failure).toMatchObject({ code: "assistant_skill_audience_mismatch", status: 409, skillNames: ["Style guide", "Tone"] });
    expect(adminAssistantsErrorMessage(failure)).toBe(
      "Every included Skill must be shared with everyone before this Assistant can be listed. Not shared yet: Style guide, Tone."
    );
    stubFetch({ error: "assistant_featured_limit" }, 409);
    expect(adminAssistantsErrorMessage(await setAdminAssistantFeatured("assistant-1", 7).catch((error: unknown) => error)))
      .toBe("Up to 8 Assistants can be Featured. Turn Featured off for another Assistant first.");
    expect(adminAssistantsErrorMessage(new TypeError("Failed to fetch"))).toBe("Assistants are unavailable right now. Try again in a moment.");
  });

  it("gives every mode of every Setup row its own text and counts what the administrator can't access", () => {
    type Review = Parameters<typeof assistantSetupRows>[0];
    const noNames: AdminAssistantReviewNames = { knowledgeBases: [], knowledgeSources: [], mcpServers: [], models: [], searchOptions: [], skills: [] };
    const read = (patch: Partial<Record<keyof typeof rows, unknown>>, named: Partial<typeof noNames> = {}) =>
      Object.fromEntries(assistantSetupRows({ rows: { ...rows, ...patch }, names: { ...noNames, ...named } } as unknown as Review)
        .map((row) => [row.label, row.value]));
    const valueOf = (key: keyof typeof rows, value: unknown, named: Partial<typeof noNames> = {}) =>
      read({ [key]: { policy: "adjustable", value } }, named)[{ model: "Model", controls: "Reasoning & parameters", search: "Web search",
        tools: "Tools", knowledge: "Knowledge", skills: "Skills" }[key]];

    expect(assistantSetupRows({ rows, names } as unknown as Review)).toEqual([
      { label: "Model", policy: "adjustable", value: "Each person's default model" },
      { label: "Reasoning & parameters", policy: "adjustable", value: "Not set" },
      { label: "Web search", policy: "fixed", value: "Off" },
      { label: "Tools", policy: "adjustable", value: "Docs search, 1 MCP server you can't access" },
      { label: "Knowledge", policy: "fixed", value: "1 base or source you can't access" },
      { label: "Skills", policy: "adjustable", value: "Auto · Style guide (Always)" }
    ]);

    expect(valueOf("model", { mode: "model", modelId: "flash" }, { models: [{ id: "flash", name: "Gemini Flash" }] })).toBe("Gemini Flash");
    expect(valueOf("model", { mode: "model", modelId: null })).toBe("A model you can't access");

    expect(valueOf("controls", { reasoningEffort: "high", temperature: 0.3 })).toBe("Reasoning high · Temperature 0.3");
    expect(valueOf("controls", { reasoningMode: "extended", maxOutputTokens: 4096, streamMode: false, backgroundMode: true }))
      .toBe("Reasoning mode extended · Max answer length 4,096 tokens · Streaming off · Background runs on");

    const sources = [{ id: "brave", name: "Brave" }, { id: "exa", name: "Exa" }];
    expect(valueOf("search", { mode: "inherit" })).toBe("Each person's default");
    expect(valueOf("search", { mode: "off" })).toBe("Off");
    expect(valueOf("search", { mode: "all_selected", optionIds: ["brave"] }, { searchOptions: sources })).toBe("Brave");
    expect(valueOf("search", { mode: "all_selected", optionIds: ["brave", "exa"] }, { searchOptions: sources }))
      .toBe("Brave, Exa · All selected per search");
    expect(valueOf("search", { mode: "model_choice", optionIds: ["brave"], hiddenCount: 2 }, { searchOptions: sources }))
      .toBe("Brave, 2 sources you can't access · Model chooses");

    expect(valueOf("tools", { mode: "inherit" })).toBe("Each person's MCP setting");
    expect(valueOf("tools", { mode: "off" })).toBe("Off");
    expect(valueOf("tools", { mode: "exact", serverIds: [], hiddenCount: 2 })).toBe("2 MCP servers you can't access");

    expect(valueOf("knowledge", { mode: "inherit" })).toBe("Each person's default");
    expect(valueOf("knowledge", { mode: "none" })).toBe("None");
    expect(valueOf("knowledge", { mode: "explicit", baseIds: ["kb"], sourceIds: ["src"], hiddenCount: 2 },
      { knowledgeBases: [{ id: "kb", name: "Company handbook" }], knowledgeSources: [{ id: "src", name: "Travel policy.pdf" }] }))
      .toBe("Company handbook, Travel policy.pdf, 2 bases or sources you can't access");
    // An identified resource without a name is counted, never shown by its id.
    expect(valueOf("knowledge", { mode: "explicit", baseIds: ["kb-private"], sourceIds: [] })).toBe("1 base or source you can't access");

    const skillNames = { skills: [{ id: "style", name: "Style guide" }, { id: "tone", name: "Tone" }] };
    expect(valueOf("skills", { mode: "auto", links: [] })).toBe("Auto · No Skills selected");
    expect(valueOf("skills", { mode: "off", links: [] })).toBe("Off");
    expect(valueOf("skills", { mode: "auto", hiddenCount: 1, links: [{ skillId: "style", delivery: "always" }, { skillId: "tone", delivery: "on_demand" }] },
      skillNames)).toBe("Auto · Style guide (Always), Tone (On demand), 1 Skill you can't access");
    expect(valueOf("skills", { mode: "off", links: [{ skillId: "style", delivery: "always" }] }, skillNames)).toBe("Off · Style guide (Always)");
  });
});
