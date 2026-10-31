// @vitest-environment node
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  ASSISTANT_AVATAR_RECIPE_MIN_BYTES,
  assistantAvatarRecipeFromBytes,
  decodeAssistantDraft,
  type AssistantDraft,
  type AssistantRows,
  type AssistantRunControls
} from "@/lib/contracts/assistants";
import type { ModelParameterControls } from "@/lib/contracts/catalog";
import type { ToolExecutionResult } from "../tools/types";
import { executeManageAssistant } from "../tools/manageAssistant";
import { skillAccessWhere } from "../skills/prismaRepository";
import { createAgentAssistantService } from "./agentAssistants";
import type { AssistantCatalogView } from "./catalogValidation";

const USER = "user_1";
const scope = { callId: "call_1", chatId: "chat_1", runId: "run_1", userId: USER };
const avatar = assistantAvatarRecipeFromBytes(new Uint8Array(ASSISTANT_AVATAR_RECIPE_MIN_BYTES));
const result: ToolExecutionResult = { callId: "provider_call", content: [{ text: "saved", type: "text" }], name: "manage_assistant", status: "complete" };
const rows = (model: AssistantRows["model"]["value"] = { mode: "inherit" }): AssistantRows => ({
  controls: { policy: "adjustable", value: {} },
  model: { policy: "adjustable", value: model }, search: { policy: "adjustable", value: { mode: "inherit" } },
  skills: { policy: "adjustable", value: { links: [], mode: "auto" } }, tools: { policy: "adjustable", value: { mode: "inherit" } }
});
const draft = (model?: AssistantRows["model"]["value"]): AssistantDraft => ({ answerRules: null, avatar, category: null, description: "", name: "Reviewer",
  responseReminder: "", rows: rows(model), starterPrompts: [], systemPrompt: "Review." });
const parameterControls: ModelParameterControls = {
  background: { defaultValue: false, supported: false },
  maxOutputTokens: { defaultValue: 4096, maxValue: 128_000 },
  reasoningEffort: { defaultValue: "medium", options: ["low", "medium", "high"], supported: true },
  reasoningMode: { defaultValue: "standard", options: ["standard", "pro"], supported: true },
  stream: { defaultValue: true, supported: false },
  temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
};
const view: AssistantCatalogView = {
  accessibleMcpServerIds: new Set(["srv_gitlab", "srv_hidden"]), entitledSearchOptionIds: new Set(),
  mcpRunPlan: { isGenerationLive: () => false, now: new Date(0), recordsByServerId: new Map([["srv_gitlab", { serverName: "GitLab" } as never]]) },
  modelById: new Map([["codex-lb:gpt-5.5", { displayName: "GPT-5.5", modelId: "codex-lb:gpt-5.5", parameterControls } as never]])
};
const entry = (owned: boolean) => ({ archived: false, audience: owned ? { everyone: false, groupNames: ["Backend"] } : null, id: owned ? "asst_1" : "asst_2", owned,
  version: 3, content: { answerRules: null, avatar, category: null, description: "", name: owned ? "Mine" : "Colleague's", responseReminder: "", rows: rows(),
    skillSummaries: [{ id: "skill_1", name: "Report writer" }], starterPrompts: [], systemPrompt: "Review." } });

function setup(options: Readonly<{ claim?: "open" | "settled" }> = {}) {
  const tx = { marker: "tx" };
  const db = {
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    skillDefinition: { findMany: vi.fn(async () => [
      { currentRevision: { name: "Report writer" }, id: "skill_1", ownerUserId: USER, sharedRevision: null },
      { currentRevision: { name: "Draft" }, id: "skill_2", ownerUserId: "user_2", sharedRevision: { name: "Team notes" } }
    ]) }
  };
  const repository = {
    getDetail: vi.fn(async (_userId: string, id: string) => id === "asst_1" ? entry(true) : id === "asst_2" ? entry(false) : null),
    listForUser: vi.fn(async () => [entry(true), entry(false)]),
    listPublishableGroups: vi.fn(async () => [{ id: "grp_1", memberCount: 3, name: "Backend" }]),
    loadUserAccessibleMcpServerIds: vi.fn(async () => view.accessibleMcpServerIds as Set<string>),
    loadUserMcpRunPlanView: vi.fn(async () => view.mcpRunPlan)
  };
  const store = { claim: vi.fn(async () => options.claim === "settled" ? { kind: "settled" as const, result } : { kind: "open" as const }),
    settle: vi.fn(async () => undefined) };
  const create = vi.fn(async () => ({ assistantId: "asst_new", kind: "ok" as const }));
  const update = vi.fn(async (_tx: unknown, _userId: string, _assistantId: string, _expectedVersion: number, _draft: AssistantDraft) =>
    ({ assistantId: "asst_1", kind: "ok" as const }));
  const deletion = { loadConsequences: vi.fn(async () => null) };
  const service = createAgentAssistantService({ create: create as never, db: db as never, deletion, loadCatalogView: async () => view, scope, store,
    update: update as never, handlers: { loadCatalogData: vi.fn(async () => null), repository: repository as never } });
  return { create, db, deletion, repository, service, store, tx, update };
}

