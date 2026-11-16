// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ThreadArtifactSummary } from "../../../contracts/chats";
import type {
  AssistantChangeCard, ProxyChangeCard, ResourceChangeCard, SecretChangeCard, SkillDeleteProposalCard, SubagentChangeCard
} from "../../../contracts/resourceChanges";
import type { ScheduledTaskCard } from "../../../contracts/scheduledTasks";
import type { SkillSaveCard } from "../../../contracts/skillSaves";
import {
  telegramAnswerChanges, telegramChangePlan, telegramChangeRef, telegramChangeResult, type TelegramChange
} from "./plan";

const SECRET_ID = "0b6f3c1e-4a2d-4c5e-9f10-2a3b4c5d6e7f";
const VERSION_ID = "1c7a4d2f-5b3e-4d6f-8a21-3b4c5d6e7f80";

const secretCard = (overrides: Partial<SecretChangeCard> = {}): SecretChangeCard => ({
  version: 1, resource: "secret", action: "created", secretId: SECRET_ID, versionId: VERSION_ID, name: "Synthetic token", kind: "env",
  envNames: ["SYNTHETIC_TOKEN"], previousName: null, valueReplaced: false, proposalId: null, ...overrides
});
const skillDelete: SkillDeleteProposalCard = {
  version: 1, resource: "skill", action: "delete_proposed", skillId: "skill-1", skillVersion: 3, proposalId: "proposal-1", name: "Weekly report",
  assistantCount: 2, shared: true, scheduledTasks: [{ taskId: "task-1", title: "Monday digest" }]
};
const assistantCard = (overrides: Partial<AssistantChangeCard> = {}): AssistantChangeCard => ({
  version: 1, resource: "assistant", action: "created", assistantId: "assistant-1", definitionVersion: 2, name: "Travel planner", changes: [],
  instructionsDiff: null, audience: null, consequences: null, proposalId: null, ...overrides
});
const subagentCard = (overrides: Partial<SubagentChangeCard> = {}): SubagentChangeCard => ({
  version: 1, resource: "subagent", action: "created", definitionId: "definition-1", definitionVersion: 4, name: "reviewer", previousName: null,
  changes: [], instructionsDiff: null, undoRevisionId: null, consequences: null, proposalId: null, ...overrides
});
const proxyCard = (overrides: Partial<ProxyChangeCard> = {}): ProxyChangeCard => ({
  version: 1, resource: "proxy", action: "created", proxyId: "proxy-1", proxyVersion: 1, name: "Office exit", protocol: "socks5", country: "DE",
  domainHints: [".example.com"], previousName: null, passwordChanged: false, proposalId: null, ...overrides
});
const skillSave: SkillSaveCard = {
  version: 1, saveId: "save-1", skillId: "skill-2", revisionId: "revision-2", name: "Release notes", outcome: "updated", fromRevision: 1,
  toRevision: 2, changeNote: "Shorter summary.", copiedFrom: null, published: false,
  files: [{ change: "changed", executable: false, path: "SKILL.md" }, { change: "unchanged", executable: false, path: "notes.md" }],
  diffs: [], scheduledTasks: [], scheduledTasksTruncated: false
};
const task: ScheduledTaskCard = {
  taskId: "task-9", title: "Price watch", kind: "standard", schedule: { kind: "daily", time: "09:00" }, timeZone: "UTC", timeZoneFallback: false,
  toolsEnabled: true, workspaceEnabled: false, status: "active", nextRunAt: null, action: "delete_proposed"
};

const resource = (card: ResourceChangeCard): TelegramChange =>
  ({ card, kind: "resource" });

describe("the changes a Telegram answer shows", () => {
  it("are the web answer's resource changes, Skill saves and automation deletion proposals, decoded, in that order", () => {
    const summary: ThreadArtifactSummary = {
      citations: [], reasoningText: [], sources: [],
      resourceChanges: [secretCard(), { ...secretCard(), secretId: "not-a-uuid" } as never],
      skillSaves: [skillSave],
      scheduledTasks: [task, { ...task, action: "paused", taskId: "task-10" }]
    };
    expect(telegramAnswerChanges(summary).map((change) => change.kind)).toEqual(["resource", "skill_save", "task"]);
    expect(telegramAnswerChanges(null)).toEqual([]);
  });

  it("refers to a change by a short stable hash that names no resource", () => {
    const ref = telegramChangeRef(resource(secretCard()));
    expect(ref).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(ref).toBe(telegramChangeRef(resource(secretCard())));
    expect(ref).not.toBe(telegramChangeRef(resource(secretCard({ versionId: "2d8b5e3a-6c4f-4e7a-9b32-4c5d6e7f8091" }))));
    expect(ref).not.toContain(SECRET_ID);
  });
});

