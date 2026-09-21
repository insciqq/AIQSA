import { describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "../uploads/storage";
import { parseSkillArchive } from "../workspace/skillBundles";
import { createSkillBundle, parseSkillMarkdown } from "./bundle";
import { assembleWorkspaceSkillArchive } from "./workspaceBundles";

function fixture() {
  const binary = Buffer.from([0, 255, 2, 128]);
  const bundle = createSkillBundle({ name: "🙂".repeat(70), description: "", instructions: "Read references/данные.md." }, [
    { path: "assets/value.bin", bytes: binary },
    { path: "references/данные.md", bytes: Buffer.from("Frozen reference 🙂") },
    { path: "scripts/run.sh", bytes: Buffer.from("#!/bin/sh\nprintf 'fixture'\n"), executable: true }
  ]);
  const revision = { ...bundle, id: "revision", skillId: "skill", bundleReady: true,
    files: bundle.files.map(file => ({ ...file, storageKey: file.kind === "binary" ? "synthetic/object" : null })) };
  const storage: StorageAdapter = { putObject: vi.fn(), deleteObject: vi.fn(),
    getObject: vi.fn(async () => ({ body: binary, contentType: "application/octet-stream", storageKey: "synthetic/object" })) };
  return { revision, storage, binary };
}

describe("frozen Workspace Skill archives", () => {
  it("preserves exact binary/text/executable bytes and normalizes only guest legacy frontmatter", async () => {
    const { revision, storage, binary } = fixture();
    const archive = await assembleWorkspaceSkillArchive(revision, storage);
    const entries = parseSkillArchive(archive);
    expect(entries.map(entry => [entry.path, entry.mode])).toEqual([
      ["SKILL.md", 0o644], ["assets/value.bin", 0o644], ["references/данные.md", 0o644], ["scripts/run.sh", 0o755]
    ]);
    expect(Buffer.from(entries[1]!.content)).toEqual(binary);
    expect(Buffer.from(entries[2]!.content).toString()).toBe("Frozen reference 🙂");
    const markdown = parseSkillMarkdown(Buffer.from(entries[0]!.content), "fallback");
    expect([...markdown.name]).toHaveLength(64);
    expect(markdown.description).toBe(revision.name);
    expect(revision.name).toBe("🙂".repeat(70));
    expect(revision.description).toBe("");
    expect(storage.getObject).toHaveBeenCalledOnce();
  });

  it.each(["traversal", "duplicate", "ancestor", "size", "count", "digest", "long-path"])(
    "rejects persisted %s corruption before reading storage", async fault => {
      const { revision, storage } = fixture();
      if (fault === "traversal") revision.files[2]!.path = "../run.sh";
      if (fault === "duplicate") revision.files[2]!.path = "ASSETS/VALUE.bin";
      if (fault === "ancestor") revision.files[2]!.path = "assets";
      if (fault === "size") revision.files[2]!.byteSize = 9 * 1024 * 1024;
      if (fault === "count") revision.fileCount++;
      if (fault === "digest") revision.bundleDigest = "a".repeat(64);
      if (fault === "long-path") revision.files[2]!.path = "🙂".repeat(26);
      await expect(assembleWorkspaceSkillArchive(revision, storage)).rejects.toMatchObject({ code: "workspace_skill_bundle_invalid" });
      expect(storage.getObject).not.toHaveBeenCalled();
    }
  );

  it("detects same-length object corruption and cancellation without returning an archive", async () => {
    const { revision, storage } = fixture();
    vi.mocked(storage.getObject).mockResolvedValueOnce({ body: Buffer.from([0, 255, 2, 129]), contentType: "application/octet-stream", storageKey: "synthetic/object" });
    await expect(assembleWorkspaceSkillArchive(revision, storage)).rejects.toMatchObject({ code: "workspace_skill_bundle_invalid" });
    const controller = new AbortController(); controller.abort(new Error("synthetic_stop"));
    await expect(assembleWorkspaceSkillArchive(revision, storage, controller.signal)).rejects.toThrow("synthetic_stop");
    expect(storage.getObject).toHaveBeenCalledOnce();
  });
});
