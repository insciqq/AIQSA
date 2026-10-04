import type { ScheduledTaskDraft, ScheduledTaskErrorCode } from "../../contracts/scheduledTasks";
import { resolveScheduledTaskModel, type ScheduledTaskCatalogLoader } from "./catalog";
import { firstScheduledTaskRunAt } from "./mutations";
import { decodeScheduledTaskCreateRequest } from "./requests";
import { ScheduledTaskError } from "./store";

/** What the owner's create and edit rules read besides the draft itself. */
export type ScheduledTaskDraftAdmissionDeps = Readonly<{
  loadCatalog: ScheduledTaskCatalogLoader;
  /** The installation Workspace switch; a task can turn Workspace on only while it is on. */
  workspacePolicy: Readonly<{ read(): Promise<Readonly<{ enabled: boolean }>> }>;
}>;

export type ScheduledTaskCreateAdmission =
  | Readonly<{ ok: true; draft: ScheduledTaskDraft; nextRunAt: Date }>
  | Readonly<{ ok: false; code: ScheduledTaskErrorCode }>;

/**
 * The composer's rules for the saved choices: the exact model with Search
 * when asked, tool calling for tools and Workspace, and Workspace turned on
 * for the installation. A Workspace runtime that is only down for now does
 * not refuse a save; a run then retries. Throws `ScheduledTaskError`.
 */
export async function admitScheduledTaskModel(
  deps: ScheduledTaskDraftAdmissionDeps,
  userId: string,
  draft: ScheduledTaskDraft
): Promise<void> {
  const admission = resolveScheduledTaskModel(await deps.loadCatalog(userId), draft);
  if (!admission.ok) throw new ScheduledTaskError(admission.code);
  if (draft.workspaceEnabled && !(await deps.workspacePolicy.read()).enabled) {
    throw new ScheduledTaskError("scheduled_task_workspace_unavailable");
  }
}

/**
 * Every rule `POST /api/me/scheduled-tasks` applies before the store's limits,
 * in its order: the strict body decoder, the first due instant from `now`,
 * then the model against the owner's current catalog. The chat tool creates
 * through the same rules, so neither path can admit what the other refuses.
 */
export async function admitScheduledTaskCreate(
  deps: ScheduledTaskDraftAdmissionDeps,
  userId: string,
  body: unknown,
  now: Date
): Promise<ScheduledTaskCreateAdmission> {
  const decoded = decodeScheduledTaskCreateRequest(body);
  if (!decoded.ok) return decoded;
  const first = firstScheduledTaskRunAt(decoded.value.schedule, decoded.value.timeZone, now);
  if (!first.ok) return first;
  try {
    await admitScheduledTaskModel(deps, userId, decoded.value);
  } catch (error) {
    if (error instanceof ScheduledTaskError) return { ok: false, code: error.code };
    throw error;
  }
  return { ok: true, draft: decoded.value, nextRunAt: first.nextRunAt };
}
