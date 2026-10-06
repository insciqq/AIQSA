import { describe, expect, it, vi } from "vitest";
import { decodeSkillRestoreResponse, decodeSkillVersionsResponse, type SkillVersionsResponse } from "../../contracts/skillVersions";
import type { AuthenticatedSession } from "../auth/requestAuth";
import type { SkillLibraryRestoreResult } from "./revisionRestore";
import { createSkillVersionHandlers } from "./skillVersionHandlers";

const session = (status = "active") => ({ userId: "user-1", user: { status } }) as unknown as AuthenticatedSession;
const page: SkillVersionsResponse = { skillId: "skill-1", version: 4, archived: false, nextBefore: null, versions: [
  { revisionId: "rev-4", revisionNumber: 4, createdAt: "2026-10-07T08:00:00.000Z", authorDisplayName: "Ada", fileCount: 2, byteSize: 1_200,
    hasExecutables: true, current: true, shared: false, changeNote: "Add commit summaries", restoredFrom: null },
  { revisionId: "rev-3", revisionNumber: 3, createdAt: "2026-10-06T08:00:00.000Z", authorDisplayName: null, fileCount: 1, byteSize: 900,
    hasExecutables: false, current: false, shared: true, changeNote: null, restoredFrom: 1 }
] };

function harness(input: Readonly<{ signedIn?: boolean; status?: string }> = {}) {
  const service = {
    list: vi.fn(async (): Promise<SkillVersionsResponse | null> => page),
    restore: vi.fn(async (): Promise<SkillLibraryRestoreResult> => ({ kind: "ok",
      response: { outcome: "restored", version: 5, revisionNumber: 5, restoredFrom: 3 } }))
  };
  const handlers = createSkillVersionHandlers({ resolveAuth: async () => input.signedIn === false ? null : session(input.status),
    service: () => service });
  return { handlers, service };
}
const skill = (skillId = "skill-1") => ({ params: { skillId } });
const revision = (revisionId = "rev-3", skillId = "skill-1") => ({ params: { skillId, revisionId } });
const post = (body: unknown) => new Request("http://app/api", { method: "POST", headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body) });

describe("Skill version routes", () => {
  it("lists the owner's versions privately and pages by revision number", async () => {
    const { handlers, service } = harness();
    const response = await handlers.GET_VERSIONS(new Request("http://app/api"), skill());
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(decodeSkillVersionsResponse(await response.json())).toEqual(page);
    expect(service.list).toHaveBeenCalledWith({ userId: "user-1", skillId: "skill-1" });
    await handlers.GET_VERSIONS(new Request("http://app/api?before=3"), skill());
    expect(service.list).toHaveBeenLastCalledWith({ userId: "user-1", skillId: "skill-1", before: 3 });
    for (const query of ["?before=0", "?before=x", "?before=1&before=2", "?cursor=1"]) {
      expect((await handlers.GET_VERSIONS(new Request(`http://app/api${query}`), skill())).status, query).toBe(400);
    }
  });

  it("answers missing, deleted and others' Skills alike", async () => {
    const { handlers, service } = harness();
    service.list.mockResolvedValueOnce(null);
    const missing = await handlers.GET_VERSIONS(new Request("http://app/api"), skill());
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "skill_not_found" });
    expect((await handlers.GET_VERSIONS(new Request("http://app/api"), skill("../x"))).status).toBe(404);
    service.restore.mockResolvedValueOnce({ kind: "not_found" });
    const restore = await handlers.POST_RESTORE(post({ expectedVersion: 4 }), revision());
    expect(restore.status).toBe(404);
    expect(await restore.json()).toEqual({ error: "skill_not_found" });
  });

  it("restores with the version the list showed and reports conflicts and archived Skills", async () => {
    const { handlers, service } = harness();
    const response = await handlers.POST_RESTORE(post({ expectedVersion: 4 }), revision());
    expect(decodeSkillRestoreResponse(await response.json())).toEqual({ outcome: "restored", version: 5, revisionNumber: 5, restoredFrom: 3 });
    expect(service.restore).toHaveBeenCalledWith({ userId: "user-1", skillId: "skill-1", revisionId: "rev-3", expectedVersion: 4 });
    service.restore.mockResolvedValueOnce({ kind: "conflict" });
    const conflict = await handlers.POST_RESTORE(post({ expectedVersion: 4 }), revision());
    expect([conflict.status, await conflict.json()]).toEqual([409, { error: "skill_version_conflict" }]);
    service.restore.mockResolvedValueOnce({ kind: "archived" });
    const archived = await handlers.POST_RESTORE(post({ expectedVersion: 4 }), revision());
    expect([archived.status, await archived.json()]).toEqual([409, { error: "skill_archived" }]);
    service.restore.mockResolvedValueOnce({ kind: "ok", response: { outcome: "unchanged", version: 4 } });
    expect(await (await handlers.POST_RESTORE(post({ expectedVersion: 4 }), revision())).json()).toEqual({ outcome: "unchanged", version: 4 });
  });

  it("refuses anonymous, inactive and malformed restores before the service", async () => {
    expect((await harness({ signedIn: false }).handlers.POST_RESTORE(post({ expectedVersion: 1 }), revision())).status).toBe(401);
    expect((await harness({ signedIn: false }).handlers.GET_VERSIONS(new Request("http://app/api"), skill())).status).toBe(401);
    const inactive = harness({ status: "suspended" });
    expect((await inactive.handlers.POST_RESTORE(post({ expectedVersion: 1 }), revision())).status).toBe(403);
    const { handlers, service } = harness();
    for (const body of [{}, { expectedVersion: 0 }, { expectedVersion: "4" }, { expectedVersion: 4, force: true }, "not json", [4]]) {
      expect((await handlers.POST_RESTORE(post(body), revision())).status, JSON.stringify(body)).toBe(400);
    }
    expect((await handlers.POST_RESTORE(post({ expectedVersion: 4 }), revision("rev/3"))).status).toBe(404);
    expect(service.restore).not.toHaveBeenCalled();
    expect(inactive.service.restore).not.toHaveBeenCalled();
  });

  it("fails visibly without leaking database errors", async () => {
    const { handlers, service } = harness();
    service.restore.mockRejectedValueOnce(new Error("connection refused at 10.0.0.1"));
    const response = await handlers.POST_RESTORE(post({ expectedVersion: 4 }), revision());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("10.0.0.1");
  });
});

describe("Skill version wire contract", () => {
  it("rejects malformed pages and restore responses", () => {
    expect(decodeSkillVersionsResponse({ ...page, extra: 1 })).toBeNull();
    expect(decodeSkillVersionsResponse({ ...page, versions: [{ ...page.versions[0], revisionNumber: 0 }] })).toBeNull();
    expect(decodeSkillVersionsResponse({ ...page, versions: [{ ...page.versions[0], restoredFrom: undefined }] })).toBeNull();
    expect(decodeSkillRestoreResponse({ outcome: "restored", version: 5, revisionNumber: 5 })).toBeNull();
    expect(decodeSkillRestoreResponse({ outcome: "unchanged", version: 4, extra: true })).toBeNull();
  });
});
