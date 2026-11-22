// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { MemoryNoteChangeCard } from "../../../contracts/memoryNote";
import type { InstructionsChangeCard } from "../../../contracts/resourceChanges";
import { createTelegramChangeGateway, type TelegramChangeRoutes } from "./gateway";
import type { TelegramChangeOperation } from "./plan";

type Call = Readonly<{ route: keyof TelegramChangeRoutes; method: string; path: string; body: unknown; params: readonly string[] }>;

/** Routes that record each request and answer with the next scripted response. */
function routes(answer: () => Response) {
  const calls: Call[] = [];
  const users: string[] = [];
  const record = (route: keyof TelegramChangeRoutes) => async (request: Request, ...params: string[]) => {
    const text = await request.text();
    calls.push({ body: text ? JSON.parse(text) as unknown : null, method: request.method, params, path: new URL(request.url).pathname, route });
    return answer();
  };
  const gateway = createTelegramChangeGateway((userId) => {
    users.push(userId);
    return {
      assistant: record("assistant"), assistantListing: record("assistantListing"), assistantPublication: record("assistantPublication"),
      instructionPreset: record("instructionPreset"), instructions: record("instructions"),
      memoryNote: record("memoryNote"), memoryNoteOffer: record("memoryNoteOffer"), proxy: record("proxy"), scheduledTask: record("scheduledTask"), secrets: record("secrets"), skill: record("skill"),
      skillSaveUndo: record("skillSaveUndo"), subagent: record("subagent"), subagentDefaultUndo: record("subagentDefaultUndo"),
      subagentRestore: record("subagentRestore")
    };
  });
  return { calls, gateway, users };
}

const ok = () => new Response(null, { status: 204 });
const refused = (error: string, status: number, extra: Record<string, unknown> = {}) => () => Response.json({ error, ...extra }, { status });

