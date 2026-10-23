// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { decodeResourceChangeCard } from "@/lib/contracts/resourceChanges";
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

function setup(options: Readonly<{ claim?: "open" | "settled"; visible?: boolean; owner?: string; version?: number }> = {}) {
  // One row answers both reads: the save's base (revision pointers, version) and a deletion proposal's.
  const definition = { currentRevision: { name: "report-writer" }, currentRevisionId: "rev-current", ownerUserId: options.owner ?? USER,
    publications: [{ id: "pub_1" }], sharedRevisionId: "rev-shared", version: options.version ?? 4 };
  // The transaction only claims, commits and settles: the content is built before it.
  const tx = { marker: "tx" };
  const db = {
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    assistantDefinition: { count: vi.fn(async () => 3) },
    skillDefinition: { findFirst: vi.fn(async () => options.visible === false ? null : definition) },
    skillRevision: { findFirst: vi.fn(async () => base) }
  };
  const store = { claim: vi.fn(async () => options.claim === "settled" ? { kind: "settled" as const, result } : { kind: "open" as const }),
    settle: vi.fn(async () => undefined) };
  const commit = vi.fn(async () => ({ card: savedCard, hasExecutables: false, kind: "saved" as const, version: 2 }));
  const secretNeedles = vi.fn(async () => [Buffer.from("glpat-synthetic-1")]);
  const service = createAgentSkillService({ commit: commit as never, db: db as never, scope, secretNeedles, store });
  const committed = () => (commit.mock.calls.at(-1) as unknown as [unknown, { bundle: SkillBundle; target: unknown }])[1];
  return { commit, committed, db, secretNeedles, service, store, tx };
}

