import { describe, expect, it, vi } from "vitest";
import type { AdminSkillShareRequestDetail } from "../../contracts/adminSkills";
import { SKILL_REVIEW_NOTE_MAX_LENGTH } from "../../contracts/skills";
import type { AuthenticatedSession } from "../auth/requestAuth";
import { logEvent } from "../observability";
import { createSkillSharingHandlers } from "./shareHandlers";
import { SkillSharingError, skillFileDiff } from "./shareRequests";
import type { SkillDetailEntry } from "./prismaRepository";

vi.mock("../observability", () => ({ logEvent: vi.fn() }));
const timestamp = new Date("2026-09-21T00:00:00Z");
const revision = { id: "revision-1", name: "Workflow", revisionNumber: 1, createdAt: timestamp.toISOString() };
const requestSummary = { id: "request-1", revisionId: "revision-1", revisionNumber: 1, state: "pending" as const,
  createdAt: timestamp.toISOString(), reviewedAt: null, reviewNote: null };
const detail: AdminSkillShareRequestDetail = { ...requestSummary, skillId: "skill-1", name: "Workflow", ownerDisplayName: "Owner", canReview: true,
  audiences: [], currentRevision: revision, sharedRevision: null,
  requestedRevision: { ...revision, description: "Procedure", instructions: "Review carefully", skillMarkdown: "# Procedure",
    files: [], bundle: { fileCount: 0, totalBytes: 16, hasExecutables: false } },
  diff: { skillMarkdownChanged: true, files: [] } };
const skill: SkillDetailEntry = { archived: false, description: "Procedure", id: "skill-1", installationScope: false,
  instructionCharacterCount: 16, memberWorkspaceNames: [], name: "Workflow", owned: true, ownerDisplayName: "Owner", updatedAt: timestamp, version: 2,
  assistantUsageCount: 0, audiences: [], workspaceUsageCount: 0,
  revision: { ...revision, createdAt: timestamp, description: "Procedure", instructions: "Review carefully", skillId: "skill-1" },
  sharing: { currentRevision: revision, sharedRevision: null, request: requestSummary, canRequest: true, canWithdraw: true } };

function fixture(role: string | null = "admin") {
  const session: AuthenticatedSession | null = role ? { id: "session", userId: "actor", expiresAt: timestamp,
    user: { id: "actor", displayName: "Actor", email: null, role, status: "active" } } : null;
  const service = {
    request: vi.fn(async () => {}), withdraw: vi.fn(async () => {}),
    list: vi.fn(async () => ({ requests: [detail], pendingCount: 1, nextCursor: null })),
    detail: vi.fn(async () => detail), file: vi.fn(async () => ({ path: "reference.txt", content: "Synthetic content", bytes: 17 })),
    decide: vi.fn(async () => ({ ...detail, state: "approved" as const, canReview: false }))
  };
  const repository = { getForUser: vi.fn(async () => skill) };
  return { service, repository, handlers: createSkillSharingHandlers({ service, repository, resolveAuth: async () => session }) };
}
const context = { params: { requestId: "request-1", skillId: "skill-1" } };
const request = (body?: unknown, method = "POST", query = "") => new Request(`http://localhost/api/admin/skills/requests${query}`, {
  method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
});