describe("a change button's request", () => {
  it("is the web card's request to the same Settings route, built for the button's user", async () => {
    const cases: ReadonlyArray<readonly [TelegramChangeOperation, Omit<Call, "params"> & { params?: readonly string[] }]> = [
      [{ kind: "secret_delete", secretId: "s-1", versionId: "v-1" },
        { body: { action: "delete", expectedVersionId: "v-1", id: "s-1" }, method: "POST", path: "/api/me/workspace/secrets", route: "secrets" }],
      [{ expectedVersion: 2, kind: "proxy_delete", proxyId: "p-1" },
        { body: { expectedVersion: 2 }, method: "DELETE", params: ["p-1"], path: "/api/me/proxies/p-1", route: "proxy" }],
      [{ expectedVersion: 3, kind: "skill_delete", skillId: "k-1" },
        { body: { expectedVersion: 3 }, method: "DELETE", params: ["k-1"], path: "/api/me/skills/k-1", route: "skill" }],
      [{ assistantId: "a-1", expectedVersion: 4, kind: "assistant_archive" },
        { body: { archived: true, expectedVersion: 4 }, method: "PATCH", params: ["a-1"], path: "/api/me/assistants/a-1", route: "assistant" }],
      [{ assistantId: "a-1", expectedVersion: 4, kind: "assistant_delete" },
        { body: { expectedVersion: 4 }, method: "DELETE", params: ["a-1"], path: "/api/me/assistants/a-1", route: "assistant" }],
      [{ assistantId: "a-1", expectedVersion: 4, groupId: "g-1", kind: "assistant_publish" },
        { body: { expectedVersion: 4, groupId: "g-1", scope: "group" }, method: "POST", params: ["a-1"], path: "/api/me/assistants/a-1/publications",
          route: "assistantPublication" }],
      [{ assistantId: "a-1", expectedVersion: 4, kind: "assistant_listing" },
        { body: { expectedVersion: 4 }, method: "POST", params: ["a-1"], path: "/api/me/assistants/a-1/listing-requests", route: "assistantListing" }],
      [{ definitionId: "d-1", expectedVersion: 5, kind: "subagent_delete" },
        { body: { expectedVersion: 5 }, method: "DELETE", params: ["d-1"], path: "/api/me/subagents/d-1", route: "subagent" }],
      [{ definitionId: "d-1", expectedVersion: 5, kind: "subagent_restore", revisionId: "r-1" },
        { body: { expectedVersion: 5, revisionId: "r-1" }, method: "POST", params: ["d-1"], path: "/api/me/subagents/d-1/restore", route: "subagentRestore" }],
      [{ kind: "scheduled_task_delete", taskId: "t-1" },
        { body: null, method: "DELETE", params: ["t-1"], path: "/api/me/scheduled-tasks/t-1", route: "scheduledTask" }]
    ];
    for (const [operation, expected] of cases) {
      const fake = routes(ok);
      await expect(fake.gateway.act({ operation, userId: "user-1" })).resolves.toEqual({ kind: "done" });
      expect(fake.users).toEqual(["user-1"]);
      expect(fake.calls).toEqual([{ params: [], ...expected }]);
    }
  });

  it("reads a version conflict, a resource that is gone and any other failure as the card does", async () => {
    const secret: TelegramChangeOperation = { kind: "secret_delete", secretId: "s-1", versionId: "v-1" };
    expect(await routes(refused("workspace_secret_conflict", 409)).gateway.act({ operation: secret, userId: "u" })).toEqual({ kind: "changed" });
    expect(await routes(refused("workspace_secret_not_found", 404)).gateway.act({ operation: secret, userId: "u" })).toEqual({ kind: "missing" });
    expect(await routes(refused("unauthorized", 401)).gateway.act({ operation: secret, userId: "u" })).toEqual({ kind: "failed" });
    expect(await routes(refused("workspace_secret_unavailable", 503)).gateway.act({ operation: secret, userId: "u" })).toEqual({ kind: "failed" });
    const skill: TelegramChangeOperation = { expectedVersion: 3, kind: "skill_delete", skillId: "k-1" };
    expect(await routes(refused("skill_version_conflict", 409)).gateway.act({ operation: skill, userId: "u" })).toEqual({ kind: "changed" });
    expect(await routes(refused("skill_not_available", 404)).gateway.act({ operation: skill, userId: "u" })).toEqual({ kind: "missing" });
    const publish: TelegramChangeOperation = { assistantId: "a-1", expectedVersion: 4, groupId: "g-1", kind: "assistant_publish" };
    expect(await routes(refused("assistant_version_conflict", 409)).gateway.act({ operation: publish, userId: "u" })).toEqual({ kind: "changed" });
    expect(await routes(refused("assistant_archived", 409)).gateway.act({ operation: publish, userId: "u" })).toEqual({ kind: "archived" });
    expect(await routes(refused("assistant_not_found", 404)).gateway.act({ operation: publish, userId: "u" })).toEqual({ kind: "missing" });
    expect(await routes(refused("assistant_skill_audience_mismatch", 409, { skills: ["Pricing", 7] })).gateway.act({ operation: publish, userId: "u" }))
      .toEqual({ code: "assistant_skill_audience_mismatch", kind: "refused", skills: ["Pricing"] });
    expect(await routes(refused("unauthorized", 401)).gateway.act({ operation: publish, userId: "u" })).toEqual({ kind: "failed" });
    const task: TelegramChangeOperation = { kind: "scheduled_task_delete", taskId: "t-1" };
    expect(await routes(refused("scheduled_task_not_found", 404)).gateway.act({ operation: task, userId: "u" })).toEqual({ kind: "missing" });
  });

  it("undoes an instructions change as the web card does: an update reads the preset, then writes the earlier text under the revision", async () => {
    const card: InstructionsChangeCard = { version: 1, resource: "instructions", action: "updated", presetId: "p-1", revision: 2, name: "Work",
      previousText: "Be brief.", diff: null };
    const preset = { answerRules: null, id: "p-1", name: "Work", responseReminder: "Reply in English.", revision: 2, systemInstructions: "Use tables.",
      updatedAt: "2026-11-20T09:00:00.000Z" };
    const answers = [() => Response.json({ preset }), () => Response.json({ instructions: {} })];
    const fake = routes(() => answers.shift()!());
    expect(await fake.gateway.act({ operation: { card, kind: "instructions_undo" }, userId: "u" })).toEqual({ kind: "done" });
    expect(fake.calls).toEqual([
      { body: null, method: "GET", params: ["p-1"], path: "/api/me/instructions/p-1", route: "instructionPreset" },
      { body: { action: "update", id: "p-1", revision: 2, value: { answerRules: null, name: "Work", responseReminder: "Reply in English.",
        systemInstructions: "Be brief." } }, method: "POST", params: [], path: "/api/me/instructions", route: "instructions" }
    ]);
    // Changed since: nothing is sent.
    const moved = routes(() => Response.json({ preset: { ...preset, revision: 3 } }));
    expect(await moved.gateway.act({ operation: { card, kind: "instructions_undo" }, userId: "u" })).toEqual({ kind: "changed" });
    expect(moved.calls).toHaveLength(1);
    expect(await routes(refused("instruction_preset_not_found", 404)).gateway.act({ operation: { card, kind: "instructions_undo" }, userId: "u" }))
      .toEqual({ kind: "missing" });
    // A creation's Undo deletes its preset under the revision; the route's conflict reads as changed.
    const created: InstructionsChangeCard = { ...card, action: "created", previousText: null, revision: 1 };
    const deletion = routes(ok);
    expect(await deletion.gateway.act({ operation: { card: created, kind: "instructions_undo" }, userId: "u" })).toEqual({ kind: "done" });
    expect(deletion.calls).toEqual([{ body: { action: "delete", id: "p-1", revision: 1 }, method: "POST", params: [], path: "/api/me/instructions",
      route: "instructions" }]);
    expect(await routes(refused("instruction_preset_conflict", 409)).gateway.act({ operation: { card: created, kind: "instructions_undo" }, userId: "u" }))
      .toEqual({ kind: "changed" });
  });

  it("undoes a memory note change as the web card does: reads the note, then saves the earlier text under the revision", async () => {
    const card: MemoryNoteChangeCard = { version: 1, resource: "memory_note", action: "added", revision: 3, before: null, after: "Use tables.",
      previousText: "Call me Sam." };
    const note = { lastChangedBy: "agent", revision: 3, text: "Call me Sam.\nUse tables.", updatedAt: "2026-11-22T10:00:00.000Z" };
    const answers = [() => Response.json(note), () => Response.json({ ...note, lastChangedBy: "user", revision: 4, text: "Call me Sam." })];
    const fake = routes(() => answers.shift()!());
    expect(await fake.gateway.act({ operation: { card, kind: "memory_note_undo" }, userId: "u" })).toEqual({ kind: "done" });
    expect(fake.calls).toEqual([
      { body: null, method: "GET", params: [], path: "/api/me/memory/note", route: "memoryNote" },
      { body: { revision: 3, text: "Call me Sam." }, method: "PUT", params: [], path: "/api/me/memory/note", route: "memoryNote" }
    ]);
    // Changed since: nothing is sent.
    const moved = routes(() => Response.json({ ...note, revision: 4 }));
    expect(await moved.gateway.act({ operation: { card, kind: "memory_note_undo" }, userId: "u" })).toEqual({ kind: "changed" });
    expect(moved.calls).toHaveLength(1);
    const conflict = [() => Response.json(note), refused("memory_note_conflict", 409)];
    expect(await routes(() => conflict.shift()!()).gateway.act({ operation: { card, kind: "memory_note_undo" }, userId: "u" }))
      .toEqual({ kind: "changed" });
    const secret = [() => Response.json(note), refused("memory_note_invalid", 400, { reason: "secret" })];
    expect(await routes(() => secret.shift()!()).gateway.act({ operation: { card, kind: "memory_note_undo" }, userId: "u" }))
      .toEqual({ code: "memory_note_invalid", kind: "refused" });
    expect(await routes(refused("unauthorized", 401)).gateway.act({ operation: { card, kind: "memory_note_undo" }, userId: "u" }))
      .toEqual({ kind: "failed" });
  });

  it("sends an offer's Remember and No thanks to the offer route and reads its refusals", async () => {
    const accept: TelegramChangeOperation = { decision: "accept", kind: "memory_note_offer", offerId: "offer-1" };
    const fake = routes(() => Response.json({ change: null, offer: { decidedAt: null, offerId: "offer-1", state: "pending" } }));
    expect(await fake.gateway.act({ operation: accept, userId: "u" })).toEqual({ kind: "done" });
    expect(await fake.gateway.act({ operation: { ...accept, decision: "dismiss" }, userId: "u" })).toEqual({ kind: "done" });
    expect(fake.calls).toEqual([
      { body: { decision: "accept" }, method: "POST", params: ["offer-1"], path: "/api/me/memory/offers/offer-1", route: "memoryNoteOffer" },
      { body: { decision: "dismiss" }, method: "POST", params: ["offer-1"], path: "/api/me/memory/offers/offer-1", route: "memoryNoteOffer" }
    ]);
    expect(await routes(refused("memory_note_offer_stale", 409)).gateway.act({ operation: accept, userId: "u" })).toEqual({ kind: "changed" });
    expect(await routes(refused("memory_note_offer_not_found", 404)).gateway.act({ operation: accept, userId: "u" })).toEqual({ kind: "missing" });
    for (const code of ["memory_note_too_long", "memory_disabled"]) {
      expect(await routes(refused(code, 409, { characters: 6_100, limit: 6_000 })).gateway.act({ operation: accept, userId: "u" }))
        .toEqual({ code, kind: "refused" });
    }
    expect(await routes(refused("memory_note_unavailable", 503)).gateway.act({ operation: accept, userId: "u" })).toEqual({ kind: "failed" });
  });

  it("reads a Skill save's Undo and a default sub-agent's Undo from their answers", async () => {
    const save: TelegramChangeOperation = { kind: "skill_save_undo", saveId: "save-1", skillId: "k-1" };
    const undone = routes(() => Response.json({ outcome: "restored", revision: 4, state: "undone" }));
    expect(await undone.gateway.act({ operation: save, userId: "u" })).toEqual({ kind: "skill_save_undone", outcome: "restored", revision: 4 });
    expect(undone.calls[0]).toMatchObject({ method: "POST", params: ["k-1", "save-1"], path: "/api/me/skills/k-1/saves/save-1/undo" });
    expect(await routes(() => Response.json({ state: "conflict" })).gateway.act({ operation: save, userId: "u" })).toEqual({ kind: "changed" });
    expect(await routes(() => Response.json({ state: "unavailable" })).gateway.act({ operation: save, userId: "u" })).toEqual({ kind: "missing" });
    expect(await routes(refused("skill_operation_failed", 503)).gateway.act({ operation: save, userId: "u" })).toEqual({ kind: "failed" });

    const request = { restore: { expected: "d-1", target: null } };
    const moved = routes(() => Response.json({ outcome: "target_gone" }));
    expect(await moved.gateway.act({ operation: { kind: "subagent_default_undo", request }, userId: "u" }))
      .toEqual({ kind: "default_undone", outcome: "target_gone" });
    expect(moved.calls[0]).toMatchObject({ body: request, method: "POST", path: "/api/me/subagents/default/undo" });
    expect(await routes(refused("subagent_definition_conflict", 409)).gateway.act({ operation: { kind: "subagent_default_undo", request }, userId: "u" }))
      .toEqual({ kind: "changed" });
  });
});