describe("what each change offers, as the web card does", () => {
  it("a saved secret offers Undo, which deletes the revision it left; a replaced one offers nothing; a deletion asks", () => {
    const created = telegramChangePlan(resource(secretCard()));
    expect(created.view).toMatchObject({ heading: "Secret saved", meta: "Environment · SYNTHETIC_TOKEN", name: "Synthetic token" });
    expect(created.undo?.operation).toEqual({ kind: "secret_delete", secretId: SECRET_ID, versionId: VERSION_ID });
    expect(created.proposal).toBeNull();
    const updated = telegramChangePlan(resource(secretCard({ action: "updated", valueReplaced: true })));
    expect(updated.undo).toBeNull();
    expect(updated.proposal).toBeNull();
    expect(updated.view.details).toContain("The value was replaced; earlier values are not kept.");
    const proposal = telegramChangePlan(resource(secretCard({ action: "delete_proposed", proposalId: "proposal-2" })));
    expect(proposal.undo).toBeNull();
    expect(proposal.proposal).toMatchObject({ confirmLabel: "Delete secret", keepLabel: "Keep secret",
      operation: { kind: "secret_delete", secretId: SECRET_ID, versionId: VERSION_ID } });
    expect(proposal.view.heading).toBe("Delete secret?");
  });

  it("a Skill deletion names its consequences and is guarded by the version the proposal saw", () => {
    const plan = telegramChangePlan(resource(skillDelete));
    expect(plan.proposal?.operation).toEqual({ expectedVersion: 3, kind: "skill_delete", skillId: "skill-1" });
    expect(plan.view.details).toEqual(expect.arrayContaining(["Linked by 2 Assistants, which lose it.", "Shared with colleagues, who lose access."]));
  });

  it("a Skill save offers Undo through its save receipt", () => {
    const plan = telegramChangePlan({ card: skillSave, kind: "skill_save" });
    expect(plan.view).toMatchObject({ heading: "Skill updated", meta: "v1 → v2" });
    expect(plan.undo?.operation).toEqual({ kind: "skill_save_undo", saveId: "save-1", skillId: "skill-2" });
  });

  it("an Assistant's creation archives on Undo; an edit has none; publishing and deleting ask", () => {
    expect(telegramChangePlan(resource(assistantCard())).undo?.operation).toEqual({ assistantId: "assistant-1", expectedVersion: 2, kind: "assistant_archive" });
    expect(telegramChangePlan(resource(assistantCard({ action: "updated", changes: [{ field: "model", summary: "Model B" }] }))).undo).toBeNull();
    const group = telegramChangePlan(resource(assistantCard({ action: "publish_proposed", audience: { groupId: "group-1", groupName: "Sales", kind: "group" },
      proposalId: "proposal-3" })));
    expect(group.proposal).toMatchObject({ confirmLabel: "Publish", keepLabel: "Not now",
      operation: { assistantId: "assistant-1", expectedVersion: 2, groupId: "group-1", kind: "assistant_publish" } });
    const everyone = telegramChangePlan(resource(assistantCard({ action: "publish_proposed", audience: { kind: "everyone" }, proposalId: "proposal-4" })));
    expect(everyone.proposal?.operation).toEqual({ assistantId: "assistant-1", expectedVersion: 2, kind: "assistant_listing" });
    const deletion = telegramChangePlan(resource(assistantCard({ action: "delete_proposed", proposalId: "proposal-5",
      consequences: { chatCount: 3, everyone: false, groupNames: [], pendingListingRequest: false } })));
    expect(deletion.proposal?.operation).toEqual({ assistantId: "assistant-1", expectedVersion: 2, kind: "assistant_delete" });
  });

  it("a sub-agent's Undo deletes a creation, restores an edit, and puts the default back with it in one request", () => {
    expect(telegramChangePlan(resource(subagentCard())).undo?.operation).toEqual({ definitionId: "definition-1", expectedVersion: 4, kind: "subagent_delete" });
    const edited = subagentCard({ action: "updated", changes: [{ field: "model", summary: null }], undoRevisionId: "revision-3" });
    expect(telegramChangePlan(resource(edited)).undo?.operation)
      .toEqual({ definitionId: "definition-1", expectedVersion: 4, kind: "subagent_restore", revisionId: "revision-3" });
    const defaultChange = { changeId: "move-1", isDefault: true, previous: { definitionId: "definition-0", name: "helper" } };
    const createdDefault = telegramChangePlan(resource(subagentCard({ defaultChange })));
    expect(createdDefault.undo?.operation).toEqual({ kind: "subagent_default_undo", request: {
      definition: { expectedVersion: 4, id: "definition-1", revisionId: null }, restore: { expected: "definition-1", target: "definition-0" }
    } });
    const movedOnly = telegramChangePlan(resource(subagentCard({ action: "updated", changes: [{ field: "default", summary: null }], defaultChange })));
    expect(movedOnly.undo?.operation).toEqual({ kind: "subagent_default_undo", request: { restore: { expected: "definition-1", target: "definition-0" } } });
    expect(telegramChangeResult(movedOnly, "undo", { kind: "default_undone", outcome: "changed" }).view.status)
      .toBe("Undo is not available: the default sub-agent changed after this, and that change is kept.");
    expect(telegramChangeResult(createdDefault, "undo", { kind: "default_undone", outcome: "restored" }).view)
      .toMatchObject({ heading: "Sub-agent removed", status: "Undone: the sub-agent is deleted. “helper” is the default again." });
  });

  it("a proxy shows no address, offers Undo on creation and asks before deleting; an automation deletion asks", () => {
    const created = telegramChangePlan(resource(proxyCard()));
    expect(created.view.meta).toBe("SOCKS5 · DE · .example.com");
    expect(created.undo?.operation).toEqual({ expectedVersion: 1, kind: "proxy_delete", proxyId: "proxy-1" });
    expect(telegramChangePlan(resource(proxyCard({ action: "updated" }))).undo).toBeNull();
    const deletion = telegramChangePlan({ card: task, kind: "task" });
    expect(deletion.proposal).toMatchObject({ confirmLabel: "Delete automation", operation: { kind: "scheduled_task_delete", taskId: "task-9" } });
  });
});

