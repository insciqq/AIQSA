import { fetchSkillPage } from "@/components/app-shell/skillLibraryStore";
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

/** A Skill the task editor offers to pin: one the owner can load now. */
export type ScheduledTaskSkillOption = Readonly<{
  id: string;
  name: string;
  hasExecutables: boolean;
  owned: boolean;
  ownerDisplayName: string;
}>;

/** Pages of the Skill library read for the picker; together they cover every Skill a run may offer. */
const SKILL_OPTION_PAGES = 4;
const SKILL_OPTION_PAGE_SIZE = 50;

/**
 * The owner's own and shared-to-them Skills a task may pin, by name: not
 * archived and enabled for the owner, as the server's pin check requires.
 */
export async function listScheduledTaskSkillOptions(signal?: AbortSignal): Promise<ScheduledTaskSkillOption[]> {
  const options = new Map<string, ScheduledTaskSkillOption>();
  let cursor: string | undefined;
  for (let page = 0; page < SKILL_OPTION_PAGES; page += 1) {
    signal?.throwIfAborted();
    const result = await fetchSkillPage({ ...(cursor ? { cursor } : {}), limit: SKILL_OPTION_PAGE_SIZE });
    for (const skill of result.skills) {
      if (skill.archived || skill.enabled === false) continue;
      options.set(skill.id, {
        hasExecutables: skill.hasExecutables === true, id: skill.id, name: skill.name, owned: skill.owned,
        ownerDisplayName: skill.ownerDisplayName
      });
    }
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return [...options.values()].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

/** Starts one manual run now; the server answers 409 `scheduled_task_running` while a run is pending. */
export async function runScheduledTaskNow(taskId: string): Promise<ScheduledTask> {
  return taskFrom(await request(`${taskPath(taskId)}/run`, { method: "POST" }));
}
