import { describe, expect, it, vi } from "vitest";
import type { SkillSaveCard } from "../../contracts/skillSaves";
import { decodeSkillSaveCard } from "../../contracts/skillSaves";
import type { AcceptedWorkspaceSecret } from "../workspace/secrets/store";
import type { SkillSaveWorkspaceReader } from "../workspace/skillSaveCapture";
import { WorkspaceRuntimeError } from "../workspace/runtime";
import { WORKSPACE_GUIDE_PATHS } from "../workspace/guides";
import { createSkillBundle, parseSkillMarkdown } from "../skills/bundle";
import { skillSaveCardChanges } from "../skills/skillSave";
import {
  executeSaveSkill,
  isSkillSaveCall,
  parseSkillSaveDirectory,
  parseSkillSaveFiles,
  parseSkillSaveTarget,
  skillSavedResult,
  saveSkillTool,
  skillSaveToolsForRequest,
  type SkillSaveCommitter
} from "./skillSave";

const OUTPUT = "/workspace/output/run-1";
const MARKDOWN = "---\nname: gitlab-digest\ndescription: Summarize failed pipelines\n---\nRun digest.py and summarize.\n";
const workspace = { enabled: true, outputDirectory: OUTPUT } as never;
const skills = { version: 2, mode: "auto", tools: "load_and_read",
  pinned: [{ alias: "gitlab-digest", name: "gitlab-digest", revisionId: "rev-3", skillId: "skill-own" }],
  available: [{ alias: "team-report", name: "Team report", revisionId: "rev-shared", skillId: "skill-other", description: "d",
    fileCount: 0, hasExecutables: false, loadedBefore: false }] } as never;
const request = { skillSaveTool: true as const, workspace, skills };
const context = { persistedToolCallId: "call-1", request, runId: "run-1", userId: "user-1" };
const call = (args: Record<string, unknown> = {}) => ({ id: "provider-call", name: "save_skill", arguments: {
  directory: "/workspace/project/gitlab-digest", files: ["SKILL.md", "digest.py"], target: "new", expectedVersion: null,
  changeNote: "First version", ...args } });

function secret(value: AcceptedWorkspaceSecret["value"]): AcceptedWorkspaceSecret {
  return { value } as AcceptedWorkspaceSecret;
}

function reader(files: Record<string, Buffer | null>, secrets: readonly AcceptedWorkspaceSecret[] = []) {
  const read = vi.fn<SkillSaveWorkspaceReader["read"]>(async (input) => input.files.map((file) => {
    const path = `${file.root}/${file.relativePath}`;
    const bytes = files[path];
    if (bytes === undefined) throw new WorkspaceRuntimeError("workspace_capture_source_invalid");
    return { relativePath: path, byteSize: bytes?.length ?? 2_000_000, bytes };
  }));
  const value: SkillSaveWorkspaceReader = { read, secrets: vi.fn(async () => secrets) };
  return { read, reader: async () => value };
}

const savedCard: SkillSaveCard = {
  version: 1, saveId: "save-1", skillId: "skill-new", revisionId: "rev-1", name: "gitlab-digest", outcome: "created",
  fromRevision: null, toRevision: 1, changeNote: "First version", copiedFrom: null, published: false,
  files: [{ path: "SKILL.md", change: "added", executable: false }, { path: "digest.py", change: "added", executable: true }],
  diffs: [], scheduledTasks: [], scheduledTasksTruncated: false
};

function committer(outcome?: Awaited<ReturnType<SkillSaveCommitter>>) {
  return vi.fn<SkillSaveCommitter>(async (input) => outcome ?? { kind: "saved", result: input.result(savedCard, 1) });
}

const folder = {
  "project/gitlab-digest/SKILL.md": Buffer.from(MARKDOWN),
  "project/gitlab-digest/digest.py": Buffer.from("#!/usr/bin/env python3\nimport os\nprint(os.environ['GITLAB_TOKEN'][:0])\n")
};

