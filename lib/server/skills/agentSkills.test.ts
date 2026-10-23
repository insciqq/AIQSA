// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { SkillSaveCard } from "@/lib/contracts/skillSaves";
import type { ToolExecutionResult } from "../tools/types";
import { createAgentSkillService, overlaySkillBundle, type AgentSkillFileEdit } from "./agentSkills";
import { skillAccessWhere } from "./prismaRepository";
import type { SkillBundle } from "./bundle";

const USER = "user_1";
const MARKDOWN = "---\nname: report-writer\ndescription: Weekly report\n---\nWrite the weekly report.\n";
const scope = { callId: "call_1", chatId: "chat_1", runId: "run_1", userId: USER };
const result: ToolExecutionResult = { callId: "provider_call", content: [{ text: "saved", type: "text" }], name: "manage_skill", status: "complete" };
const edit = (path: string, content: string): AgentSkillFileEdit => ({ bytes: Buffer.from(content), path });
const base = {
  description: "Weekly report", frontmatterJson: null, instructions: "Write the weekly report.\n", name: "report-writer",
  files: [
    { executable: true, kind: "text", path: "scripts/report.sh", textContent: "echo report\n" },
    { executable: false, kind: "text", path: "notes.md", textContent: "Notes\n" }
  ]
};

const bundleOf = (value: ReturnType<typeof overlaySkillBundle>) => {
  if ("kind" in value) throw new Error(`refused: ${value.code}`);
  return value as SkillBundle;
};

describe("overlaying a save on the guarded version", () => {
  it("needs SKILL.md for a new Skill and infers executables from #!", () => {
    expect(overlaySkillBundle(null, { files: [edit("a.md", "x")], removeFiles: [] }, [])).toEqual({ code: "skill_markdown_required", kind: "invalid" });
    const bundle = bundleOf(overlaySkillBundle(null, { files: [edit("SKILL.md", MARKDOWN), edit("run.py", "#!/usr/bin/env python3\n")], removeFiles: [] }, []));
    expect(bundle).toMatchObject({ description: "Weekly report", instructions: "Write the weekly report.", name: "report-writer" });
    expect(bundle.files.map((file) => [file.path, file.executable, file.kind])).toEqual([["run.py", true, "text"]]);
  });

  it("keeps every file the save does not name, replaces and adds the named ones and removes the listed ones", () => {
    const bundle = bundleOf(overlaySkillBundle(base, { files: [edit("notes.md", "New notes\n"), edit("extra.md", "More\n")], removeFiles: [] }, []));
    expect(bundle).toMatchObject({ instructions: "Write the weekly report.\n", name: "report-writer" });
    expect(bundle.files.map((file) => [file.path, file.textContent, file.executable])).toEqual([
      ["extra.md", "More\n", false], ["notes.md", "New notes\n", false], ["scripts/report.sh", "echo report\n", true]
    ]);
    const removed = bundleOf(overlaySkillBundle(base, { files: [edit("SKILL.md", MARKDOWN.replace("Write", "Draft"))], removeFiles: ["notes.md"] }, []));
    expect(removed.instructions).toBe("Draft the weekly report.");
    expect(removed.files.map((file) => file.path)).toEqual(["scripts/report.sh"]);
  });

  it("refuses unknown removals, kept binary files, secret values and invalid Skills", () => {
    expect(overlaySkillBundle(base, { files: [], removeFiles: ["missing.md"] }, [])).toEqual({ code: "skill_file_unknown", files: ["missing.md"], kind: "invalid" });
    const binary = { ...base, files: [...base.files, { executable: false, kind: "binary", path: "logo.png", textContent: null }] };
    expect(overlaySkillBundle(binary, { files: [edit("notes.md", "x")], removeFiles: [] }, []))
      .toEqual({ code: "skill_binary_files_kept", files: ["logo.png"], kind: "invalid" });
    expect("kind" in overlaySkillBundle(binary, { files: [], removeFiles: ["logo.png"] }, [])).toBe(false);
    expect(overlaySkillBundle(base, { files: [edit("scripts/report.sh", "curl -H 'token: glpat-synthetic-1'\n")], removeFiles: [] },
      [Buffer.from("glpat-synthetic-1")])).toEqual({ code: "skill_save_secret_detected", files: ["scripts/report.sh"], kind: "invalid" });
    expect(overlaySkillBundle(null, { files: [edit("SKILL.md", "no front matter")], removeFiles: [] }, []))
      .toMatchObject({ code: "skill_save_bundle_invalid", kind: "invalid", problem: "skill_frontmatter_required" });
  });
});