describe("agent Assistant service", () => {
  it("reads only the user's own Assistants, as editor drafts", async () => {
    const fixture = setup();
    const listed = await fixture.service.list();
    expect(listed.map((assistant) => assistant.assistantId)).toEqual(["asst_1"]);
    expect(listed[0]).toMatchObject({ audience: { everyone: false, groupNames: ["Backend"] }, draft: { name: "Mine", systemPrompt: "Review." }, version: 3 });
    expect(listed[0]!.skillNames.get("skill_1")).toBe("Report writer");
    expect(await fixture.service.get("asst_1")).toMatchObject({ assistantId: "asst_1" });
    expect(await fixture.service.get("asst_2")).toBeNull();
    expect(await fixture.service.get("asst_missing")).toBeNull();
    expect(fixture.repository.getDetail).toHaveBeenCalledWith(USER, "asst_2");
  });

  it("refuses a draft the user's catalog cannot run before any transaction", async () => {
    const fixture = setup();
    const outcome = await fixture.service.create(draft({ mode: "model", modelId: "or:unknown" }), view, () => result);
    expect(outcome).toEqual({ kind: "refused", value: { code: "assistant_catalog", failure: { code: "assistant_model_not_available", status: 400 } } });
    expect(fixture.db.$transaction).not.toHaveBeenCalled();
  });

  it("creates through the repository write and settles the call in the same transaction", async () => {
    const fixture = setup();
    const value = draft({ mode: "model", modelId: "codex-lb:gpt-5.5" });
    expect(await fixture.service.create(value, view, () => result)).toEqual({ kind: "changed", result, value: { assistantId: "asst_new", version: 1 } });
    expect(fixture.store.claim).toHaveBeenCalledWith(fixture.tx);
    expect(fixture.create).toHaveBeenCalledWith(fixture.tx, USER, value);
    expect(fixture.store.settle).toHaveBeenCalledWith(fixture.tx, result);
  });

  it("revises under the expected version and maps every refusal of the write", async () => {
    const fixture = setup();
    expect(await fixture.service.update("asst_1", 3, draft(), view, () => result)).toEqual({ kind: "changed", result, value: { assistantId: "asst_1", version: 4 } });
    expect(fixture.update).toHaveBeenCalledWith(fixture.tx, USER, "asst_1", 3, draft());
    for (const [kind, code] of [["not_found", "assistant_not_available"], ["version_conflict", "assistant_version_conflict"], ["archived", "assistant_archived"],
      ["skills_not_available", "assistant_skills_not_available"], ["skill_audience_mismatch", "assistant_skill_audience_mismatch"]] as const) {
      fixture.update.mockResolvedValueOnce({ kind } as never);
      expect(await fixture.service.update("asst_1", 3, draft(), view, () => result)).toEqual({ kind: "refused", value: { code } });
    }
    fixture.update.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("conflict", { clientVersion: "6", code: "P2034" }));
    expect(await fixture.service.update("asst_1", 3, draft(), view, () => result)).toEqual({ kind: "refused", value: { code: "assistant_version_conflict" } });
    expect(fixture.store.settle).toHaveBeenCalledTimes(1);
  });

  it("returns a settled call's result without writing", async () => {
    const fixture = setup({ claim: "settled" });
    expect(await fixture.service.create(draft(), view, () => result)).toEqual({ kind: "settled", result });
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("offers the models, MCP servers and Skills the user can use, by name", async () => {
    const fixture = setup();
    expect(await fixture.service.catalog()).toEqual({ mcpServers: [{ name: "GitLab", serverId: "srv_gitlab" }],
      models: [{ displayName: "GPT-5.5", modelId: "codex-lb:gpt-5.5" }], view });
    expect(await fixture.service.linkableSkills()).toEqual([{ name: "Report writer", own: true, skillId: "skill_1" },
      { name: "Team notes", own: false, skillId: "skill_2" }]);
    expect(fixture.db.skillDefinition.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { archivedAt: null, deletedAt: null, ...skillAccessWhere(USER) } }));
    await fixture.service.deletionConsequences("asst_1");
    expect(fixture.deletion.loadConsequences).toHaveBeenCalledWith(USER, "asst_1");
  });
});

