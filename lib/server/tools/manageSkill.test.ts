// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { decodeResourceChangeCard } from "@/lib/contracts/resourceChanges";
import { decodeSkillSaveCard, type SkillSaveCard } from "@/lib/contracts/skillSaves";
import { logEvent } from "../observability";
import type { AgentSkillService } from "../skills/agentSkills";
import { MANAGE_SKILL_TOOL_NAME, executeManageSkill, manageSkillTool } from "./manageSkill";
import { invalidProviderToolArguments, type ToolExecutionResult } from "./types";

vi.mock("../observability", async (importOriginal) => ({
  ...await importOriginal<typeof import("../observability")>(), logEvent: vi.fn()
}));

const MARKDOWN = "---\nname: report-writer\ndescription: Weekly report\n---\nWrite the weekly report.\n";
const skills = { version: 2, mode: "auto", tools: "load_and_read",
  pinned: [{ alias: "report-writer", fileCount: 1, name: "report-writer", revisionId: "rev-3", skillId: "skill-own" }],
  available: [] } as never;
const context = { skills };
const call = (args: Record<string, unknown>) => ({ arguments: args, id: "call_skill", name: MANAGE_SKILL_TOOL_NAME });
const card: SkillSaveCard = {
  changeNote: null, copiedFrom: null, diffs: [], files: [{ change: "added", executable: false, path: "SKILL.md" }], fromRevision: null, name: "report-writer",
  outcome: "created", published: false, revisionId: "rev-1", saveId: "save-1", scheduledTasks: [], scheduledTasksTruncated: false, skillId: "skill-new",
  toRevision: 1, version: 1
};

function service(overrides: Partial<AgentSkillService> = {}) {
  return {
    proposeDelete: vi.fn<AgentSkillService["proposeDelete"]>(async (skillId) => ({ kind: "proposed", card: { action: "delete_proposed",
      assistantCount: 2, name: "report-writer", resource: "skill", scheduledTasks: [], shared: true, skillId, version: 1 } })),
    save: vi.fn<AgentSkillService["save"]>(async (_save, result) => {
      const saved = { card, version: 1 };
      return { kind: "changed", result: result(saved), value: saved };
    }),
    ...overrides
  };
}

const json = (result: ToolExecutionResult) => (result.content[0] as { value: Record<string, unknown> }).value;

