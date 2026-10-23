// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  ASSISTANT_AVATAR_RECIPE_MIN_BYTES,
  assistantAvatarRecipeFromBytes,
  decodeAssistantDraft,
  type AssistantDraft
} from "@/lib/contracts/assistants";
import { decodeResourceChangeCard } from "@/lib/contracts/resourceChanges";
import { logEvent } from "../observability";
import type { AgentAssistant, AgentAssistantCatalog, AgentAssistantService } from "../assistants/agentAssistants";
import type { AssistantCatalogView } from "../assistants/catalogValidation";
import { MANAGE_ASSISTANT_TOOL_NAME, assistantChanges, executeManageAssistant, manageAssistantTool } from "./manageAssistant";
import { invalidProviderToolArguments, type ToolExecutionResult } from "./types";

vi.mock("../observability", async (importOriginal) => ({
  ...await importOriginal<typeof import("../observability")>(), logEvent: vi.fn()
}));

const view = { marker: "catalog-view" } as unknown as AssistantCatalogView;
const catalog: AgentAssistantCatalog = {
  mcpServers: [{ name: "GitLab", serverId: "srv_gitlab" }, { name: "Jira", serverId: "srv_jira" }],
  models: [{ displayName: "GPT-5.5", modelId: "codex-lb:gpt-5.5" }, { displayName: "Claude Sonnet", modelId: "or:claude-sonnet" }],
  view
};
const skills = { version: 2, mode: "auto", tools: "load_and_read", available: [],
  pinned: [{ alias: "report-writer", fileCount: 0, name: "Report writer", revisionId: "rev-1", skillId: "skill-report" }] } as never;
const context = { skills };
const call = (args: Record<string, unknown>) => ({ arguments: args, id: "call_assistant", name: MANAGE_ASSISTANT_TOOL_NAME });
const json = (result: ToolExecutionResult) => (result.content[0] as { value: Record<string, unknown> }).value;
const card = (result: ToolExecutionResult) => decodeResourceChangeCard((result.artifacts?.[0] as { data: { payload: unknown } }).data.payload);

function draft(overrides: Partial<AssistantDraft> = {}): AssistantDraft {
  const decoded = decodeAssistantDraft({
    answerRules: null, avatar: assistantAvatarRecipeFromBytes(new Uint8Array(ASSISTANT_AVATAR_RECIPE_MIN_BYTES)), category: null, description: "Reviews code",
    name: "Reviewer", responseReminder: "", starterPrompts: ["Review my MR"], systemPrompt: "Review the code.\nBe brief.\n",
    rows: {
      controls: { policy: "adjustable", value: {} }, knowledge: { policy: "adjustable", value: { mode: "none" } },
      model: { policy: "fixed", value: { mode: "model", modelId: "codex-lb:gpt-5.5" } },
      search: { policy: "adjustable", value: { mode: "inherit" } }, skills: { policy: "adjustable", value: { links: [], mode: "auto" } },
      tools: { policy: "adjustable", value: { mode: "inherit" } }
    },
    ...overrides
  });
  if (!decoded.ok) throw new Error(`fixture draft invalid: ${decoded.code}`);
  return decoded.draft;
}

const reviewer: AgentAssistant = { archived: false, assistantId: "asst_1", audience: { everyone: false, groupNames: ["Backend"] }, draft: draft(),
  skillNames: new Map(), version: 3 };

function service(overrides: Partial<AgentAssistantService> = {}) {
  return {
    catalog: vi.fn<AgentAssistantService["catalog"]>(async () => catalog),
    create: vi.fn<AgentAssistantService["create"]>(async (_draft, _view, result) => {
      const written = { assistantId: "asst_new", version: 1 };
      return { kind: "changed", result: result(written), value: written };
    }),
    deletionConsequences: vi.fn<AgentAssistantService["deletionConsequences"]>(async () => ({ audiences: { groupNames: ["Backend"], installation: false },
      chatCount: 4, hiddenProjectCount: 0, pendingListingRequest: false, projects: [], version: 3 })),
    get: vi.fn<AgentAssistantService["get"]>(async (id) => id === "asst_1" ? reviewer : null),
    linkableSkills: vi.fn<AgentAssistantService["linkableSkills"]>(async () => [{ name: "Report writer", own: true, skillId: "skill-report" },
      { name: "Notes", own: true, skillId: "skill-notes" }]),
    list: vi.fn<AgentAssistantService["list"]>(async () => [reviewer]),
    publishableGroups: vi.fn<AgentAssistantService["publishableGroups"]>(async () => [{ id: "grp_backend", memberCount: 5, name: "Backend" },
      { id: "grp_frontend", memberCount: 3, name: "Frontend" }]),
    update: vi.fn<AgentAssistantService["update"]>(async (assistantId, expectedVersion, _draft, _view, result) => {
      const written = { assistantId, version: expectedVersion + 1 };
      return { kind: "changed", result: result(written), value: written };
    }),
    ...overrides
  };
}