describe("what a press shows", () => {
  const created = telegramChangePlan(resource(secretCard()));
  const proposal = telegramChangePlan(resource(secretCard({ action: "delete_proposed", proposalId: "proposal-2" })));

  it("says what was done, or why nothing was, in the web card's words", () => {
    expect(telegramChangeResult(created, "undo", { kind: "done" })).toEqual({ retry: false, view: expect.objectContaining({
      details: [], heading: "Secret removed", status: "Undone: the secret is deleted." }) });
    expect(telegramChangeResult(created, "undo", { kind: "changed" }).view.status)
      .toBe("Undo is not available: the secret changed after this, and that change is kept.");
    expect(telegramChangeResult(created, "undo", { kind: "missing" }).view.status).toBe("This secret no longer exists.");
    expect(telegramChangeResult(proposal, "confirm", { kind: "done" }).view.heading).toBe("Secret deleted");
    expect(telegramChangeResult(proposal, "confirm", { kind: "changed" }).view).toMatchObject({ heading: "Secret not deleted",
      status: "The secret changed after this proposal, so nothing was deleted. Review it in Settings › Secrets." });
    expect(telegramChangeResult(proposal, "confirm", { kind: "missing" }).view.heading).toBe("Secret already deleted");
    expect(telegramChangeResult(proposal, "cancel", { kind: "done" }).view).toMatchObject({ heading: "Secret kept", status: null });
  });

  it("offers the buttons again after a failure or an Assistant refusal the user can resolve", () => {
    expect(telegramChangeResult(created, "undo", { kind: "failed" })).toMatchObject({ retry: true, view: { heading: "Secret saved", status: "Undo failed. Try again." } });
    const publish = telegramChangePlan(resource(assistantCard({ action: "publish_proposed", audience: { groupId: "group-1", groupName: "Sales", kind: "group" },
      proposalId: "proposal-3" })));
    expect(telegramChangeResult(publish, "confirm", { code: "assistant_skill_audience_mismatch", kind: "refused", skills: ["Pricing"] }))
      .toMatchObject({ retry: true, view: { status: "Share these Skills: “Pricing” with this audience first, then publish again." } });
    expect(telegramChangeResult(publish, "confirm", { kind: "archived" }).view).toMatchObject({ heading: "Not published",
      status: "The Assistant is archived; restore it in Settings › Assistants first." });
  });

  it("counts an automation already gone as deleted, as the web card does", () => {
    const deletion = telegramChangePlan({ card: task, kind: "task" });
    expect(telegramChangeResult(deletion, "confirm", { kind: "missing" }).view.heading).toBe("Automation deleted");
  });

  it("reads a Skill save's Undo as the owner's store reports it", () => {
    const plan = telegramChangePlan({ card: skillSave, kind: "skill_save" });
    expect(telegramChangeResult(plan, "undo", { kind: "skill_save_undone", outcome: "restored", revision: 3 }).view.status)
      .toBe("Undone: the previous content is current again as v3.");
    expect(telegramChangeResult(plan, "undo", { kind: "changed" }).view.status)
      .toBe("Undo is not available: the Skill changed after this save, and that change is kept.");
  });
});
