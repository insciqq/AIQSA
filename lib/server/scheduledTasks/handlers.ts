import { decodeScheduledTaskSeenRequest, type ScheduledTaskDraft, type ScheduledTaskErrorCode } from "../../contracts/scheduledTasks";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { resolveScheduledTaskModel, type ScheduledTaskCatalogLoader } from "./catalog";
import { firstScheduledTaskRunAt, planScheduledTaskUpdate } from "./mutations";
import { decodeScheduledTaskCreateRequest, decodeScheduledTaskUpdateRequest } from "./requests";
import { ScheduledTaskError, type ScheduledTaskStore } from "./store";

export type ScheduledTaskHandlerDeps = Readonly<{
  /** Wakes the runner after a change that may make an occurrence due. */
  kick?: () => void;
  loadCatalog: ScheduledTaskCatalogLoader;
  now?: () => Date;
  resolveAuth: RequestAuthResolver;
  store: ScheduledTaskStore;
  /** The installation Workspace switch; a task can turn Workspace on only while it is on. */
  workspacePolicy: Readonly<{ read(): Promise<Readonly<{ enabled: boolean }>> }>;
}>;

const headers = { "cache-control": "private, no-store" };
const STATUS: Record<ScheduledTaskErrorCode, number> = {
  scheduled_task_invalid: 400,
  scheduled_task_schedule_invalid: 400,
  scheduled_task_time_zone_invalid: 400,
  scheduled_task_once_in_past: 400,
  scheduled_task_chat_mode_invalid: 400,
  scheduled_task_model_unavailable: 400,
  scheduled_task_search_unavailable: 400,
  scheduled_task_tools_unavailable: 400,
  scheduled_task_workspace_unavailable: 400,
  scheduled_task_limit: 409,
  scheduled_task_hourly_limit: 409,
  scheduled_task_stale: 409,
  scheduled_task_not_found: 404,
  scheduled_task_running: 409,
  scheduled_tasks_unavailable: 503
};
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/u;

function failure(code: ScheduledTaskErrorCode): Response {
  return Response.json({ error: code }, { status: STATUS[code], headers });
}

/** Owner API for `/api/me/scheduled-tasks`. Titles and prompts never reach logs. */
export function createScheduledTaskHandlers(deps: ScheduledTaskHandlerDeps) {
  const now = deps.now ?? (() => new Date());

  async function handle(
    request: Request,
    stage: "read" | "write",
    taskId: string | null,
    operation: (userId: string) => Promise<Response>
  ): Promise<Response> {
    const auth = await deps.resolveAuth(request);
    if (!auth) return Response.json({ error: "unauthorized" }, { status: 401, headers });
    if (auth.user.status !== "active") return Response.json({ error: "forbidden" }, { status: 403, headers });
    if (taskId !== null && !TASK_ID.test(taskId)) return failure("scheduled_task_not_found");
    try {
      return await operation(auth.userId);
    } catch (error) {
      if (error instanceof ScheduledTaskError) return failure(error.code);
      logEvent("service_operation", {
        subsystem: "configuration", stage, outcome: "failed", code: "scheduled_tasks_unavailable", prisma_code: databaseFailureCode(error)
      });
      return failure("scheduled_tasks_unavailable");
    }
  }

  /**
   * The composer's rules for the saved choices: the exact model with Search
   * when asked, tool calling for tools and Workspace, and Workspace turned on
   * for the installation. A Workspace runtime that is only down for now does
   * not refuse a save; a run then retries.
   */
  async function admitModel(userId: string, draft: ScheduledTaskDraft): Promise<void> {
    const admission = resolveScheduledTaskModel(await deps.loadCatalog(userId), draft);
    if (!admission.ok) throw new ScheduledTaskError(admission.code);
    if (draft.workspaceEnabled && !(await deps.workspacePolicy.read()).enabled) {
      throw new ScheduledTaskError("scheduled_task_workspace_unavailable");
    }
  }

  return {
    list: (request: Request) => handle(request, "read", null, async (userId) =>
      Response.json(await deps.store.list(userId), { headers })),

    create: (request: Request) => handle(request, "write", null, async (userId) => {
      const raw = await readJsonBodyOrNull(request);
      const bodyError = requestBodyErrorResponse(raw);
      if (bodyError) return bodyError;
      const decoded = decodeScheduledTaskCreateRequest(raw);
      if (!decoded.ok) return failure(decoded.code);
      const first = firstScheduledTaskRunAt(decoded.value.schedule, decoded.value.timeZone, now());
      if (!first.ok) return failure(first.code);
      await admitModel(userId, decoded.value);
      const task = await deps.store.create(userId, decoded.value, first.nextRunAt);
      deps.kick?.();
      return Response.json({ task }, { status: 201, headers });
    }),

    detail: (request: Request, taskId: string) => handle(request, "read", taskId, async (userId) => {
      const detail = await deps.store.detail(userId, taskId);
      return detail ? Response.json(detail, { headers }) : failure("scheduled_task_not_found");
    }),

    update: (request: Request, taskId: string) => handle(request, "write", taskId, async (userId) => {
      const raw = await readJsonBodyOrNull(request);
      const bodyError = requestBodyErrorResponse(raw);
      if (bodyError) return bodyError;
      const decoded = decodeScheduledTaskUpdateRequest(raw);
      if (!decoded.ok) return failure(decoded.code);
      const current = await deps.store.get(userId, taskId);
      if (!current) return failure("scheduled_task_not_found");
      if (current.revision !== decoded.value.expectedRevision) return failure("scheduled_task_stale");
      const plan = planScheduledTaskUpdate(current, decoded.value, now());
      if (!plan.ok) return failure(plan.code);
      if (plan.checkModel) await admitModel(userId, plan.draft);
      const task = await deps.store.update(userId, taskId, {
        draft: plan.draft, expectedRevision: decoded.value.expectedRevision, nextRunAt: plan.nextRunAt, status: plan.status
      });
      deps.kick?.();
      return Response.json({ task }, { headers });
    }),

    /** Queues a manual run now; the schedule and status stay as they are. */
    runNow: (request: Request, taskId: string) => handle(request, "write", taskId, async (userId) => {
      const task = await deps.store.requestRun(userId, taskId, now());
      deps.kick?.();
      return Response.json({ task }, { headers });
    }),

    remove: (request: Request, taskId: string) => handle(request, "write", taskId, async (userId) =>
      await deps.store.delete(userId, taskId) ? new Response(null, { status: 204, headers }) : failure("scheduled_task_not_found")),

    /** Marks the results the viewer rendered seen, by run id; nothing else becomes seen. */
    markSeen: (request: Request, taskId: string) => handle(request, "write", taskId, async (userId) => {
      const raw = await readJsonBodyOrNull(request);
      const bodyError = requestBodyErrorResponse(raw);
      if (bodyError) return bodyError;
      const decoded = decodeScheduledTaskSeenRequest(raw);
      if (!decoded) return failure("scheduled_task_invalid");
      return await deps.store.markSeen(userId, taskId, decoded.runIds)
        ? new Response(null, { status: 204, headers })
        : failure("scheduled_task_not_found");
    })
  };
}