const savedCard = { name: "report-writer", saveId: "save-1", skillId: "skill-own" } as SkillSaveCard;

function setup(options: Readonly<{ claim?: "open" | "settled"; visible?: boolean; owner?: string }> = {}) {
  const definition = { currentRevisionId: "rev-current", ownerUserId: options.owner ?? USER, sharedRevisionId: "rev-shared" };
  const tx = {
    $queryRaw: vi.fn(async () => [{ pg_advisory_xact_lock: "" }]),
    skillDefinition: { findFirst: vi.fn(async () => options.visible === false ? null : definition) },
    skillRevision: { findFirst: vi.fn(async () => base) }
  };
  const db = {
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    assistantDefinition: { count: vi.fn(async () => 3) },
    skillDefinition: { findFirst: vi.fn(async () => options.visible === false ? null
      : { currentRevision: { name: "report-writer" }, ownerUserId: options.owner ?? USER, publications: [{ id: "pub_1" }] }) }
  };
  const store = { claim: vi.fn(async () => options.claim === "settled" ? { kind: "settled" as const, result } : { kind: "open" as const }),
    settle: vi.fn(async () => undefined) };
  const commit = vi.fn(async () => ({ card: savedCard, hasExecutables: false, kind: "saved" as const, version: 2 }));
  const secretNeedles = vi.fn(async () => [Buffer.from("glpat-synthetic-1")]);
  const service = createAgentSkillService({ commit: commit as never, db: db as never, scope, secretNeedles, store });
  return { commit, db, secretNeedles, service, store, tx };
}