describe("manage_skill", () => {
  it("changes the Skill library without the VM and without approval", () => {
    expect(manageSkillTool).toMatchObject({ effects: "external", name: "manage_skill", needsApproval: false, requiresVm: false });
  });

  it("creates a Skill from the call's files and answers with the save card", async () => {
    const fake = service();
    const result = await executeManageSkill(fake, call({ action: "save", changeNote: " First ", files: [
      { content: MARKDOWN, path: "SKILL.md" }, { content: "#!/usr/bin/env python3\nprint('hi')\n", path: "./scripts/report.py" }
    ], target: "new" }), context);
    expect(fake.save).toHaveBeenCalledWith({ changeNote: "First", files: [{ bytes: Buffer.from(MARKDOWN), path: "SKILL.md" },
      { bytes: Buffer.from("#!/usr/bin/env python3\nprint('hi')\n"), path: "scripts/report.py" }], removeFiles: [], target: { kind: "new" } },
    expect.any(Function));
    expect(result.status).toBe("complete");
    expect(json(result)).toMatchObject({ outcome: "created", saved: true, skillId: "skill-new" });
    expect(decodeSkillSaveCard((result.artifacts?.[0] as { data: { payload: unknown } }).data.payload)).toEqual(card);
  });

  it("saves a new version of the run's Skill by alias, guarded by the revision the run staged", async () => {
    const fake = service();
    await executeManageSkill(fake, call({ action: "save", files: [{ content: MARKDOWN, path: "SKILL.md" }], removeFiles: ["old.md"],
      target: "report-writer" }), context);
    expect(fake.save.mock.calls[0]![0]).toMatchObject({ removeFiles: ["old.md"], target: { kind: "frozen", revisionId: "rev-3", skillId: "skill-own" } });
    await executeManageSkill(fake, call({ action: "save", expectedVersion: 4, files: [{ content: "x", path: "notes.md" }], target: "skill-own" }), context);
    expect(fake.save.mock.calls[1]![0]).toMatchObject({ target: { expectedVersion: 4, kind: "version", skillId: "skill-own" } });
  });

  it("restores or lists versions through the same save", async () => {
    const fake = service({ save: vi.fn(async () => ({ kind: "refused" as const, value: { kind: "versions" as const, list: {
      currentVersion: 5, more: false, name: "report-writer", skillId: "skill-own",
      versions: [{ changeNote: null, createdAt: "2026-10-01T00:00:00.000Z", current: true, files: 1, restoredFrom: null, revision: 5 }] } } })) });
    const listed = await executeManageSkill(fake, call({ action: "restore", revision: 0, target: "report-writer" }), context);
    expect(fake.save.mock.calls[0]![0]).toEqual({ changeNote: null, target: { guard: { revisionId: "rev-3" }, kind: "restore", revision: 0, skillId: "skill-own" } });
    expect(json(listed)).toMatchObject({ currentVersion: 5, saved: false, versions: [{ current: true, revision: 5 }] });
    expect(String(json(listed).message)).toContain("action restore");
  });

  it.each([
    [{ code: "skill_version_conflict", kind: "refused", conflict: { currentRevision: 6, currentVersion: 7, differingFiles: [{ content: "new", path: "SKILL.md" }],
      newFiles: [], omittedFiles: [], skillId: "skill-own" } }, "skill_version_conflict", "Merge the changes"],
    [{ code: "skill_save_rate_limited", kind: "refused" }, "skill_save_rate_limited", "20 Skills from chat in the last hour"],
    [{ code: "skill_save_answer_limit", kind: "refused" }, "skill_save_answer_limit", "one answer saves at most one"],
    [{ code: "skill_save_secret_detected", files: ["scripts/report.py"], kind: "invalid" }, "skill_save_secret_detected", "environment variables at run time"],
    [{ code: "skill_binary_files_kept", files: ["logo.png"], kind: "invalid" }, "skill_binary_files_kept", "Remove them with removeFiles"],
    [{ code: "skill_markdown_required", kind: "invalid" }, "skill_markdown_required", "needs SKILL.md"],
    [{ code: "skill_save_bundle_invalid", details: { field: "description" }, kind: "invalid", problem: "skill_field_required" }, "skill_save_bundle_invalid", "fix the reported problem"]
  ] as const)("explains the refusal %j", async (value, code, message) => {
    const result = await executeManageSkill(service({ save: vi.fn(async () => ({ kind: "refused" as const, value })) }),
      call({ action: "save", files: [{ content: MARKDOWN, path: "SKILL.md" }], target: "new" }), context);
    expect(result.status).toBe("error");
    expect(json(result)).toMatchObject({ code, saved: false });
    expect(String(json(result).message)).toContain(message);
  });

  it("returns the current files on a conflict so the model can merge them", async () => {
    const result = await executeManageSkill(service({ save: vi.fn(async () => ({ kind: "refused" as const, value: { code: "skill_version_conflict" as const,
      conflict: { currentRevision: 6, currentVersion: 7, differingFiles: [{ content: "new", path: "SKILL.md" }], newFiles: ["b.md"], omittedFiles: [],
        skillId: "skill-own" }, kind: "refused" as const } })) }), call({ action: "save", files: [{ content: "x", path: "b.md" }], target: "report-writer" }), context);
    expect(json(result)).toMatchObject({ currentFiles: [{ content: "new", path: "SKILL.md" }], currentVersion: 7, filesOnlyInSave: ["b.md"], skillId: "skill-own" });
  });

  it("proposes deleting the user's own Skill without deleting it, and names a colleague's Skill as not theirs", async () => {
    const fake = service();
    const result = await executeManageSkill(fake, call({ action: "propose_delete", target: "report-writer" }), context);
    expect(fake.proposeDelete).toHaveBeenCalledWith("skill-own");
    expect(fake.save).not.toHaveBeenCalled();
    expect(json(result)).toMatchObject({ deleted: false, deletionProposed: true, skill: "report-writer" });
    expect(decodeResourceChangeCard((result.artifacts?.[0] as { data: { payload: unknown } }).data.payload))
      .toMatchObject({ action: "delete_proposed", assistantCount: 2, resource: "skill", shared: true, skillId: "skill-own" });
    const notOwn = await executeManageSkill(service({ proposeDelete: vi.fn(async () => ({ code: "skill_delete_not_own" as const, kind: "refused" as const })) }),
      call({ action: "propose_delete", target: "skill-colleague" }), context);
    expect(json(notOwn)).toMatchObject({ code: "skill_delete_not_own" });
    const unavailable = await executeManageSkill(service({ proposeDelete: vi.fn(async () => ({ code: "skill_not_available" as const, kind: "refused" as const })) }),
      call({ action: "propose_delete", target: "skill-hidden" }), context);
    const missing = await executeManageSkill(service({ proposeDelete: vi.fn(async () => ({ code: "skill_not_available" as const, kind: "refused" as const })) }),
      call({ action: "propose_delete", target: "skill-missing" }), context);
    expect(unavailable).toEqual(missing);
  });

  it.each([
    [invalidProviderToolArguments(), "The arguments were not valid JSON."],
    [{ action: "save", target: "new" }, "save needs files to add or replace"],
    [{ action: "save", files: [{ content: "x", path: "../escape.md" }], target: "new" }, "must be a relative path inside the Skill folder"],
    [{ action: "save", files: [{ content: "a\u0000b", path: "a.bin" }], target: "new" }, "without NUL characters"],
    [{ action: "save", files: [{ content: "x", path: "a.md" }, { content: "y", path: "A.md" }], target: "new" }, "lists \"A.md\" twice"],
    [{ action: "save", removeFiles: ["SKILL.md"], target: "report-writer" }, "SKILL.md cannot be removed"],
    [{ action: "save", files: [{ content: "x", path: "a.md" }], removeFiles: ["a.md"], target: "report-writer" }, "both in files and in removeFiles"],
    [{ action: "save", files: [{ content: "x".repeat(1_048_577), path: "big.md" }], target: "new" }, "larger than 1 MiB"],
    [{ action: "save", files: [{ content: "x", path: "a.md" }], target: "unknown-alias" }, "Use target \"new\""],
    [{ action: "save", files: [{ content: "x", path: "a.md" }], revision: 2, target: "new" }, "save takes no revision"],
    [{ action: "restore", target: "report-writer" }, "restore needs revision"],
    [{ action: "propose_delete", target: "new" }, "Name the Skill by its alias"],
    [{ action: "propose_delete", files: [], target: "report-writer" }, "propose_delete takes only target"],
    [{ action: "publish", target: "report-writer" }, "action must be one of save, restore, propose_delete."],
    [{ action: "save", target: "new", userId: "u2" }, "Unknown argument \"userId\""]
  ])("refuses %j with what to fix", async (args, message) => {
    const fake = service();
    const result = await executeManageSkill(fake, call(args), context);
    expect(result.status).toBe("error");
    expect(String(json(result).message)).toContain(message);
    expect(fake.save).not.toHaveBeenCalled();
  });

  it("logs an unexpected failure without content", async () => {
    vi.mocked(logEvent).mockClear();
    const result = await executeManageSkill(service({ save: vi.fn(async () => { throw new Error("Write the weekly report."); }) }),
      call({ action: "save", files: [{ content: MARKDOWN, path: "SKILL.md" }], target: "new" }), context);
    expect(json(result)).toMatchObject({ code: "skill_save_failed" });
    expect(logEvent).toHaveBeenCalledExactlyOnceWith("service_operation", expect.objectContaining({ code: "self_service_change_failed" }));
    expect(JSON.stringify(vi.mocked(logEvent).mock.calls)).not.toContain("weekly report");
  });
});
