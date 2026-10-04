import {
  SCHEDULED_TASK_SEEN_RUNS_LIMIT,
  decodeScheduledTask,
  decodeScheduledTaskDetailResponse,
  decodeScheduledTaskListResponse,
  type ScheduledTask,
  type ScheduledTaskCreateRequest,
  type ScheduledTaskDetailResponse,
  type ScheduledTaskListResponse,
  type ScheduledTaskSeenRequest,
  type ScheduledTaskUpdateRequest
} from "@/lib/contracts/scheduledTasks";

/** A refused or failed request; `code` is the server's stable error code when it sent one. */
export class ScheduledTaskApiError extends Error {
  constructor(readonly code: string | null, readonly status: number) {
    super(code ?? `scheduled_tasks_http_${status}`);
    this.name = "ScheduledTaskApiError";
  }
}

const BASE = "/api/me/scheduled-tasks";

async function request(path: string, init: RequestInit & { json?: unknown } = {}): Promise<unknown> {
  const { json, ...rest } = init;
  const response = await fetch(`${BASE}${path}`, {
    ...rest,
    cache: "no-store",
    credentials: "same-origin",
    ...(json === undefined ? {} : { body: JSON.stringify(json), headers: { "content-type": "application/json" } })
  });
  if (response.status === 204) return null;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body && typeof body === "object" && !Array.isArray(body) &&
      typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : null;
    throw new ScheduledTaskApiError(code, response.status);
  }
  return body;
}

function taskFrom(body: unknown, status = 200): ScheduledTask {
  const task = body && typeof body === "object" && !Array.isArray(body)
    ? decodeScheduledTask((body as { task?: unknown }).task) : null;
  if (!task) throw new ScheduledTaskApiError(null, status);
  return task;
}

function taskPath(taskId: string): string {
  return `/${encodeURIComponent(taskId)}`;
}

export async function listScheduledTasks(signal?: AbortSignal): Promise<ScheduledTaskListResponse> {
  const decoded = decodeScheduledTaskListResponse(await request("", { signal }));
  if (!decoded) throw new ScheduledTaskApiError(null, 200);
  return decoded;
}

export async function getScheduledTask(taskId: string, signal?: AbortSignal): Promise<ScheduledTaskDetailResponse> {
  const decoded = decodeScheduledTaskDetailResponse(await request(taskPath(taskId), { signal }));
  if (!decoded) throw new ScheduledTaskApiError(null, 200);
  return decoded;
}

export async function createScheduledTask(draft: ScheduledTaskCreateRequest): Promise<ScheduledTask> {
  return taskFrom(await request("", { method: "POST", json: draft }), 201);
}

export async function updateScheduledTask(taskId: string, patch: ScheduledTaskUpdateRequest): Promise<ScheduledTask> {
  return taskFrom(await request(taskPath(taskId), { method: "PATCH", json: patch }));
}

export async function deleteScheduledTask(taskId: string): Promise<void> {
  await request(taskPath(taskId), { method: "DELETE" });
}

/**
 * Marks the named results seen, at most `SCHEDULED_TASK_SEEN_RUNS_LIMIT` per
 * request; only results the viewer has rendered belong here.
 */
export async function markScheduledTaskSeen(taskId: string, runIds: readonly string[]): Promise<void> {
  const unique = [...new Set(runIds)];
  for (let start = 0; start < unique.length; start += SCHEDULED_TASK_SEEN_RUNS_LIMIT) {
    const body: ScheduledTaskSeenRequest = { runIds: unique.slice(start, start + SCHEDULED_TASK_SEEN_RUNS_LIMIT) };
    await request(`${taskPath(taskId)}/seen`, { method: "POST", json: body });
  }
}

/** Starts one manual run now; the server answers 409 `scheduled_task_running` while a run is pending. */
export async function runScheduledTaskNow(taskId: string): Promise<ScheduledTask> {
  return taskFrom(await request(`${taskPath(taskId)}/run`, { method: "POST" }));
}