describe("Skill approval HTTP boundary", () => {
  it.each(["list", "detail", "file", "decide"] as const)("denies non-admin %s before reading any review data", async (method) => {
    const f = fixture("user");
    expect((await f.handlers[method](request(), context)).status).toBe(403);
    expect(f.service[method]).not.toHaveBeenCalled();
  });
  it("requires authentication for owner requests", async () => {
    const f = fixture(null);
    expect((await f.handlers.request(request({ expectedVersion: 2 }), context)).status).toBe(401);
    expect(f.service.request).not.toHaveBeenCalled();
  });
  it("returns the owner's updated Sharing status with private cache headers", async () => {
    const f = fixture("user");
    const response = await f.handlers.request(request({ expectedVersion: 2 }), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(f.service.request).toHaveBeenCalledWith("actor", "skill-1", 2);
    expect(await response.json()).toMatchObject({ skill: { sharing: { request: { id: "request-1", state: "pending" } } } });
  });
  it("withdraws the exact request and returns stale decisions as a conflict", async () => {
    const f = fixture("user");
    f.service.withdraw.mockRejectedValueOnce(new SkillSharingError("skill_share_request_conflict"));
    const response = await f.handlers.withdraw(request({ requestId: "old-request" }, "DELETE"), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "skill_share_request_conflict" });
    expect(f.service.withdraw).toHaveBeenCalledWith("actor", "skill-1", "old-request");
    expect(f.repository.getForUser).not.toHaveBeenCalled();
  });
  it("bounds notes and rejects unknown mutation fields", async () => {
    const f = fixture();
    expect((await f.handlers.decide(request({ action: "approve", note: "a".repeat(SKILL_REVIEW_NOTE_MAX_LENGTH + 1) }), context)).status).toBe(400);
    expect((await f.handlers.decide(request({ action: "approve", revisionId: "other" }), context)).status).toBe(400);
    expect((await f.handlers.request(request({ expectedVersion: 2, skillId: "other" }), context)).status).toBe(400);
    expect(f.service.decide).not.toHaveBeenCalled();
    expect(f.service.request).not.toHaveBeenCalled();
  });
  it("returns the frozen request and records only content-free decision evidence", async () => {
    vi.mocked(logEvent).mockClear();
    const f = fixture();
    const response = await f.handlers.decide(request({ action: "approve", note: "Private review note" }), context);
    expect(response.status).toBe(200);
    expect(f.service.decide).toHaveBeenCalledWith("actor", "request-1", "approve", "Private review note");
    expect(await response.json()).toMatchObject({ request: { state: "approved", revisionId: "revision-1" } });
    expect(logEvent).toHaveBeenCalledWith("service_operation", { subsystem: "admin", stage: "write", outcome: "completed", code: "skill_share_request_approved" });
    expect(JSON.stringify(vi.mocked(logEvent).mock.calls)).not.toMatch(/Private review note|Workflow|request-1|actor/);
  });
  it("validates queue pagination and file paths before repository reads", async () => {
    const f = fixture();
    expect((await f.handlers.list(request(undefined, "GET", "?limit=51"))).status).toBe(400);
    expect((await f.handlers.list(request(undefined, "GET", "?cursor=invalid"))).status).toBe(400);
    expect((await f.handlers.file(request(undefined, "GET", "?path=../secret"), context)).status).toBe(400);
    expect(f.service.list).not.toHaveBeenCalled();
    expect(f.service.file).not.toHaveBeenCalled();
    expect((await f.handlers.list(request(undefined, "GET", "?state=rejected&limit=10"))).status).toBe(200);
    expect(f.service.list).toHaveBeenCalledWith("actor", { state: "rejected", limit: 10, cursor: undefined });
  });
});

describe("Skill review file differences", () => {
  it("includes executable-bit-only changes even when bytes are identical", () => {
    const file = { path: "scripts/run", checksum: "a".repeat(64), byteSize: 4, kind: "text", executable: false };
    expect(skillFileDiff([file], [{ ...file, executable: true }])).toEqual([
      { path: file.path, byteSize: 4, kind: "text", executable: true, previousExecutable: false, change: "changed" }
    ]);
  });
  it("reports added and removed metadata without exposing storage or text", () => {
    const file = { path: "old.txt", checksum: "a".repeat(64), byteSize: 4, kind: "text", executable: false };
    expect(skillFileDiff([file], [{ ...file, path: "new.txt" }])).toEqual([
      { path: "new.txt", byteSize: 4, kind: "text", executable: false, change: "added" },
      { path: "old.txt", byteSize: 4, kind: "text", executable: false, previousExecutable: false, change: "removed" }
    ]);
  });
});
