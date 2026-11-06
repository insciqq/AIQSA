import type { PrismaClient } from "@prisma/client";
import type { AdminBuiltInSkill } from "../../contracts/adminSkills";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";

/**
 * The administrator's installation-wide switch for shipped Skills (operator
 * decision 2026-11-06). Off archives the definition: it leaves every catalog,
 * Studio list and Assistant for everyone, accepted runs keep their revision,
 * and bootstrap never changes it on later upgrades.
 */
export function createBuiltInSkillAdminService(db: PrismaClient) {
  const select = {
    id: true, archivedAt: true, version: true,
    currentRevision: { select: { name: true } },
    _count: { select: { assistantLinks: true } }
  } as const;
  type Row = { id: string; archivedAt: Date | null; version: number;
    currentRevision: { name: string } | null; _count: { assistantLinks: number } };
  const project = (row: Row): AdminBuiltInSkill | null => row.currentRevision ? {
    id: row.id, name: row.currentRevision.name, enabled: row.archivedAt === null, version: row.version, assistantUsageCount: row._count.assistantLinks
  } : null;
  return {
    async list(): Promise<AdminBuiltInSkill[]> {
      const rows = await db.skillDefinition.findMany({
        where: { shippedKey: { not: null }, deletedAt: null }, select, orderBy: { shippedKey: "asc" }
      });
      return rows.flatMap((row) => project(row) ?? []);
    },
    async setEnabled(skillId: string, enabled: boolean, expectedVersion: number):
      Promise<{ kind: "ok"; skill: AdminBuiltInSkill } | { kind: "not_found" | "version_conflict" }> {
      return db.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<Array<{ version: number; archivedAt: Date | null }>>`
          SELECT "version", "archivedAt" FROM "SkillDefinition"
          WHERE "id" = ${skillId} AND "shippedKey" IS NOT NULL AND "deletedAt" IS NULL
          FOR UPDATE`;
        if (!locked) return { kind: "not_found" as const };
        if (locked.version !== expectedVersion) return { kind: "version_conflict" as const };
        const row = (locked.archivedAt === null) === enabled
          ? await tx.skillDefinition.findUniqueOrThrow({ where: { id: skillId }, select })
          : await tx.skillDefinition.update({ where: { id: skillId }, select,
            data: { archivedAt: enabled ? null : new Date(), version: { increment: 1 } } });
        const skill = project(row);
        return skill ? { kind: "ok" as const, skill } : { kind: "not_found" as const };
      });
    }
  };
}
export type BuiltInSkillAdminService = ReturnType<typeof createBuiltInSkillAdminService>;

type Context = { params: Promise<Record<string, string>> | Record<string, string> };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "private, no-store", vary: "Cookie" } });
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);

export function createBuiltInSkillAdminHandlers(deps: { resolveAuth: RequestAuthResolver; service: () => BuiltInSkillAdminService }) {
  async function admin(request: Request) {
    const session = await deps.resolveAuth(request);
    if (!session) return { error: json({ error: "unauthorized" }, 401) };
    if (session.user.status !== "active" || session.user.role !== "admin") return { error: json({ error: "forbidden" }, 403) };
    return { session };
  }
  function failure(error: unknown) {
    logEvent("service_operation", { subsystem: "admin", stage: "write", outcome: "failed", code: "built_in_skill_update_failed",
      prisma_code: databaseFailureCode(error) });
    return json({ error: "built_in_skill_update_failed" }, 503);
  }
  return {
    async list(request: Request) {
      const access = await admin(request);
      if (access.error) return access.error;
      if ([...new URL(request.url).searchParams.keys()].length) return json({ error: "built_in_skill_invalid" }, 400);
      try { return json({ skills: await deps.service().list() }); }
      catch (error) { return failure(error); }
    },
    async update(request: Request, context: Context) {
      const access = await admin(request);
      if (access.error) return access.error;
      const { skillId } = await context.params;
      const body = await readJsonBodyOrNull(request, "json"), bodyError = requestBodyErrorResponse(body);
      if (bodyError) return bodyError;
      if (!identifier(skillId) || !record(body) || Object.keys(body).some((key) => !["enabled", "expectedVersion"].includes(key)) ||
        typeof body.enabled !== "boolean" || !Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
        return json({ error: "built_in_skill_invalid" }, 400);
      }
      try {
        const result = await deps.service().setEnabled(skillId, body.enabled, Number(body.expectedVersion));
        if (result.kind !== "ok") {
          return result.kind === "not_found" ? json({ error: "skill_not_available" }, 404) : json({ error: "skill_version_conflict" }, 409);
        }
        logEvent("service_operation", { subsystem: "admin", stage: "write", outcome: "completed",
          code: body.enabled ? "built_in_skill_enabled" : "built_in_skill_disabled" });
        return json({ skill: result.skill });
      } catch (error) { return failure(error); }
    }
  };
}