describe("save_skill admission helpers", () => {
  it("is offered and accepted only with the frozen marker and Workspace", () => {
    expect(skillSaveToolsForRequest(request).map((tool) => tool.name)).toEqual(["save_skill"]);
    expect(skillSaveToolsForRequest({ workspace })).toEqual([]);
    expect(skillSaveToolsForRequest({ skillSaveTool: true })).toEqual([]);
    expect(isSkillSaveCall(request, "save_skill")).toBe(true);
    expect(isSkillSaveCall({ workspace }, "save_skill")).toBe(false);
  });

  it("points the model at the Skill authoring guide before it builds a folder", () => {
    expect(saveSkillTool.description).toContain(`read ${WORKSPACE_GUIDE_PATHS.skills}.`);
  });

  it("accepts project and this run's output folders, never managed copies or escapes", () => {
    expect(parseSkillSaveDirectory("/workspace/project/gitlab-digest/", OUTPUT)).toEqual({ root: "project", prefix: "gitlab-digest", name: "gitlab-digest" });
    expect(parseSkillSaveDirectory("project/a/b", OUTPUT)).toEqual({ root: "project", prefix: "a/b", name: "b" });
    expect(parseSkillSaveDirectory(`${OUTPUT}/draft`, OUTPUT)).toEqual({ root: "output", prefix: "draft", name: "draft" });
    expect(parseSkillSaveDirectory("output/draft", OUTPUT)).toEqual({ root: "output", prefix: "draft", name: "draft" });
    expect(parseSkillSaveDirectory("/workspace/.aiqsa/skills/gitlab-digest", OUTPUT)).toBe("skill_save_directory_managed");
    expect(parseSkillSaveDirectory("project/.aiqsa/skills/x", OUTPUT)).toBe("skill_save_directory_managed");
    for (const value of ["/workspace/output/other-run/draft", "/etc", "project/../secrets", "/workspace/inbox/messages/m",
      "/workspace/tmp/x", "", 3]) {
      expect(parseSkillSaveDirectory(value, OUTPUT), String(value)).toBe("skill_save_directory_invalid");
    }
  });

  it("requires SKILL.md, distinct safe relative paths and at most the capture bound", () => {
    const directory = { root: "project" as const, prefix: "skill", name: "skill" };
    const parsed = parseSkillSaveFiles(["./SKILL.md", "scripts/run.sh"], directory);
    expect(typeof parsed).toBe("object");
    if (typeof parsed === "string") throw new Error(parsed);
    expect([...parsed.names.entries()]).toEqual([["project/skill/SKILL.md", "SKILL.md"], ["project/skill/scripts/run.sh", "scripts/run.sh"]]);
    expect(parseSkillSaveFiles(["run.sh"], directory)).toBe("skill_save_file_invalid");
    expect(parseSkillSaveFiles(["SKILL.md", "../x"], directory)).toBe("skill_save_file_invalid");
    expect(parseSkillSaveFiles(["SKILL.md", "a.txt", "A.txt"], directory)).toBe("skill_save_file_invalid");
    expect(parseSkillSaveFiles(["SKILL.md", ...Array.from({ length: 100 }, (_, index) => `f${index}`)], directory))
      .toBe("skill_save_limit_exceeded");
  });

  it("resolves targets from the frozen catalog first, then ids from earlier results", () => {
    expect(parseSkillSaveTarget(request, "new", null)).toEqual({ kind: "new" });
    expect(parseSkillSaveTarget(request, "gitlab-digest", null)).toEqual({ kind: "frozen", skillId: "skill-own", revisionId: "rev-3" });
    expect(parseSkillSaveTarget(request, "team-report", 7)).toEqual({ kind: "frozen", skillId: "skill-other", revisionId: "rev-shared" });
    expect(parseSkillSaveTarget(request, "skill-own", 4)).toEqual({ kind: "version", skillId: "skill-own", expectedVersion: 4 });
    expect(parseSkillSaveTarget(request, "unknown-alias", null)).toBeNull();
    expect(parseSkillSaveTarget(request, "skill-own", 0)).toBeNull();
  });

  it("turns the same targets into restores with their guards, never of a new Skill", () => {
    expect(parseSkillSaveTarget(request, "gitlab-digest", null, 3))
      .toEqual({ kind: "restore", skillId: "skill-own", guard: { revisionId: "rev-3" }, revision: 3 });
    expect(parseSkillSaveTarget(request, "skill-own", 4, 0))
      .toEqual({ kind: "restore", skillId: "skill-own", guard: { expectedVersion: 4 }, revision: 0 });
    expect(parseSkillSaveTarget(request, "new", null, 2)).toBeNull();
    expect(parseSkillSaveTarget(request, "skill-own", null, 2)).toBeNull();
  });
});