describe("manage_assistant", () => {
  it("changes the user's Assistants without approval or the VM", () => {
    expect(manageAssistantTool).toMatchObject({ effects: "local", name: "manage_assistant", needsApproval: false, requiresVm: false });
  });

  it("lists and reads the user's Assistants by name, with settings the model can act on", async () => {
    const fake = service();
    const listed = await executeManageAssistant(fake, call({ action: "list" }), context);
    expect(json(listed)).toMatchObject({ assistants: [{ assistantId: "asst_1", model: "GPT-5.5 (fixed)", name: "Reviewer", published: ["Backend"], version: 3 }] });
    expect(json(listed).assistants).not.toContainEqual(expect.objectContaining({ instructions: expect.anything() }));
    const read = await executeManageAssistant(fake, call({ action: "get", assistantId: "asst_1" }), context);
    expect(json(read)).toMatchObject({ assistant: { instructions: "Review the code.\nBe brief.\n", link: "/?library=assistants&assistant=asst_1",
      mcpTools: "Chat default", starterPrompts: ["Review my MR"], webSearch: "Chat default" } });
  });

  it("answers another user's Assistant exactly like a missing one", async () => {
    const fake = service();
    const foreign = await executeManageAssistant(fake, call({ action: "get", assistantId: "asst_colleague" }), context);
    const missing = await executeManageAssistant(fake, call({ action: "get", assistantId: "asst_missing" }), context);
    expect(foreign).toEqual(missing);
    expect(json(foreign)).toMatchObject({ code: "assistant_not_available" });
    for (const action of ["update", "propose_delete", "propose_publish"]) {
      const result = await executeManageAssistant(fake, call({ action, assistantId: "asst_colleague", audience: action === "propose_publish" ? "Backend" : undefined,
        expectedVersion: action === "update" ? 1 : undefined, name: action === "update" ? "Mine" : undefined }), context);
      expect(json(result)).toMatchObject({ code: "assistant_not_available" });
    }
    expect(fake.update).not.toHaveBeenCalled();
  });

  it("creates an Assistant from names the user knows and answers with a card that offers Undo", async () => {
    const fake = service();
    const result = await executeManageAssistant(fake, call({ action: "create", fixedModel: true, instructions: "Write weekly reports.", mcpTools: ["gitlab"],
      model: "gpt-5.5", name: " Reporter ", skills: [{ skill: "report-writer" }, { delivery: "on_demand", skill: "notes" }], starterPrompts: [" Monday report "],
      webSearch: "off" }), context);
    const [written, writtenView] = vi.mocked(fake.create).mock.calls[0]!;
    expect(writtenView).toBe(view);
    expect(written).toMatchObject({ name: "Reporter", starterPrompts: ["Monday report"], systemPrompt: "Write weekly reports.", rows: {
      model: { policy: "fixed", value: { mode: "model", modelId: "codex-lb:gpt-5.5" } }, search: { policy: "adjustable", value: { mode: "off" } },
      skills: { value: { links: [{ delivery: "always", skillId: "skill-report" }, { delivery: "on_demand", skillId: "skill-notes" }], mode: "auto" } },
      tools: { value: { mode: "exact", serverIds: ["srv_gitlab"] } }, knowledge: { value: { mode: "none" } } } });
    expect(decodeAssistantDraft(written).ok).toBe(true);
    expect(json(result)).toMatchObject({ action: "created", assistant: { assistantId: "asst_new", name: "Reporter", version: 1 }, chat: "/assistant/asst_new", saved: true });
    expect(card(result)).toEqual({ action: "created", assistantId: "asst_new", audience: null, changes: [], consequences: null, definitionVersion: 1,
      instructionsDiff: null, name: "Reporter", proposalId: null, resource: "assistant", version: 1 });
  });

  it.each([
    [{ model: "llama" }, "assistant_model_unknown", "Models: \"GPT-5.5\", \"Claude Sonnet\"; or \"default\"."],
    [{ mcpTools: ["Confluence"] }, "assistant_mcp_server_unknown", "Servers: \"GitLab\", \"Jira\"."],
    [{ skills: [{ skill: "ghost" }] }, "assistant_skill_unknown", "\"Report writer\", \"Notes\""],
    [{ fixedModel: true, model: "default" }, "assistant_row_fixed_requires_value", "A fixed setting needs a concrete value"],
    [{ mcpTools: "some" }, "assistant_arguments_invalid", "mcpTools must be \"default\", \"off\" or a list"]
  ])("refuses a create with %j and names the options", async (fields, code, message) => {
    const fake = service();
    const result = await executeManageAssistant(fake, call({ action: "create", name: "Reporter", ...fields }), context);
    expect(result.status).toBe("error");
    expect(json(result)).toMatchObject({ code, saved: false });
    expect(String(json(result).message)).toContain(message);
    expect(fake.create).not.toHaveBeenCalled();
  });

  it("edits only the fields given, under the version read, and says what changed", async () => {
    const fake = service();
    const result = await executeManageAssistant(fake, call({ action: "update", assistantId: "asst_1", expectedVersion: 3,
      instructions: "Review the code.\nBe thorough.\n", model: "Claude Sonnet" }), context);
    const [id, version, written] = vi.mocked(fake.update).mock.calls[0]!;
    expect([id, version]).toEqual(["asst_1", 3]);
    expect(written).toMatchObject({ description: "Reviews code", name: "Reviewer", starterPrompts: ["Review my MR"], systemPrompt: "Review the code.\nBe thorough.\n",
      rows: { model: { policy: "fixed", value: { mode: "model", modelId: "or:claude-sonnet" } } } });
    expect(json(result)).toMatchObject({ action: "updated", assistant: { version: 4 }, changed: ["instructions", "model"], saved: true });
    expect(card(result)).toMatchObject({ action: "updated", changes: [{ field: "instructions", summary: null },
      { field: "model", summary: "GPT-5.5 (fixed) → Claude Sonnet (fixed)" }], definitionVersion: 4,
      instructionsDiff: { lines: [{ kind: "context", text: "Review the code." }, { kind: "del", text: "Be brief." }, { kind: "add", text: "Be thorough." }], truncated: false } });
  });

  it("refuses a stale version and passes the write's refusals on", async () => {
    const stale = await executeManageAssistant(service(), call({ action: "update", assistantId: "asst_1", expectedVersion: 2, name: "x" }), context);
    expect(json(stale)).toMatchObject({ code: "assistant_version_conflict" });
    expect(String(json(stale).message)).toContain("Read it again with get");
    for (const [value, code] of [
      [{ code: "assistant_skills_not_available" }, "assistant_skills_not_available"],
      [{ code: "assistant_catalog", failure: { code: "assistant_model_not_available", status: 400 } }, "assistant_model_not_available"],
      [{ code: "assistant_skill_audience_mismatch" }, "assistant_skill_audience_mismatch"]
    ] as const) {
      const fake = service({ update: vi.fn(async () => ({ kind: "refused" as const, value })) });
      const result = await executeManageAssistant(fake, call({ action: "update", assistantId: "asst_1", expectedVersion: 3, name: "Reviewer 2" }), context);
      expect(json(result)).toMatchObject({ code, saved: false });
    }
  });

  it("proposes deleting with the consequences and changes nothing", async () => {
    const fake = service();
    const result = await executeManageAssistant(fake, call({ action: "propose_delete", assistantId: "asst_1" }), context);
    expect(json(result)).toMatchObject({ deleted: false, deletionProposed: true });
    // The answer places the card: the model is told not to say where it is.
    expect(json(result).note).toContain("without saying where it appears");
    expect(json(result).note).not.toMatch(/above|below/u);
    expect(card(result)).toMatchObject({ action: "delete_proposed", consequences: { chatCount: 4, everyone: false, groupNames: ["Backend"],
      pendingListingRequest: false }, definitionVersion: 3 });
    expect(fake.update).not.toHaveBeenCalled();
    expect(fake.create).not.toHaveBeenCalled();
  });

  it("proposes publishing to one of the user's groups or for everyone, never to a group they are not in", async () => {
    const fake = service();
    const group = await executeManageAssistant(fake, call({ action: "propose_publish", assistantId: "asst_1", audience: "frontend" }), context);
    expect(card(group)).toMatchObject({ action: "publish_proposed", audience: { groupId: "grp_frontend", groupName: "Frontend", kind: "group" }, definitionVersion: 3 });
    expect(json(group)).toMatchObject({ publicationProposed: true, published: false });
    expect(json(group).note).toContain("without saying where it appears");
    expect(json(group).note).not.toMatch(/above|below/u);
    const everyone = await executeManageAssistant(fake, call({ action: "propose_publish", assistantId: "asst_1", audience: "Everyone" }), context);
    expect(card(everyone)).toMatchObject({ audience: { kind: "everyone" } });
    const already = await executeManageAssistant(fake, call({ action: "propose_publish", assistantId: "asst_1", audience: "Backend" }), context);
    expect(json(already)).toMatchObject({ code: "assistant_already_published" });
    const outside = await executeManageAssistant(fake, call({ action: "propose_publish", assistantId: "asst_1", audience: "Finance" }), context);
    expect(json(outside)).toMatchObject({ code: "assistant_group_unknown" });
    expect(String(json(outside).message)).toContain("\"Backend\", \"Frontend\"; or \"everyone\"");
  });

  it("gives each proposal its own card and clips names the answer's decoder would drop", async () => {
    const long = "Platform & infrastructure guild ".repeat(10).trim();
    const astral: AgentAssistant = { ...reviewer, draft: { ...reviewer.draft, name: "𝔸".repeat(80) } };
    const fake = service({ get: vi.fn(async () => astral),
      deletionConsequences: vi.fn(async () => ({ audiences: { groupNames: [long], installation: false }, chatCount: 0, hiddenProjectCount: 0,
        pendingListingRequest: false, projects: [], version: 3 })) });
    const first = card(await executeManageAssistant(fake, call({ action: "propose_delete", assistantId: "asst_1" }), context));
    const second = card(await executeManageAssistant(fake, call({ action: "propose_delete", assistantId: "asst_1" }), context));
    expect(first).toMatchObject({ consequences: { groupNames: [`${long.slice(0, 199)}…`] }, name: `${"𝔸".repeat(39)}…`, proposalId: expect.any(String) });
    expect(first?.proposalId).not.toBe(second?.proposalId);
    const publish = card(await executeManageAssistant(fake, call({ action: "propose_publish", assistantId: "asst_1", audience: "Frontend" }), context));
    expect(publish).toMatchObject({ action: "publish_proposed", proposalId: expect.any(String) });
  });

  it.each([
    [invalidProviderToolArguments(), "The arguments were not valid JSON."],
    [{ action: "archive" }, "action must be one of list, get, create, update, propose_delete, propose_publish."],
    [{ action: "create" }, "create needs a name."],
    [{ action: "create", name: "x", ownerId: "u2" }, "Unknown argument \"ownerId\""],
    [{ action: "list", name: "x" }, "list does not take name"],
    [{ action: "update", assistantId: "asst_1", name: "x" }, "update needs expectedVersion"],
    [{ action: "update", assistantId: "asst_1", expectedVersion: 3 }, "update needs at least one of"],
    [{ action: "create", name: "x", starterPrompts: ["a", "b", "c", "d", "e", "f", "g"] }, "starterPrompts must be at most 6"],
    [{ action: "propose_publish", assistantId: "asst_1" }, "propose_publish needs audience"]
  ])("refuses %j with what to fix", async (args, message) => {
    const fake = service();
    const result = await executeManageAssistant(fake, call(args), context);
    expect(result.status).toBe("error");
    expect(String(json(result).message)).toContain(message);
    expect(fake.create).not.toHaveBeenCalled();
    expect(fake.update).not.toHaveBeenCalled();
  });

  it("logs an unexpected failure without content", async () => {
    vi.mocked(logEvent).mockClear();
    const result = await executeManageAssistant(service({ create: vi.fn(async () => { throw new Error("Write weekly reports."); }) }),
      call({ action: "create", instructions: "Write weekly reports.", name: "Reporter" }), context);
    expect(json(result)).toMatchObject({ code: "assistant_change_failed" });
    expect(logEvent).toHaveBeenCalledExactlyOnceWith("service_operation", expect.objectContaining({ code: "self_service_change_failed" }));
    expect(JSON.stringify(vi.mocked(logEvent).mock.calls)).not.toContain("weekly reports");
  });
});

describe("Assistant change summaries", () => {
  it("names each changed setting in plain words", () => {
    const before = draft();
    const after = draft({ description: "New", name: "Code reviewer", rows: { ...before.rows,
      search: { policy: "adjustable", value: { mode: "off" } }, tools: { policy: "adjustable", value: { mode: "exact", serverIds: ["srv_gitlab", "srv_jira"] } },
      skills: { policy: "adjustable", value: { links: [{ delivery: "on_demand", skillId: "skill-notes" }], mode: "auto" } } }, starterPrompts: [] });
    expect(assistantChanges(before, after, catalog, new Map([["skill-notes", "Notes"]]))).toEqual([
      { field: "name", summary: "Was “Reviewer”" }, { field: "description", summary: null }, { field: "starter_prompts", summary: "0 starter prompts" },
      { field: "web_search", summary: "Chat default → Off" }, { field: "mcp_tools", summary: "Chat default → GitLab, Jira" },
      { field: "skills", summary: "Notes (on demand)" }
    ]);
  });
});
