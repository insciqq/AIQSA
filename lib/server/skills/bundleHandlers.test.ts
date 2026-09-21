// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession } from "../auth/requestAuth";
import { createExportSkillsHandler, createImportSkillsHandler, createReadSkillFileHandler, type SkillBundleHandlerDeps } from "./bundleHandlers";
import type { SkillBundleService } from "./bundleService";
import { SkillBundleError } from "./bundleErrors";

const auth = { userId: "owner", user: { id: "owner", role: "user", status: "active", displayName: "Fixture", email: "fixture@example.test" },
  id: "session", expiresAt: new Date(Date.now() + 60_000) } satisfies AuthenticatedSession;
const markdown = "---\nname: test\ndescription: Test procedure\n---\nFollow the procedure.\n";

function deps() {
  const service = {
    importCandidates: vi.fn<SkillBundleService["importCandidates"]>(async (_user, candidates, ignoredFiles) => ({
      ignoredFiles, results: candidates.map((candidate) => candidate.error
        ? { name: candidate.name, outcome: "failed" as const, error: candidate.error }
        : { name: candidate.name, outcome: "created" as const, skillId: "skill" })
    })),
    exportOwned: vi.fn<SkillBundleService["exportOwned"]>(async () => Buffer.from("zip")),
    readFile: vi.fn<SkillBundleService["readFile"]>(async (_user, _skill, path) => ({ path, content: "Text", bytes: 4 }))
  };
  return { service, dependencies: { resolveAuth: vi.fn(async () => auth as AuthenticatedSession | null), service: () => service } satisfies SkillBundleHandlerDeps };
}

describe("Skill bundle HTTP boundary", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("reserves a bounded multipart envelope even when configured overhead is tiny", async () => {
    vi.stubEnv("AIQSA_UPLOAD_MULTIPART_OVERHEAD_BYTES", "1");
    const f = deps();
    await createExportSkillsHandler({ ...f.dependencies, getMaxBytes: () => 100_000 })(new Request("http://localhost/api/me/skills/export"));
    expect(f.service.exportOwned).toHaveBeenCalledWith("owner", undefined, 34_465);
  });
  it("authenticates before consuming an import and accepts a SKILL.md upload without review", async () => {
    const f = deps();
    f.dependencies.resolveAuth.mockResolvedValueOnce(null);
    const request = new Request("http://localhost/api/me/skills/import", { method: "POST", body: "bad" });
    expect((await createImportSkillsHandler(f.dependencies)(request)).status).toBe(401);
    expect(request.bodyUsed).toBe(false);
    const form = new FormData();
    form.append("file", new File([markdown], "SKILL.md", { type: "text/markdown" }));
    const response = await createImportSkillsHandler(f.dependencies)(new Request("http://localhost/api/me/skills/import", { method: "POST", body: form }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ results: [{ outcome: "created", name: "test" }] });
    expect(f.service.importCandidates).toHaveBeenCalledWith("owner", [expect.objectContaining({ bundle: expect.objectContaining({ name: "test" }) })], 0);
  });

  it("uses folder part names as relative paths and rejects malformed fields before persistence", async () => {
    const f = deps();
    const form = new FormData();
    form.append("folder/SKILL.md", new File([markdown], "SKILL.md"));
    form.append("folder/references/a.txt", new File(["Reference"], "a.txt"));
    const handler = createImportSkillsHandler(f.dependencies);
    const response = await handler(new Request("http://localhost/api/me/skills/import", { method: "POST", body: form }));
    expect(response.status).toBe(200);
    expect(f.service.importCandidates).toHaveBeenCalledWith("owner", [expect.objectContaining({ bundle: expect.objectContaining({ fileCount: 1 }) })], 0);
    f.service.importCandidates.mockClear();
    const malicious = new FormData();
    malicious.append("../SKILL.md", new File([markdown], "SKILL.md"));
    const rejected = await handler(new Request("http://localhost/api/me/skills/import", { method: "POST", body: malicious }));
    expect(await rejected.json()).toMatchObject({ error: "skill_path_invalid" });
    expect(f.service.importCandidates).not.toHaveBeenCalled();
  });

  it("returns explicit upload and export limits without leaking internal errors", async () => {
    const f = deps();
    const form = new FormData();
    form.append("file", new File([markdown], "SKILL.md"));
    const limited = createImportSkillsHandler({ ...f.dependencies, getMaxBytes: () => 10 });
    expect(await (await limited(new Request("http://localhost/api/me/skills/import", { method: "POST", body: form }))).json())
      .toMatchObject({ error: "skill_limit_exceeded", field: "uploadBytes", limit: 10 });
    f.service.exportOwned.mockRejectedValueOnce(new SkillBundleError({ code: "skill_limit_exceeded", field: "archiveEntries", actual: 2001, limit: 2000 }));
    const response = await createExportSkillsHandler(f.dependencies)(new Request("http://localhost/api/me/skills/export"));
    expect(await response.json()).toEqual({ error: "skill_limit_exceeded", field: "archiveEntries", actual: 2001, limit: 2000 });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("bounds file selectors and serves only the authorized service projection", async () => {
    const f = deps();
    const handler = createReadSkillFileHandler(f.dependencies);
    const context = { params: { skillId: "skill" } };
    const invalid = await handler(new Request("http://localhost/api/me/skills/skill/files?path=../secret"), context);
    expect(invalid.status).toBe(400);
    expect(f.service.readFile).not.toHaveBeenCalled();
    const valid = await handler(new Request("http://localhost/api/me/skills/skill/files?path=references%2Fa.txt"), context);
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ path: "references/a.txt", content: "Text", bytes: 4 });
  });
});