describe("executeSaveSkill restore", () => {
  const restoredCard: SkillSaveCard = { ...savedCard, skillId: "skill-own", revisionId: "rev-5", outcome: "restored", fromRevision: 4,
    toRevision: 5, restoredRevision: 3, changeNote: null,
    files: [{ path: "SKILL.md", change: "changed", executable: false }, { path: "model.bin", change: "unchanged", executable: false, binary: true }] };
  const restoreCall = (args: Record<string, unknown> = {}) => call({ directory: null, files: null, target: "gitlab-digest",
    restoreRevision: 3, changeNote: null, ...args });

  it("restores without reading the Workspace and reports the card's v4 → v5 (= v3)", async () => {
    const { read, reader: load } = reader(folder);
    const commit = vi.fn<SkillSaveCommitter>(async (input) => ({ kind: "saved", result: input.result(restoredCard, 6) }));
    const result = await executeSaveSkill(restoreCall(), context, { reader: load, commit });
    expect(read).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ bundle: null, changeNote: null,
      target: { kind: "restore", skillId: "skill-own", guard: { revisionId: "rev-3" }, revision: 3 } }));
    expect(result.status).toBe("complete");
    expect(result.content[0]).toMatchObject({ value: { saved: true, outcome: "restored", revision: 5, previousRevision: 4, restoredFrom: 3,
      version: 6 } });
    expect(result.artifacts).toEqual([{ type: "artifact", data: { artifactType: "skill_save", payload: restoredCard } }]);
    expect(decodeSkillSaveCard(JSON.parse(JSON.stringify(restoredCard)))).toEqual(restoredCard);
    expect(decodeSkillSaveCard({ ...restoredCard, restoredRevision: undefined })).toBeNull();
    expect(decodeSkillSaveCard({ ...savedCard, restoredRevision: 2 })).toBeNull();
  });

  it("refuses mixed or invalid restore arguments and unknown targets before committing", async () => {
    const commit = committer();
    for (const args of [{ directory: "/workspace/project/gitlab-digest" }, { files: ["SKILL.md"] }, { restoreRevision: -1 },
      { restoreRevision: 1.5 }]) {
      const result = await executeSaveSkill(restoreCall(args), context, { reader: reader(folder).reader, commit });
      expect(result.content[0], JSON.stringify(args)).toMatchObject({ value: { saved: false, error: "skill_restore_arguments_invalid" } });
    }
    for (const target of ["new", "somebody"]) {
      const result = await executeSaveSkill(restoreCall({ target }), context, { reader: reader(folder).reader, commit });
      expect(result.content[0]).toMatchObject({ value: { error: "skill_save_target_unknown" } });
    }
    expect(commit).not.toHaveBeenCalled();
  });

  it("returns the versions to choose from, and explains restore refusals with them", async () => {
    const list = { skillId: "skill-own", name: "gitlab-digest", currentVersion: 4, more: true, versions: [
      { revision: 4, createdAt: "2026-10-07T08:00:00.000Z", current: true, files: 2, changeNote: "Broke it", restoredFrom: null },
      { revision: 3, createdAt: "2026-10-06T08:00:00.000Z", current: false, files: 2, changeNote: null, restoredFrom: 1 }] };
    const listed = await executeSaveSkill(restoreCall({ restoreRevision: 0 }), context, { reader: reader(folder).reader,
      commit: committer({ kind: "not_saved", outcome: { kind: "versions", list } }) });
    expect(listed.status).toBe("complete");
    expect(listed.content[0]).toMatchObject({ value: { saved: false, skillId: "skill-own", currentVersion: 4, versions: [
      { revision: 4, current: true, changeNote: "Broke it" }, { revision: 3, restoredFrom: 1 }], olderVersions: expect.any(String) } });
    for (const code of ["skill_restore_revision_unknown", "skill_restore_conflict"] as const) {
      const result = await executeSaveSkill(restoreCall(), context, { reader: reader(folder).reader,
        commit: committer({ kind: "not_saved", outcome: { kind: "refused", code, versions: list } }) });
      expect(result).toMatchObject({ status: "error", content: [{ value: { saved: false, error: code, currentVersion: 4,
        versions: expect.arrayContaining([expect.objectContaining({ revision: 3 })]) } }] });
    }
    const notOwn = await executeSaveSkill(restoreCall({ target: "team-report" }), context, { reader: reader(folder).reader,
      commit: committer({ kind: "not_saved", outcome: { kind: "refused", code: "skill_restore_not_own" } }) });
    expect(notOwn.content[0]).toMatchObject({ value: { error: "skill_restore_not_own" } });
    const unchanged = await executeSaveSkill(restoreCall(), context, { reader: reader(folder).reader,
      commit: committer({ kind: "not_saved", outcome: { kind: "unchanged", skillId: "skill-own", name: "gitlab-digest", version: 4 } }) });
    expect(unchanged.content[0]).toMatchObject({ value: { unchanged: true, message: expect.stringContaining("already current") } });
  });
});

