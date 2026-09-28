import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { SkillSourceImportRequest } from "../../contracts/skillSources";
import { createSkillBundle } from "./bundle";
import { createRemoteSkillImportService } from "./remoteImportService";
import type { fetchRemoteSkillSource } from "./remoteSource";

const url = "https://github.com/example/skills";
const source = { kind: "github" as const, url, revision: "a".repeat(40) };
const fingerprint = "f".repeat(64);
const bundle = createSkillBundle({ name: "test", description: "Synthetic workflow", instructions: "Read the reference." }, [
  { path: "references/a.txt", bytes: Buffer.from("Fixture reference") }
]);
const row = { id: "owned", version: 3, importSourceJson: { ...source, path: "test", bundleDigest: bundle.bundleDigest },
  currentRevision: { name: bundle.name, bundleDigest: bundle.bundleDigest } };
function fixture() {
  const findMany = vi.fn(async () => [] as typeof row[]);
  const db = { skillDefinition: { findMany } } as unknown as PrismaClient;
  const fetchSource = vi.fn<typeof fetchRemoteSkillSource>(async () => ({ source, fingerprint,
    candidates: [{ path: "test", candidate: { name: bundle.name, bundle } }], ignoredFiles: 2 }));
  const importRemoteCandidate = vi.fn(async () => ({ outcome: "created" as const, skillId: "new" }));
  return { findMany, fetchSource, importRemoteCandidate, service: createRemoteSkillImportService(db, { importRemoteCandidate }, fetchSource) };
}
function request(): SkillSourceImportRequest {
  return { url, fingerprint, selections: [{ path: "test", bundleDigest: bundle.bundleDigest, action: { kind: "create" } }] };
}

describe("remote Skill import planning", () => {
  it("projects discovered metadata and only eligible owner matches without retaining remote bytes", async () => {
    const f = fixture();
    f.findMany.mockResolvedValue([row]);
    const preview = await f.service.preview("owner", { url });
    expect(preview).toEqual({ source, fingerprint, ignoredFiles: 2, candidates: [{
      path: "test", name: "test", matches: [{ id: "owned", name: "test", version: 3 }], bundleDigest: bundle.bundleDigest,
      description: bundle.description, fileCount: 1, totalBytes: bundle.bundleByteSize, hasExecutables: false
    }] });
    expect(f.findMany.mock.calls[0]).toMatchObject([{ where: { ownerUserId: "owner", archivedAt: null, deletedAt: null } }]);
    expect(f.importRemoteCandidate).not.toHaveBeenCalled();
  });

  it("authorizes refresh before fetching and marks edits since the last import", async () => {
    const f = fixture();
    await expect(f.service.preview("peer", { url, targetSkillId: "owned" })).rejects.toThrow("skill_not_available");
    expect(f.fetchSource).not.toHaveBeenCalled();
    f.findMany.mockResolvedValue([{ ...row, currentRevision: { name: "edited", bundleDigest: "b".repeat(64) } }]);
    expect((await f.service.preview("owner", { url, targetSkillId: "owned" })).target)
      .toEqual({ id: "owned", name: "edited", version: 3, path: "test", locallyModified: true });
  });

  it("preflights all updates and rejects invisible or stale targets before remote I/O", async () => {
    const f = fixture();
    const input = request();
    input.selections[0]!.action = { kind: "update", skillId: "owned", version: 2 };
    await expect(f.service.importSelected("peer", input)).rejects.toThrow("skill_not_available");
    f.findMany.mockResolvedValue([row]);
    await expect(f.service.importSelected("owner", input)).rejects.toThrow("skill_version_conflict");
    expect(f.fetchSource).not.toHaveBeenCalled();
    expect(f.importRemoteCandidate).not.toHaveBeenCalled();
  });

  it("rejects a changed source or invalid later selection before any import", async () => {
    const f = fixture();
    await expect(f.service.importSelected("owner", { ...request(), fingerprint: "b".repeat(64) })).rejects.toThrow("skill_source_changed");
    const input = request();
    input.selections.push({ path: "missing", bundleDigest: bundle.bundleDigest, action: { kind: "create" } });
    await expect(f.service.importSelected("owner", input)).rejects.toThrow("skill_source_changed");
    input.selections = [{ ...input.selections[0]!, bundleDigest: "d".repeat(64) }];
    await expect(f.service.importSelected("owner", input)).rejects.toThrow("skill_source_changed");
    expect(f.importRemoteCandidate).not.toHaveBeenCalled();
  });

  it("imports refetched bytes with canonical provenance and the explicit action", async () => {
    const f = fixture();
    f.findMany.mockResolvedValue([row]);
    const input = request();
    input.selections[0]!.action = { kind: "update", skillId: "owned", version: 3 };
    expect(await f.service.importSelected("owner", input)).toEqual({ results: [{ name: "test", outcome: "created", skillId: "new" }], ignoredFiles: 2 });
    expect(f.importRemoteCandidate).toHaveBeenCalledExactlyOnceWith("owner", bundle, input.selections[0]!.action,
      { ...source, path: "test", bundleDigest: bundle.bundleDigest });
    f.importRemoteCandidate.mockRejectedValueOnce(new Error("private storage diagnostic"));
    expect((await f.service.importSelected("owner", input)).results[0])
      .toEqual({ name: "test", outcome: "failed", error: { code: "skill_import_failed" } });
  });
});
