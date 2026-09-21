import type { AdminSkillShareDecision, AdminSkillShareRequestDetail, AdminSkillShareRequestListResponse } from "@/lib/contracts/adminSkills";
import { SKILL_SHARE_REQUEST_STATES, type SkillShareRequestState } from "@/lib/contracts/skills";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function revision(value: unknown): boolean {
  return record(value) && typeof value.id === "string" && typeof value.name === "string" &&
    Number.isSafeInteger(value.revisionNumber) && Number(value.revisionNumber) > 0 && typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt));
}
function requestSummary(value: unknown): boolean {
  return record(value) && ["id", "skillId", "name", "ownerDisplayName", "revisionId", "createdAt"].every(key => typeof value[key] === "string") &&
    Number.isSafeInteger(value.revisionNumber) && Number(value.revisionNumber) > 0 &&
    Number.isFinite(Date.parse(String(value.createdAt))) &&
    SKILL_SHARE_REQUEST_STATES.includes(value.state as SkillShareRequestState) && typeof value.canReview === "boolean" &&
    (value.reviewedAt === null || (typeof value.reviewedAt === "string" && Number.isFinite(Date.parse(value.reviewedAt)))) &&
    (value.reviewNote === null || typeof value.reviewNote === "string");
}
function file(value: unknown): boolean {
  return record(value) && typeof value.path === "string" && Number.isSafeInteger(value.byteSize) && Number(value.byteSize) >= 0 &&
    (value.kind === "text" || value.kind === "binary") && typeof value.executable === "boolean";
}
function detail(value: unknown): value is AdminSkillShareRequestDetail {
  return record(value) && requestSummary(value) && (value.currentRevision === null || revision(value.currentRevision)) &&
    (value.sharedRevision === null || revision(value.sharedRevision)) && revision(value.requestedRevision) && record(value.requestedRevision) &&
    typeof value.requestedRevision.instructions === "string" && typeof value.requestedRevision.skillMarkdown === "string" &&
    typeof value.requestedRevision.description === "string" && Array.isArray(value.requestedRevision.files) && value.requestedRevision.files.every(file) &&
    record(value.requestedRevision.bundle) && Number.isSafeInteger(value.requestedRevision.bundle.fileCount) &&
    Number(value.requestedRevision.bundle.fileCount) >= 0 && Number.isSafeInteger(value.requestedRevision.bundle.totalBytes) &&
    Number(value.requestedRevision.bundle.totalBytes) >= 0 && typeof value.requestedRevision.bundle.hasExecutables === "boolean" &&
    Array.isArray(value.audiences) && value.audiences.every(item => record(item) && typeof item.id === "string" && typeof item.name === "string") &&
    record(value.diff) && typeof value.diff.skillMarkdownChanged === "boolean" && Array.isArray(value.diff.files) &&
    value.diff.files.every(item => file(item) && record(item) && ["added", "removed", "changed"].includes(String(item.change)) &&
      (item.previousExecutable === undefined || typeof item.previousExecutable === "boolean"));
}
async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`/api/admin/skills/requests${path}`, init);
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(record(value) && typeof value.error === "string" ? value.error : "admin_skills_request_failed");
  return value;
}
export async function loadAdminSkillRequests(state: SkillShareRequestState, cursor?: string, signal?: AbortSignal): Promise<AdminSkillShareRequestListResponse> {
  const query = new URLSearchParams({ state, limit: "30", ...(cursor ? { cursor } : {}) });
  const value = await request(`?${query}`, { signal });
  if (!record(value) || !Array.isArray(value.requests) || !value.requests.every(requestSummary) ||
    (value.nextCursor !== null && typeof value.nextCursor !== "string") || !Number.isSafeInteger(value.pendingCount) || Number(value.pendingCount) < 0) {
    throw new Error("admin_skills_response_invalid");
  }
  return { requests: value.requests as AdminSkillShareRequestListResponse["requests"], nextCursor: value.nextCursor,
    pendingCount: Number(value.pendingCount) };
}
export async function loadAdminSkillRequest(id: string, signal?: AbortSignal): Promise<AdminSkillShareRequestDetail> {
  const value = await request(`/${encodeURIComponent(id)}`, { signal });
  if (!record(value) || !detail(value.request)) throw new Error("admin_skills_response_invalid");
  return value.request;
}
export async function decideAdminSkillRequest(id: string, decision: AdminSkillShareDecision): Promise<AdminSkillShareRequestDetail> {
  const value = await request(`/${encodeURIComponent(id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(decision) });
  if (!record(value) || !detail(value.request)) throw new Error("admin_skills_response_invalid");
  return value.request;
}
export async function loadAdminSkillFile(id: string, path: string, signal?: AbortSignal): Promise<string> {
  const value = await request(`/${encodeURIComponent(id)}/files?${new URLSearchParams({ path })}`, { signal });
  if (!record(value) || value.path !== path || typeof value.content !== "string") throw new Error("admin_skills_response_invalid");
  return value.content;
}
