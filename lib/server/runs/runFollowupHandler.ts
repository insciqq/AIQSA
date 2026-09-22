import { decodeRunFollowupInput } from "../../contracts/runFollowups";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { notifyProjectEvent } from "../projects/events";
import { notifyRunFollowup } from "./runFollowupRegistry";
import type { RunFollowupOperations } from "./runFollowups";

export function createRunFollowupHandler(deps: {
  resolveAuth: RequestAuthResolver;
  followups: Pick<RunFollowupOperations, "accept">;
  projectIdForChat?(chatId: string): Promise<string | null>;
}) {
  return async function POST(request: Request, context: { params: Promise<{ runId: string }> | { runId: string } }): Promise<Response> {
    const json = (value: unknown, status = 200) => Response.json(value, {
      status, headers: { "cache-control": "private, no-store", vary: "Cookie" }
    });
    const auth = await deps.resolveAuth(request);
    if (!auth) return json({ error: "unauthorized" }, 401);
    if (auth.user.status !== "active") return json({ error: "forbidden" }, 403);
    const body = await readJsonBodyOrNull(request), bodyError = requestBodyErrorResponse(body);
    if (bodyError) return bodyError;
    const input = decodeRunFollowupInput(body);
    const { runId } = await context.params;
    if (!input || !/^[a-zA-Z0-9_-]{1,128}$/u.test(runId)) return json({ error: "followup_invalid" }, 400);
    try {
      const result = await deps.followups.accept({ ...input, runId, userId: auth.userId });
      if (result.kind === "not_found") return json({ error: "model_run_not_found" }, 404);
      if (result.kind === "closed") return json({ error: "followup_closed",
        message: "This task no longer accepts follow-ups. Your text is still in the composer." }, 409);
      if (result.kind === "conflict") return json({ error: "followup_conflict" }, 409);
      if (result.kind === "context_full") return json({ error: "followup_context_full",
        message: "This follow-up exceeds the task's remaining context. Shorten it or send it after the answer finishes." }, 400);
      notifyRunFollowup(runId, result.entry.ordinal);
      const projectId = await deps.projectIdForChat?.(input.chatId).catch(() => null);
      if (projectId) notifyProjectEvent(projectId);
      return json({ followup: result.entry });
    } catch (error) {
      logEvent("service_operation", { subsystem: "run_recovery", stage: "continuation", outcome: "failed",
        code: "followup_accept_failed", prisma_code: databaseFailureCode(error) });
      return json({ error: "followup_accept_failed", message: "The follow-up could not be confirmed. Retry to check the same submission." }, 503);
    }
  };
}
