import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import type { SkillVersionService } from "./revisionRestore";

type Params<T> = Promise<T> | T;
type SkillContext = { params: Params<{ skillId: string }> };
type RevisionContext = { params: Params<{ skillId: string; revisionId: string }> };

const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const headers = { "cache-control": "private, no-store", vary: "Cookie" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
const notFound = () => json({ error: "skill_not_found" }, 404);
const invalid = () => json({ error: "skill_restore_invalid" }, 400);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function failed(error: unknown, code: string): Response {
  logEvent("service_operation", { subsystem: "configuration", stage: "write", outcome: "failed", code,
    prisma_code: databaseFailureCode(error) });
  return json({ error: "skill_operation_failed" }, 503);
}

/**
 * Owner routes of a Skill's version history: list its versions and restore
 * one as a new current version, guarded by the version the library showed.
 * Missing, deleted and other users' Skills and revisions look alike.
 */
export function createSkillVersionHandlers(deps: Readonly<{
  resolveAuth: RequestAuthResolver;
  service: () => Pick<SkillVersionService, "list" | "restore">;
}>) {
  return {
    async GET_VERSIONS(request: Request, context: SkillContext): Promise<Response> {
      const session = await deps.resolveAuth(request);
      if (!session) return json({ error: "unauthorized" }, 401);
      const { skillId } = await context.params;
      if (!ID.test(skillId)) return notFound();
      const query = new URL(request.url).searchParams;
      const before = query.get("before");
      if ([...query.keys()].some((key) => key !== "before") || query.getAll("before").length > 1 ||
        (before !== null && (!/^[1-9][0-9]{0,8}$/u.test(before)))) return json({ error: "skill_versions_invalid" }, 400);
      try {
        const page = await deps.service().list({ userId: session.userId, skillId, ...(before ? { before: Number(before) } : {}) });
        return page ? json(page) : notFound();
      } catch (error) { return failed(error, "skill_versions_failed"); }
    },
    async POST_RESTORE(request: Request, context: RevisionContext): Promise<Response> {
      const session = await deps.resolveAuth(request);
      if (!session) return json({ error: "unauthorized" }, 401);
      if (session.user.status !== "active") return json({ error: "forbidden" }, 403);
      const { skillId, revisionId } = await context.params;
      if (!ID.test(skillId) || !ID.test(revisionId)) return notFound();
      const body = await readJsonBodyOrNull(request, "json");
      const tooLarge = requestBodyErrorResponse(body);
      if (tooLarge) return tooLarge;
      if (!record(body) || Object.keys(body).some((key) => key !== "expectedVersion") ||
        !Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) return invalid();
      try {
        const result = await deps.service().restore({ userId: session.userId, skillId, revisionId,
          expectedVersion: Number(body.expectedVersion) });
        if (result.kind === "ok") return json(result.response);
        if (result.kind === "conflict") return json({ error: "skill_version_conflict" }, 409);
        if (result.kind === "archived") return json({ error: "skill_archived" }, 409);
        return notFound();
      } catch (error) { return failed(error, "skill_restore_failed"); }
    }
  };
}
