import { skillTarPath } from "../../domain/skillBundlePaths";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import type { SkillSaveUndoService } from "./skillSave";

type Params<T> = Promise<T> | T;
type SaveContext = { params: Params<{ skillId: string; saveId: string }> };
type RevisionContext = { params: Params<{ skillId: string; revisionId: string }> };

const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const headers = { "cache-control": "private, no-store", vary: "Cookie" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });

function failed(error: unknown): Response {
  logEvent("service_operation", { subsystem: "configuration", stage: "write", outcome: "failed", code: "skill_save_undo_failed",
    prisma_code: databaseFailureCode(error) });
  return json({ error: "skill_operation_failed" }, 503);
}

/**
 * Owner routes of a chat save's card: its Undo state, Undo itself and the
 * immutable full text of a file of the revision it saved. Every read and
 * write is the signed-in owner's own; others' and missing saves look alike.
 */
export function createSkillSaveHandlers(deps: Readonly<{
  resolveAuth: RequestAuthResolver;
  service: () => Pick<SkillSaveUndoService, "state" | "undo" | "revisionFile">;
}>) {
  async function saveParams(request: Request, context: SaveContext) {
    const session = await deps.resolveAuth(request);
    if (!session) return { response: json({ error: "unauthorized" }, 401) };
    const { skillId, saveId } = await context.params;
    if (!ID.test(skillId) || !ID.test(saveId)) return { response: json({ error: "skill_save_not_found" }, 404) };
    return { session, input: { userId: session.userId, skillId, saveId } };
  }
  return {
    async GET_UNDO(request: Request, context: SaveContext): Promise<Response> {
      const resolved = await saveParams(request, context);
      if (resolved.response) return resolved.response;
      try { return json(await deps.service().state(resolved.input)); } catch (error) { return failed(error); }
    },
    async POST_UNDO(request: Request, context: SaveContext): Promise<Response> {
      const resolved = await saveParams(request, context);
      if (resolved.response) return resolved.response;
      if (resolved.session.user.status !== "active") return json({ error: "forbidden" }, 403);
      try { return json(await deps.service().undo(resolved.input)); } catch (error) { return failed(error); }
    },
    async GET_FILE(request: Request, context: RevisionContext): Promise<Response> {
      const session = await deps.resolveAuth(request);
      if (!session) return json({ error: "unauthorized" }, 401);
      const { skillId, revisionId } = await context.params;
      const query = new URL(request.url).searchParams;
      const path = query.get("path") ?? "";
      if (!ID.test(skillId) || !ID.test(revisionId) || [...query.keys()].some((key) => key !== "path") ||
        query.getAll("path").length !== 1 || !skillTarPath(path)) return json({ error: "skill_path_invalid" }, 400);
      try {
        const file = await deps.service().revisionFile({ userId: session.userId, skillId, revisionId, path });
        return file ? json(file) : json({ error: "skill_file_not_found" }, 404);
      } catch (error) { return failed(error); }
    }
  };
}
