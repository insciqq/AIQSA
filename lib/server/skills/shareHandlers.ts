import { SKILL_REVIEW_NOTE_MAX_LENGTH, SKILL_SHARE_REQUEST_STATES, type SkillShareRequestState } from "../../contracts/skills";
import { skillTarPath } from "../../domain/skillBundlePaths";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { skillDetail } from "./handlers";
import type { PrismaSkillRepository } from "./prismaRepository";
import { SkillSharingError, type SkillSharingService } from "./shareRequests";

export type SkillSharingHandlerDeps = {
  resolveAuth: RequestAuthResolver;
  service: SkillSharingService;
  repository: Pick<PrismaSkillRepository, "getForUser">;
};
type Context = { params: Promise<Record<string, string>> | Record<string, string> };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "private, no-store", vary: "Cookie" } });
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
const invalid = () => json({ error: "skill_share_request_invalid" }, 400);

function failure(error: unknown) {
  if (error instanceof SkillSharingError) return json({ error: error.code }, error.status);
  logEvent("service_operation", { subsystem: "admin", stage: "write", outcome: "failed", code: "skill_sharing_failed", prisma_code: databaseFailureCode(error) });
  return json({ error: "skill_sharing_failed" }, 503);
}

export function createSkillSharingHandlers(deps: SkillSharingHandlerDeps) {
  async function auth(request: Request, admin = false) {
    const session = await deps.resolveAuth(request);
    if (!session) return { error: json({ error: "unauthorized" }, 401) };
    if (session.user.status !== "active" || admin && session.user.role !== "admin") return { error: json({ error: "forbidden" }, 403) };
    return { session };
  }
  async function ownerMutation(request: Request, context: Context, withdraw: boolean) {
    const access = await auth(request);
    if (access.error) return access.error;
    const { skillId } = await context.params;
    if (!identifier(skillId)) return invalid();
    const body = await readJsonBodyOrNull(request, "json");
    const error = requestBodyErrorResponse(body);
    if (error) return error;
    if (!record(body) || Object.keys(body).some((key) => key !== (withdraw ? "requestId" : "expectedVersion")) ||
      (withdraw ? !identifier(body.requestId) : !Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1)) return invalid();
    try {
      if (withdraw) await deps.service.withdraw(access.session.userId, skillId, String(body.requestId));
      else await deps.service.request(access.session.userId, skillId, Number(body.expectedVersion));
      if (access.session.user.role === "admin") logEvent("service_operation", { subsystem: "admin", stage: "write", outcome: "completed", code: withdraw ? "skill_share_request_withdrawn" : "skill_share_request_approved" });
      const entry = await deps.repository.getForUser(access.session.userId, skillId);
      if (!entry) return json({ error: "skill_not_available" }, 404);
      return json({ skill: skillDetail(entry, access.session.user.role === "admin") });
    } catch (error) { return failure(error); }
  }
  return {
    request: (request: Request, context: Context) => ownerMutation(request, context, false),
    withdraw: (request: Request, context: Context) => ownerMutation(request, context, true),
    async list(request: Request) {
      const access = await auth(request, true);
      if (access.error) return access.error;
      const query = new URL(request.url).searchParams;
      if ([...query.keys()].some((key) => !["state", "limit", "cursor"].includes(key)) || ["state", "limit", "cursor"].some((key) => query.getAll(key).length > 1)) return invalid();
      const state = query.get("state") ?? "pending", rawLimit = query.get("limit") ?? "30", limit = Number(rawLimit);
      if (!SKILL_SHARE_REQUEST_STATES.includes(state as SkillShareRequestState) || !/^[1-9][0-9]*$/u.test(rawLimit) || limit > 50) return invalid();
      let cursor: { id: string; createdAt: Date } | undefined;
      if (query.has("cursor")) {
        const raw = query.get("cursor")!;
        if (!raw || raw.length > 512) return invalid();
        try {
          const decoded: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
          if (!record(decoded) || Object.keys(decoded).some((key) => !["id", "createdAt"].includes(key)) || !identifier(decoded.id) || typeof decoded.createdAt !== "string") return invalid();
          const createdAt = new Date(decoded.createdAt);
          if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== decoded.createdAt) return invalid();
          cursor = { id: decoded.id, createdAt };
        } catch { return invalid(); }
      }
      try { return json(await deps.service.list(access.session.userId, { state: state as SkillShareRequestState, limit, cursor })); }
      catch (error) { return failure(error); }
    },
    async detail(request: Request, context: Context) {
      const access = await auth(request, true);
      if (access.error) return access.error;
      const { requestId } = await context.params;
      if (!identifier(requestId)) return invalid();
      try { return json({ request: await deps.service.detail(access.session.userId, requestId) }); }
      catch (error) { return failure(error); }
    },
    async file(request: Request, context: Context) {
      const access = await auth(request, true);
      if (access.error) return access.error;
      const { requestId } = await context.params;
      const query = new URL(request.url).searchParams, path = query.get("path") ?? "";
      if (!identifier(requestId) || [...query.keys()].some((key) => key !== "path") || query.getAll("path").length !== 1 || !skillTarPath(path)) return invalid();
      try { return json(await deps.service.file(access.session.userId, requestId, path)); }
      catch (error) { return failure(error); }
    },
    async decide(request: Request, context: Context) {
      const access = await auth(request, true);
      if (access.error) return access.error;
      const { requestId } = await context.params;
      if (!identifier(requestId)) return invalid();
      const body = await readJsonBodyOrNull(request, "json"), error = requestBodyErrorResponse(body);
      if (error) return error;
      if (!record(body) || Object.keys(body).some((key) => !["action", "note"].includes(key)) ||
        !["approve", "reject"].includes(String(body.action)) || body.note !== undefined &&
        (typeof body.note !== "string" || [...body.note].length > SKILL_REVIEW_NOTE_MAX_LENGTH || /[\u0000\uD800-\uDFFF]/u.test(body.note))) return invalid();
      try {
        const result = await deps.service.decide(access.session.userId, requestId, body.action as "approve" | "reject", typeof body.note === "string" ? body.note.trim() || null : null);
        logEvent("service_operation", { subsystem: "admin", stage: "write", outcome: "completed", code: body.action === "approve" ? "skill_share_request_approved" : "skill_share_request_rejected" });
        return json({ request: result });
      } catch (error) { return failure(error); }
    }
  };
}