describe("executeSaveSkill", () => {
  it("captures the folder, builds the bundle with executables and commits it once", async () => {
    const { read, reader: load } = reader(folder);
    const commit = committer();
    const result = await executeSaveSkill(call(), context, { reader: load, commit });
    expect(result.status).toBe("complete");
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ consumerKey: "call-1", maxFileBytes: 1_048_576,
      files: [{ root: "project", relativePath: "gitlab-digest/SKILL.md" }, { root: "project", relativePath: "gitlab-digest/digest.py" }] }));
    const input = commit.mock.calls[0]![0];
    expect(input.target).toEqual({ kind: "new" });
    expect(input.changeNote).toBe("First version");
    expect(input.bundle).toMatchObject({ name: "gitlab-digest", hasExecutables: true, fileCount: 1 });
    expect(input.bundle!.files[0]).toMatchObject({ path: "digest.py", executable: true, kind: "text" });
    expect(result.artifacts).toEqual([{ type: "artifact", data: { artifactType: "skill_save", payload: savedCard } }]);
    expect(result.content[0]).toMatchObject({ value: { saved: true, outcome: "created", skillId: "skill-new", version: 1 } });
  });

  it("is unavailable without the admission marker or a committer", async () => {
    const { read, reader: load } = reader(folder);
    for (const [ctx, commit] of [[{ ...context, request: { ...request, skillSaveTool: undefined } }, committer()],
      [context, undefined]] as const) {
      const result = await executeSaveSkill(call(), ctx as typeof context, { reader: load, ...(commit ? { commit } : {}) });
      expect(result.content[0]).toMatchObject({ value: { saved: false, error: "skill_save_unavailable" } });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses binary and oversized files with the library import pointer", async () => {
    for (const bytes of [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]), Buffer.from([0xff, 0xfe, 0x41]), null]) {
      const commit = committer();
      const result = await executeSaveSkill(call(), context, { reader: reader({ ...folder,
        "project/gitlab-digest/digest.py": bytes }).reader, commit });
      expect(result.content[0]).toMatchObject({ value: { saved: false, error: "skill_save_file_not_text", file: "digest.py" } });
      expect(JSON.stringify(result.content)).toContain("library import");
      expect(commit).not.toHaveBeenCalled();
    }
  });

  it("refuses any delivered secret value by file name without echoing it", async () => {
    const token = "glpat-very-secret-value";
    const cases: Array<readonly [AcceptedWorkspaceSecret, string]> = [
      [secret({ kind: "env", entries: [{ name: "GITLAB_TOKEN", value: token }] }), `TOKEN = "${token}"\n`],
      [secret({ kind: "text", text: `${token}\n` }), `x = '${token}'\n`],
      [secret({ kind: "ssh_key", privateKey: "-----BEGIN KEY-----abc", passphrase: "correct horse battery" }), "pw = correct horse battery\n"],
      [secret({ kind: "file", originalName: "k.bin", base64: Buffer.from([0xc3, 0x28, 1, 2, 3, 4, 5, 6, 7, 8]).toString("base64") }),
        Buffer.from([0x23, 0x20, 0xc3, 0x28, 1, 2, 3, 4, 5, 6, 7, 8]).toString("latin1")]
    ];
    for (const [value, contents] of cases) {
      const commit = committer();
      const result = await executeSaveSkill(call(), context, { reader: reader({ ...folder,
        "project/gitlab-digest/digest.py": Buffer.from(contents, value.value.kind === "file" ? "latin1" : "utf8") }, [value]).reader, commit });
      const error = (result.content[0] as { value: Record<string, unknown> }).value.error;
      // A non-UTF-8 file secret leaves a non-text file, which is refused before the guard.
      expect(["skill_save_secret_detected", "skill_save_file_not_text"]).toContain(error);
      if (value.value.kind !== "file") expect(result.content[0]).toMatchObject({ value: { file: "digest.py" } });
      expect(JSON.stringify(result)).not.toContain(token);
      expect(JSON.stringify(result)).not.toContain("correct horse");
      expect(commit).not.toHaveBeenCalled();
    }
    // Short values are not matched: they would refuse ordinary text.
    const commit = committer();
    await executeSaveSkill(call(), context, { reader: reader(folder, [secret({ kind: "text", text: "os" })]).reader, commit });
    expect(commit).toHaveBeenCalledOnce();
  });

  it("reports invalid Skills, unreadable paths and busy files without saving", async () => {
    const commit = committer();
    const invalid = await executeSaveSkill(call(), context, { reader: reader({ ...folder,
      "project/gitlab-digest/SKILL.md": Buffer.from("no front matter") }).reader, commit });
    expect(invalid.content[0]).toMatchObject({ value: { error: "skill_save_bundle_invalid", problem: "skill_frontmatter_required" } });
    const missing = await executeSaveSkill(call({ files: ["SKILL.md", "gone.py"] }), context, { reader: reader(folder).reader, commit });
    expect(missing.content[0]).toMatchObject({ value: { error: "skill_save_workspace_unavailable" } });
    const busy = await executeSaveSkill(call(), context, { reader: async () => ({ secrets: async () => [],
      read: async () => { throw new WorkspaceRuntimeError("workspace_capture_source_busy"); } }), commit });
    expect(busy.content[0]).toMatchObject({ value: { error: "skill_save_workspace_busy" } });
    const managed = await executeSaveSkill(call({ directory: "/workspace/.aiqsa/skills/gitlab-digest" }), context,
      { reader: reader(folder).reader, commit });
    expect(managed.content[0]).toMatchObject({ value: { error: "skill_save_directory_managed" } });
    const target = await executeSaveSkill(call({ target: "somebody" }), context, { reader: reader(folder).reader, commit });
    expect(target.content[0]).toMatchObject({ value: { error: "skill_save_target_unknown" } });
    expect(commit).not.toHaveBeenCalled();
  });

  it("explains refusals, conflicts and unchanged folders, and replays a settled call", async () => {
    const conflict = await executeSaveSkill(call({ target: "gitlab-digest" }), context, { reader: reader(folder).reader,
      commit: committer({ kind: "not_saved", outcome: { kind: "refused", code: "skill_version_conflict", conflict: {
        skillId: "skill-own", currentVersion: 5, currentRevision: 4, differingFiles: [{ path: "digest.py", content: "print(2)\n" }],
        omittedFiles: [], newFiles: [] } } }) });
    expect(conflict.status).toBe("error");
    expect(conflict.content[0]).toMatchObject({ value: { saved: false, error: "skill_version_conflict", skillId: "skill-own",
      currentVersion: 5, currentFiles: [{ path: "digest.py", content: "print(2)\n" }] } });
    for (const code of ["skill_save_answer_limit", "skill_save_rate_limited", "skill_archived", "skill_not_available"] as const) {
      const result = await executeSaveSkill(call(), context, { reader: reader(folder).reader,
        commit: committer({ kind: "not_saved", outcome: { kind: "refused", code } }) });
      expect(result.content[0]).toMatchObject({ value: { saved: false, error: code } });
    }
    const unchanged = await executeSaveSkill(call(), context, { reader: reader(folder).reader,
      commit: committer({ kind: "not_saved", outcome: { kind: "unchanged", skillId: "skill-own", name: "gitlab-digest", version: 5 } }) });
    expect(unchanged).toMatchObject({ status: "complete", content: [{ value: { saved: false, unchanged: true } }] });
    const prior = skillSavedResult(call(), savedCard, 1);
    expect(await executeSaveSkill(call(), context, { reader: reader(folder).reader,
      commit: committer({ kind: "settled", result: prior }) })).toBe(prior);
    const failed = await executeSaveSkill(call(), context, { reader: reader(folder).reader,
      commit: vi.fn(async () => { throw new Error("database_down"); }) });
    expect(failed.content[0]).toMatchObject({ value: { error: "skill_save_unavailable" } });
  });
});