describe("manage_assistant through the Studio service", () => {
  const call = (fields: Record<string, unknown>) => ({ arguments: fields, id: "call_1", name: "manage_assistant" });
  const json = (output: ToolExecutionResult) => (output.content[0] as { value: Record<string, unknown> }).value;
  const context = { skills: undefined };

  it("saves the highest offered reasoning effort once and leaves a repeated update unwritten", async () => {
    const fixture = setup();
    let saved = entry(true);
    fixture.repository.getDetail.mockImplementation(async () => saved);
    fixture.update.mockImplementation(async (_tx, _userId, _assistantId, expectedVersion, next) => {
      expect(decodeAssistantDraft(next).ok).toBe(true);
      saved = { ...saved, content: { ...saved.content, rows: next.rows }, version: expectedVersion + 1 };
      return { assistantId: "asst_1", kind: "ok" };
    });
    const fields = { action: "update", assistantId: "asst_1", controls: { reasoningEffort: "high" }, fixedControls: true, fixedModel: true, model: "GPT-5.5" };
    const first = await executeManageAssistant(fixture.service, call({ ...fields, expectedVersion: 3 }), context);
    expect(json(first)).toMatchObject({ saved: true, changed: ["model"], assistant: { version: 4 } });
    expect(first.artifacts).toHaveLength(1);
    expect(saved.content.rows.controls).toEqual({ policy: "fixed", value: { reasoningEffort: "high" } });
    expect(fixture.store.settle).toHaveBeenCalledWith(fixture.tx, first);

    const repeat = await executeManageAssistant(fixture.service, call({ ...fields, expectedVersion: 4 }), context);
    expect(json(repeat)).toMatchObject({ saved: false, changed: [], assistant: { version: 4 } });
    expect(json(repeat).note).toContain("do not retry");
    expect(repeat.artifacts).toBeUndefined();
    expect(saved.version).toBe(4);
    expect(fixture.update).toHaveBeenCalledTimes(1);
    expect(fixture.db.$transaction).toHaveBeenCalledTimes(1);
    expect(fixture.store.settle).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ reasoningEffort: "ultra" }, "reasoningEffort", 'Offered reasoningEffort values: "low", "medium", "high".'],
    [{ reasoningMode: "ultra" }, "reasoningMode", 'Offered reasoningMode values: "standard", "pro".'],
    [{ temperature: 3 }, "temperature", "temperature limit: 2."],
    [{ maxOutputTokens: 128_001 }, "maxOutputTokens", "maxOutputTokens limit: 128000."],
    [{ backgroundMode: true }, "backgroundMode", "omit the unsupported setting"],
    [{ streamMode: true }, "streamMode", "omit the unsupported setting"]
  ] as const)("refuses unsupported settings %j with Studio's rule before any transaction", async (controls, field, message) => {
    const fixture = setup();
    const output = await executeManageAssistant(fixture.service, call({ action: "update", assistantId: "asst_1", expectedVersion: 3,
      model: "GPT-5.5", controls }), context);
    expect(output.status).toBe("error");
    expect(json(output)).toMatchObject({ code: "assistant_run_controls_invalid", field, saved: false });
    expect(json(output).message).toContain(message);
    expect(fixture.db.$transaction).not.toHaveBeenCalled();
    expect(fixture.update).not.toHaveBeenCalled();
    expect(output.artifacts).toBeUndefined();
  });

  it("validates adjustable controls against a concrete model on creation too", async () => {
    const fixture = setup();
    const fields = { action: "create", name: "Reviewer", model: "GPT-5.5" };
    const invalid = await executeManageAssistant(fixture.service, call({ ...fields, controls: { reasoningEffort: "ultra" } }), context);
    expect(json(invalid)).toMatchObject({ code: "assistant_run_controls_invalid", offeredValues: ["low", "medium", "high"], saved: false });
    expect(fixture.create).not.toHaveBeenCalled();
    const valid = await executeManageAssistant(fixture.service, call({ ...fields, controls: { reasoningEffort: "high" } }), context);
    expect(json(valid)).toMatchObject({ saved: true });
    expect(fixture.create).toHaveBeenCalledWith(fixture.tx, USER, expect.objectContaining({ rows: expect.objectContaining({
      controls: { policy: "adjustable", value: { reasoningEffort: "high" } },
      model: { policy: "adjustable", value: { mode: "model", modelId: "codex-lb:gpt-5.5" } }
    }) }));
  });

  it("matches Studio's structural-only validation for controls with the chat-default model", async () => {
    const fixture = setup();
    const controls: AssistantRunControls = { reasoningEffort: "model-specific-value" };
    const output = await executeManageAssistant(fixture.service, call({ action: "update", assistantId: "asst_1", expectedVersion: 3, controls }), context);
    expect(json(output)).toMatchObject({ saved: true });
    expect(fixture.update).toHaveBeenCalledWith(fixture.tx, USER, "asst_1", 3, expect.objectContaining({ rows: expect.objectContaining({
      controls: { policy: "adjustable", value: controls }, model: { policy: "adjustable", value: { mode: "inherit" } }
    }) }));
    const read = await executeManageAssistant(fixture.service, call({ action: "get", assistantId: "asst_1" }), context);
    expect(json(read)).toMatchObject({ assistant: { availableControls: null } });
  });
});