describe("agent Skill service", () => {
  it("saves a new Skill through the chat save and settles the call with its card", async () => {
    const fixture = setup();
    const outcome = await fixture.service.save({ changeNote: "First", files: [edit("SKILL.md", MARKDOWN)], removeFiles: [], target: { kind: "new" } }, () => result);
    expect(outcome).toEqual({ kind: "changed", result, value: { card: savedCard, version: 2 } });
    expect(fixture.commit).toHaveBeenCalledWith(fixture.tx, expect.objectContaining({ changeNote: "First", operationKey: "call_1", runId: "run_1",
      target: { kind: "new" }, userId: USER, bundle: expect.objectContaining({ name: "report-writer" }) }));
    expect(fixture.store.settle).toHaveBeenCalledWith(fixture.tx, result);
    expect(fixture.db.skillDefinition.findFirst).not.toHaveBeenCalled();
  });

  it("builds the content before the transaction, on the revision the run staged, read through the user's Skill access", async () => {
    const fixture = setup();
    const frozen = { kind: "frozen", revisionId: "rev-3", skillId: "skill-own" } as const;
    await fixture.service.save({ changeNote: null, files: [edit("notes.md", "New\n")], removeFiles: [], target: frozen }, () => result);
    expect(fixture.db.skillDefinition.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { deletedAt: null, id: "skill-own", ...skillAccessWhere(USER) } }));
    expect(fixture.db.skillRevision.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { bundleReady: true, id: "rev-3", skillId: "skill-own" } }));
    // Reads and the bundle come first; the transaction holds only the guarded commit.
    expect(fixture.db.skillRevision.findFirst.mock.invocationCallOrder[0]).toBeLessThan(fixture.db.$transaction.mock.invocationCallOrder[0]!);
    expect(fixture.secretNeedles.mock.invocationCallOrder[0]).toBeLessThan(fixture.db.$transaction.mock.invocationCallOrder[0]!);
    expect(fixture.committed().bundle.files.map((file) => file.path)).toEqual(["notes.md", "scripts/report.sh"]);
    // The staged revision is the guard: the save's core re-checks it is still current under its lock.
    expect(fixture.committed().target).toEqual(frozen);
  });

  it("keeps the owner's version guard that matched the base, for the save's core to re-check under its lock", async () => {
    const fixture = setup({ version: 4 });
    const target = { expectedVersion: 4, kind: "version", skillId: "skill-own" } as const;
    await fixture.service.save({ changeNote: null, files: [edit("notes.md", "New\n")], removeFiles: [], target }, () => result);
    expect(fixture.db.skillRevision.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { bundleReady: true, id: "rev-current", skillId: "skill-own" } }));
    expect(fixture.committed().target).toEqual(target);
  });

  it("keeps a version guard that missed below the version read, so a later version never meets it and the save is a conflict", async () => {
    const fixture = setup({ version: 5 });
    await fixture.service.save({ changeNote: null, files: [edit("notes.md", "New\n")], removeFiles: [],
      target: { expectedVersion: 3, kind: "version", skillId: "skill-own" } }, () => result);
    expect(fixture.committed().target).toEqual({ expectedVersion: 3, kind: "version", skillId: "skill-own" });
    // A guard ahead of the Skill (no result returned it) is no better than a stale one.
    await fixture.service.save({ changeNote: null, files: [edit("notes.md", "New\n")], removeFiles: [],
      target: { expectedVersion: 6, kind: "version", skillId: "skill-own" } }, () => result);
    expect(fixture.committed().target).toEqual({ expectedVersion: 4, kind: "version", skillId: "skill-own" });
  });

  it("copies another user's Skill from the exact shared revision the content was built from", async () => {
    const fixture = setup({ owner: "user_2" });
    await fixture.service.save({ changeNote: null, files: [edit("notes.md", "Mine\n")], removeFiles: [],
      target: { expectedVersion: 4, kind: "version", skillId: "skill-colleague" } }, () => result);
    expect(fixture.db.skillRevision.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { bundleReady: true, id: "rev-shared", skillId: "skill-colleague" } }));
    expect(fixture.committed().target).toEqual({ kind: "frozen", revisionId: "rev-shared", skillId: "skill-colleague" });
  });

  it("answers a Skill the user cannot see like a missing one, without saving", async () => {
    const fixture = setup({ visible: false });
    const outcome = await fixture.service.save({ changeNote: null, files: [edit("notes.md", "x")], removeFiles: [],
      target: { expectedVersion: 1, kind: "version", skillId: "skill-foreign" } }, () => result);
    expect(outcome).toEqual({ kind: "refused", value: { code: "skill_not_available", kind: "refused" } });
    expect(fixture.commit).not.toHaveBeenCalled();
    expect(fixture.store.settle).not.toHaveBeenCalled();
    // The refusal follows the claim: a call that already settled keeps its own result.
    const settled = setup({ claim: "settled", visible: false });
    expect(await settled.service.save({ changeNote: null, files: [edit("notes.md", "x")], removeFiles: [],
      target: { expectedVersion: 1, kind: "version", skillId: "skill-own" } }, () => result)).toEqual({ kind: "settled", result });
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

  it("proposes deleting only the user's own Skill, with what deleting changes and the version it saw", async () => {
    const fixture = setup({ version: 7 });
    fixture.db.$transaction.mockImplementationOnce(async (fn: (client: never) => Promise<unknown>) =>
      fn({ $queryRaw: vi.fn(async () => [{ id: "task_1", title: "Monday report" }]) } as never));
    const proposal = await fixture.service.proposeDelete("skill-own");
    expect(proposal).toEqual({ kind: "proposed", card: { action: "delete_proposed", assistantCount: 3, name: "report-writer",
      proposalId: expect.stringMatching(/^[A-Za-z0-9_-]{1,128}$/u), resource: "skill", scheduledTasks: [{ taskId: "task_1", title: "Monday report" }],
      shared: true, skillId: "skill-own", skillVersion: 7, version: 1 } });
    expect(fixture.db.skillDefinition.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { deletedAt: null, id: "skill-own", ...skillAccessWhere(USER) } }));
    // Only the user's own Assistants are counted.
    expect(fixture.db.assistantDefinition.count).toHaveBeenCalledWith({ where: { ownerUserId: USER, skillLinks: { some: { skillId: "skill-own" } } } });
    expect(await setup({ owner: "user_2" }).service.proposeDelete("skill-colleague")).toEqual({ code: "skill_delete_not_own", kind: "refused" });
    expect(await setup({ visible: false }).service.proposeDelete("skill-hidden")).toEqual({ code: "skill_not_available", kind: "refused" });
  });

  it("gives each proposal its own identity and clips task titles the answer's decoder would drop", async () => {
    const fixture = setup();
    const astral = "𝔸".repeat(120);
    fixture.db.$transaction.mockImplementation(async (fn: (client: never) => Promise<unknown>) =>
      fn({ $queryRaw: vi.fn(async () => [{ id: "task_1", title: astral }]) } as never));
    const first = await fixture.service.proposeDelete("skill-own");
    const second = await fixture.service.proposeDelete("skill-own");
    if (first.kind !== "proposed" || second.kind !== "proposed") throw new Error("expected proposals");
    expect(first.card.proposalId).not.toBe(second.card.proposalId);
    expect(first.card.scheduledTasks[0]!.title).toBe(`${"𝔸".repeat(59)}…`);
    expect(decodeResourceChangeCard(JSON.parse(JSON.stringify(first.card)))).toEqual(first.card);
  });
});