describe("agent Skill service", () => {
  it("saves a new Skill through the chat save and settles the call with its card", async () => {
    const fixture = setup();
    const outcome = await fixture.service.save({ changeNote: "First", files: [edit("SKILL.md", MARKDOWN)], removeFiles: [], target: { kind: "new" } }, () => result);
    expect(outcome).toEqual({ kind: "changed", result, value: { card: savedCard, version: 2 } });
    expect(fixture.commit).toHaveBeenCalledWith(fixture.tx, expect.objectContaining({ changeNote: "First", operationKey: "call_1", runId: "run_1",
      target: { kind: "new" }, userId: USER, bundle: expect.objectContaining({ name: "report-writer" }) }));
    expect(fixture.store.settle).toHaveBeenCalledWith(fixture.tx, result);
    expect(fixture.tx.skillDefinition.findFirst).not.toHaveBeenCalled();
  });

  it("builds a new version on the revision the run staged, read through the user's Skill access", async () => {
    const fixture = setup();
    await fixture.service.save({ changeNote: null, files: [edit("notes.md", "New\n")], removeFiles: [],
      target: { kind: "frozen", revisionId: "rev-3", skillId: "skill-own" } }, () => result);
    expect(fixture.tx.skillDefinition.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { deletedAt: null, id: "skill-own", ...skillAccessWhere(USER) } }));
    expect(fixture.tx.skillRevision.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { bundleReady: true, id: "rev-3", skillId: "skill-own" } }));
    const bundle = (fixture.commit.mock.calls[0] as unknown as [unknown, { bundle: SkillBundle }])[1].bundle;
    expect(bundle.files.map((file) => file.path)).toEqual(["notes.md", "scripts/report.sh"]);
    await fixture.service.save({ changeNote: null, files: [edit("notes.md", "New\n")], removeFiles: [],
      target: { expectedVersion: 4, kind: "version", skillId: "skill-own" } }, () => result);
    expect(fixture.tx.skillRevision.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { bundleReady: true, id: "rev-current", skillId: "skill-own" } }));
  });

  it("answers a Skill the user cannot see like a missing one, without saving", async () => {
    const fixture = setup({ visible: false });
    const outcome = await fixture.service.save({ changeNote: null, files: [edit("notes.md", "x")], removeFiles: [],
      target: { expectedVersion: 1, kind: "version", skillId: "skill-foreign" } }, () => result);
    expect(outcome).toEqual({ kind: "refused", value: { code: "skill_not_available", kind: "refused" } });
    expect(fixture.commit).not.toHaveBeenCalled();
    expect(fixture.store.settle).not.toHaveBeenCalled();
  });

  it("refuses a save holding a secret value before the Skill store is written", async () => {
    const fixture = setup();
    const outcome = await fixture.service.save({ changeNote: null, files: [edit("SKILL.md", `${MARKDOWN}Use glpat-synthetic-1\n`)], removeFiles: [],
      target: { kind: "new" } }, () => result);
    expect(outcome).toEqual({ kind: "refused", value: { code: "skill_save_secret_detected", files: ["SKILL.md"], kind: "invalid" } });
    expect(fixture.commit).not.toHaveBeenCalled();
  });

  it("passes the chat save's refusals through and restores without reading secrets", async () => {
    const fixture = setup();
    fixture.commit.mockResolvedValueOnce({ code: "skill_save_rate_limited", kind: "refused" } as never);
    expect(await fixture.service.save({ changeNote: null, files: [edit("SKILL.md", MARKDOWN)], removeFiles: [], target: { kind: "new" } }, () => result))
      .toEqual({ kind: "refused", value: { code: "skill_save_rate_limited", kind: "refused" } });
    fixture.secretNeedles.mockClear();
    await fixture.service.save({ changeNote: null, target: { guard: { revisionId: "rev-3" }, kind: "restore", revision: 2, skillId: "skill-own" } }, () => result);
    expect(fixture.secretNeedles).not.toHaveBeenCalled();
    expect(fixture.commit).toHaveBeenLastCalledWith(fixture.tx, expect.objectContaining({ bundle: null, target: expect.objectContaining({ kind: "restore" }) }));
  });

  it("returns a settled call's result without saving", async () => {
    const fixture = setup({ claim: "settled" });
    expect(await fixture.service.save({ changeNote: null, files: [edit("SKILL.md", MARKDOWN)], removeFiles: [], target: { kind: "new" } }, () => result))
      .toEqual({ kind: "settled", result });
    expect(fixture.commit).not.toHaveBeenCalled();
  });

  it("proposes deleting only the user's own Skill, with what deleting changes", async () => {
    const fixture = setup();
    fixture.db.$transaction.mockImplementationOnce(async (fn: (client: never) => Promise<unknown>) =>
      fn({ $queryRaw: vi.fn(async () => [{ id: "task_1", title: "Monday report" }]) } as never));
    expect(await fixture.service.proposeDelete("skill-own")).toEqual({ kind: "proposed", card: { action: "delete_proposed", assistantCount: 3,
      name: "report-writer", resource: "skill", scheduledTasks: [{ taskId: "task_1", title: "Monday report" }], shared: true, skillId: "skill-own", version: 1 } });
    expect(fixture.db.skillDefinition.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { deletedAt: null, id: "skill-own", ...skillAccessWhere(USER) } }));
    expect(await setup({ owner: "user_2" }).service.proposeDelete("skill-colleague")).toEqual({ code: "skill_delete_not_own", kind: "refused" });
    expect(await setup({ visible: false }).service.proposeDelete("skill-hidden")).toEqual({ code: "skill_not_available", kind: "refused" });
  });
});