describe("save card changes", () => {
  const bundle = (markdown: string, files: Record<string, string>) => createSkillBundle(parseSkillMarkdown(Buffer.from(markdown), "x"),
    Object.entries(files).map(([path, text]) => ({ path, bytes: Buffer.from(text) })));
  const revision = (markdown: string, files: Record<string, { text: string | null; executable?: boolean }>) => {
    const built = bundle(markdown, Object.fromEntries(Object.entries(files).map(([path, file]) => [path, file.text ?? "bin"])));
    return { revisionNumber: 3, name: built.name, description: built.description, instructions: built.instructions,
      frontmatterJson: built.frontmatterJson, bundleDigest: built.bundleDigest, files: built.files.map((file) => ({ path: file.path,
        checksum: files[file.path]!.text === null ? "binary" : file.checksum, kind: files[file.path]!.text === null ? "binary" : "text",
        executable: files[file.path]!.executable ?? file.executable, textContent: files[file.path]!.text })) };
  };

  it("lists every file as added for a new Skill", () => {
    const changes = skillSaveCardChanges(bundle(MARKDOWN, { "run.sh": "#!/bin/sh\necho\n" }), null);
    expect(changes.files).toEqual([{ path: "SKILL.md", change: "added", executable: false },
      { path: "run.sh", change: "added", executable: true }]);
    expect(changes.diffs).toEqual([]);
  });

  it("marks added, changed, removed and unchanged files with executable changes and bounded diffs", () => {
    const previous = revision(MARKDOWN, { "keep.txt": { text: "same\n" }, "run.sh": { text: "echo old\n" },
      "gone.md": { text: "old\n" }, "image.bin": { text: null } });
    const next = bundle(MARKDOWN.replace("Run digest.py", "Run digest.py daily"), { "keep.txt": "same\n",
      "run.sh": "#!/bin/sh\necho new\n", "new.txt": "hello\n", "image.bin": "now text\n" });
    const changes = skillSaveCardChanges(next, previous);
    expect(changes.files).toEqual([
      { path: "SKILL.md", change: "changed", executable: false },
      { path: "gone.md", change: "removed", executable: false },
      { path: "image.bin", change: "changed", executable: false },
      { path: "keep.txt", change: "unchanged", executable: false },
      { path: "new.txt", change: "added", executable: false },
      { path: "run.sh", change: "changed", executable: true, executableChanged: true }
    ]);
    expect(changes.diffs.map((diff) => diff.path)).toEqual(["SKILL.md", "run.sh"]);
    expect(changes.diffs[1]!.lines).toEqual([{ kind: "del", text: "echo old" }, { kind: "add", text: "#!/bin/sh" },
      { kind: "add", text: "echo new" }]);
    const card = { ...savedCard, outcome: "updated" as const, fromRevision: 3, toRevision: 4, ...changes };
    expect(decodeSkillSaveCard(JSON.parse(JSON.stringify(card)))).toEqual(card);
  });
});
