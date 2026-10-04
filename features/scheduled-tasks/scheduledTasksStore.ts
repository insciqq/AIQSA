import { create } from "zustand";
import {
  SCHEDULED_TASK_MAX_ACTIVE,
  SCHEDULED_TASK_MAX_ACTIVE_HOURLY,
  SCHEDULED_TASK_MAX_TOTAL,
  type ScheduledTask,
  type ScheduledTaskLimits
} from "@/lib/contracts/scheduledTasks";
import { isScheduledTaskNews } from "./scheduledTaskPresentation";
import { listScheduledTasks, ScheduledTaskApiError } from "./scheduledTasksApi";

/**
 * The one browser owner of the signed-in account's scheduled task list. The
 * Studio panel and the background update watcher read and refresh it; every
 * mutation response replaces its task in place.
 */
export type ScheduledTasksState = Readonly<{
  accountId: string | null;
  /**
   * A task whose editor another surface asked to open (the task chat's "Edit
   * task"); the Scheduled panel takes it once its list is ready.
   */
  editRequest: string | null;
  emailAvailable: boolean;
  /** Code of the last failed list read; the previous rows stay visible. */
  error: string | null;
  limits: ScheduledTaskLimits;
  loadState: "idle" | "loading" | "ready" | "error";
  /**
   * Tasks whose newest run finished with an unopened result since the
   * previous list read. `sequence` changes once per read that found any.
   */
  newResults: Readonly<{ sequence: number; tasks: readonly ScheduledTask[] }>;
  tasks: readonly ScheduledTask[];
}>;

const initial: ScheduledTasksState = {
  accountId: null,
  editRequest: null,
  emailAvailable: false,
  error: null,
  limits: { maxActive: SCHEDULED_TASK_MAX_ACTIVE, maxActiveHourly: SCHEDULED_TASK_MAX_ACTIVE_HOURLY, maxTotal: SCHEDULED_TASK_MAX_TOTAL },
  loadState: "idle",
  newResults: { sequence: 0, tasks: [] },
  tasks: []
};

export const useScheduledTasksStore = create<ScheduledTasksState>(() => initial);

let generation = 0;
let inFlight: Promise<boolean> | null = null;

/** Starts a clean list for another account; the same account keeps its rows. */
export function activateScheduledTasksAccount(accountId: string | null): void {
  if (useScheduledTasksStore.getState().accountId === accountId) return;
  generation += 1;
  inFlight = null;
  useScheduledTasksStore.setState({ ...initial, accountId });
}

/**
 * Tasks whose newest settled run is news that arrived since the previous read.
 * `unseenResult` aggregates every run, so an older unread answer never makes a
 * later routine skip or failure look new.
 */
function newlyFinished(previous: readonly ScheduledTask[], next: readonly ScheduledTask[]): ScheduledTask[] {
  const before = new Map(previous.map((task) => [task.id, task]));
  return next.filter((task) => {
    if (!task.unseenResult || !task.lastRun || !isScheduledTaskNews(task)) return false;
    const old = before.get(task.id);
    return !old || !old.unseenResult || old.lastRun?.finishedAt !== task.lastRun.finishedAt;
  });
}

/**
 * Reads the list once; concurrent callers share the request. Resolves false
 * when the read failed or belonged to an account that is no longer active.
 */
export function refreshScheduledTasks(): Promise<boolean> {
  if (inFlight) return inFlight;
  const owner = generation;
  const state = useScheduledTasksStore.getState();
  if (state.loadState !== "ready") useScheduledTasksStore.setState({ loadState: "loading" });
  const request = listScheduledTasks().then((response) => {
    if (owner !== generation) return false;
    const current = useScheduledTasksStore.getState();
    const fresh = current.loadState === "ready" || current.tasks.length > 0
      ? newlyFinished(current.tasks, response.tasks) : [];
    useScheduledTasksStore.setState({
      emailAvailable: response.emailAvailable,
      error: null,
      limits: response.limits,
      loadState: "ready",
      newResults: fresh.length ? { sequence: current.newResults.sequence + 1, tasks: fresh } : current.newResults,
      tasks: response.tasks
    });
    return true;
  }, (error: unknown) => {
    if (owner !== generation) return false;
    const current = useScheduledTasksStore.getState();
    useScheduledTasksStore.setState({
      error: error instanceof ScheduledTaskApiError ? error.code ?? "scheduled_tasks_unavailable" : "scheduled_tasks_unavailable",
      loadState: current.loadState === "ready" ? "ready" : "error"
    });
    return false;
  }).finally(() => {
    if (inFlight === request) inFlight = null;
  });
  inFlight = request;
  return request;
}

/**
 * Reads the list again after a change the browser cannot project itself, such
 * as a task's unread aggregate once some of its results were seen. A read
 * already in flight may predate the change, so this one starts after it.
 */
export function refreshScheduledTasksAfterChange(): Promise<boolean> {
  const owner = generation;
  const pending = inFlight;
  if (!pending) return refreshScheduledTasks();
  return pending.then(() => owner === generation ? refreshScheduledTasks() : false);
}

/** A created or updated task from a mutation response; new tasks lead the list. */
export function applyScheduledTask(task: ScheduledTask): void {
  useScheduledTasksStore.setState((state) => ({
    tasks: state.tasks.some((entry) => entry.id === task.id)
      ? state.tasks.map((entry) => entry.id === task.id ? task : entry)
      : [task, ...state.tasks]
  }));
}

export function removeScheduledTask(taskId: string): void {
  useScheduledTasksStore.setState((state) => ({ tasks: state.tasks.filter((task) => task.id !== taskId) }));
}

/** Asks the Scheduled panel to open this task's editor. */
export function requestScheduledTaskEdit(taskId: string): void {
  useScheduledTasksStore.setState({ editRequest: taskId });
}

/** The pending editor request, cleared so that it opens once. */
export function takeScheduledTaskEditRequest(): string | null {
  const taskId = useScheduledTasksStore.getState().editRequest;
  if (taskId) useScheduledTasksStore.setState({ editRequest: null });
  return taskId;
}
