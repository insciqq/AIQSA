import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import type { ScheduledTask, ScheduledTaskListResponse } from "@/lib/contracts/scheduledTasks";
import { listScheduledTasks, markScheduledTaskSeen } from "./scheduledTasksApi";
import { scheduledTaskFixture } from "./scheduledTaskFixtures";
import { activateScheduledTasksAccount, newlyFinishedScheduledTasks } from "./scheduledTasksStore";
import {
  SCHEDULED_TASK_POLL_MS,
  SCHEDULED_TASK_RUNNING_POLL_MS,
  renderedUnseenScheduledRuns,
  scheduledTaskContinuingIn,
  useScheduledTaskUpdates,
  type ScheduledTaskRenderedRun
} from "./useScheduledTaskUpdates";

vi.mock("./scheduledTasksApi", async (importOriginal) => ({
  ...await importOriginal<typeof import("./scheduledTasksApi")>(),
  listScheduledTasks: vi.fn(),
  markScheduledTaskSeen: vi.fn()
}));
vi.mock("@/components/app-shell/chatNavigationActions", () => ({ loadChatNavigation: vi.fn(async () => true) }));

type UpdatesProps = Parameters<typeof useScheduledTaskUpdates>[0];

const list = vi.mocked(listScheduledTasks);
const seen = vi.mocked(markScheduledTaskSeen);
const answered = (finishedAt: string) =>
  ({ scheduledFor: finishedAt, state: "completed", reasonCode: null, finishedAt, unseen: true }) as const;
let account = 0;
let visibility: DocumentVisibilityState = "visible";

function listed(tasks: ScheduledTask[]): ScheduledTaskListResponse {
  return { tasks, limits: { maxActive: 10, maxActiveHourly: 3, maxTotal: 50 }, emailAvailable: false };
}

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

function navigationRow(id: string, updatedAt = "2026-10-03T08:00:00.000Z") {
  return { activeRun: false, assistant: null, folderId: null, id, title: "Brief", updatedAt };
}

function navigationMarker(chatId: string) {
  return useWorkspaceStore.getState().navigationChats.find((chat) => chat.id === chatId)?.scheduledTask;
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

function renderUpdates(props: Partial<UpdatesProps> = {}) {
  account += 1;
  const onNewResult = vi.fn();
  const refreshOpenChat = vi.fn(async () => true);
  const initialProps: UpdatesProps = {
    accountId: `account-${account}`, activeChatId: null, chatVisible: true, onNewResult, refreshOpenChat, renderedUnseenRuns: [], ...props
  };
  const view = renderHook((current: UpdatesProps) => useScheduledTaskUpdates(current), { initialProps });
  return {
    ...view,
    onNewResult,
    refreshOpenChat: initialProps.refreshOpenChat,
    update: (next: Partial<UpdatesProps>) => view.rerender({ ...initialProps, ...next })
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  list.mockReset();
  seen.mockReset().mockResolvedValue();
  activateScheduledTasksAccount(null);
  useWorkspaceStore.setState({ navigationChats: [], navigationSearchChats: [], navigationReady: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("scheduled chat projections", () => {
  it("collects only the unread scheduled turns a transcript renders", () => {
    const marker = (taskRunId: string, unseen: boolean) => ({ scheduledTask: { taskId: "task-1", taskRunId, title: "Brief", unseen } });
    expect(renderedUnseenScheduledRuns([marker("run-1", true), {}, { scheduledTask: null }, marker("run-2", false), marker("run-3", true)]))
      .toEqual([{ taskId: "task-1", taskRunId: "run-1" }, { taskId: "task-1", taskRunId: "run-3" }]);
  });

  it("finds the task that continues in a chat only for its newest same-mode chat", () => {
    const same = scheduledTaskFixture({ id: "same", chatMode: "same", chatId: "chat-1" });
    const fresh = scheduledTaskFixture({ id: "new", chatMode: "new", chatId: "chat-2" });
    expect(scheduledTaskContinuingIn([fresh, same], "chat-1")).toBe(same);
    expect(scheduledTaskContinuingIn([fresh, same], "chat-2")).toBeNull();
    expect(scheduledTaskContinuingIn([fresh, same], "chat-old")).toBeNull();
    expect(scheduledTaskContinuingIn([same], null)).toBeNull();
  });
});

describe("newlyFinishedScheduledTasks", () => {
  // `unseen` is the server's verdict for the newest run; the aggregate follows any unread run.
  const check = (reasonCode: string, finishedAt: string, unseen: boolean, task: Partial<ScheduledTask> = {}) => scheduledTaskFixture({
    kind: "monitoring", chatId: "chat-1", unseenResult: unseen,
    lastRun: { scheduledFor: finishedAt, state: "completed", reasonCode, finishedAt, unseen }, ...task
  });

  it("announces the newest run only when the server marked it unread", () => {
    const previous = [check("update", "2026-10-04T08:01:00.000Z", false)];
    // A check with no update and a repeated source miss are not news.
    expect(newlyFinishedScheduledTasks(previous, [check("no_update", "2026-10-04T09:01:00.000Z", false)])).toEqual([]);
    expect(newlyFinishedScheduledTasks(previous, [check("could_not_check", "2026-10-04T09:01:00.000Z", false)])).toEqual([]);
    // The first miss of a streak alerts: the server marks it unread.
    const alert = check("could_not_check", "2026-10-04T09:01:00.000Z", true);
    expect(newlyFinishedScheduledTasks(previous, [alert])).toEqual([alert]);
    const update = check("update", "2026-10-04T09:01:00.000Z", true);
    expect(newlyFinishedScheduledTasks(previous, [update])).toEqual([update]);
    // A task new to the list counts when its newest run is unread.
    expect(newlyFinishedScheduledTasks([], [update])).toEqual([update]);
  });

  it("follows the newest run's own unread flag while an older result is still unread", () => {
    const previous = [check("update", "2026-10-04T08:01:00.000Z", true)];
    const behindOlder = (reasonCode: string, unseen: boolean) =>
      check(reasonCode, "2026-10-04T09:01:00.000Z", unseen, { unseenResult: true });
    // A source alert is news even though the unread aggregate was already on.
    const alert = behindOlder("could_not_check", true);
    expect(newlyFinishedScheduledTasks(previous, [alert])).toEqual([alert]);
    // A newer check with no update is not, although the task still has an unread result.
    expect(newlyFinishedScheduledTasks(previous, [behindOlder("no_update", false)])).toEqual([]);
    expect(newlyFinishedScheduledTasks(previous, [behindOlder("update", true)])).toHaveLength(1);
    // An unchanged run is never announced twice.
    expect(newlyFinishedScheduledTasks(previous, previous)).toEqual([]);
  });
});

describe("useScheduledTaskUpdates", () => {
  it("reads once and never polls for an account without tasks", async () => {
    list.mockResolvedValue(listed([]));
    renderUpdates();
    await flush();
    expect(list).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(SCHEDULED_TASK_POLL_MS * 3); });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("polls every minute while visible, stops when hidden and catches up when visible again", async () => {
    list.mockResolvedValue(listed([scheduledTaskFixture()]));
    renderUpdates();
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(SCHEDULED_TASK_POLL_MS); });
    expect(list).toHaveBeenCalledTimes(2);
    act(() => setVisibility("hidden"));
    await act(async () => { await vi.advanceTimersByTimeAsync(SCHEDULED_TASK_POLL_MS * 5); });
    expect(list).toHaveBeenCalledTimes(2);
    act(() => setVisibility("visible"));
    await flush();
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("polls faster while a run is in progress", async () => {
    list.mockResolvedValue(listed([scheduledTaskFixture({ running: true })]));
    renderUpdates();
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(SCHEDULED_TASK_RUNNING_POLL_MS); });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("marks the chat row unread and announces a newly finished result once", async () => {
    const before = scheduledTaskFixture({ chatId: "chat-1", running: true });
    const after = scheduledTaskFixture({ chatId: "chat-1", unseenResult: true, lastRun: answered("2026-10-04T08:01:00.000Z") });
    useWorkspaceStore.setState({ navigationChats: [navigationRow("chat-1")] });
    list.mockResolvedValueOnce(listed([before])).mockResolvedValue(listed([after]));
    const { onNewResult } = renderUpdates();
    await flush();
    expect(onNewResult).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(SCHEDULED_TASK_RUNNING_POLL_MS); });
    expect(onNewResult).toHaveBeenCalledTimes(1);
    expect(onNewResult).toHaveBeenCalledWith(after);
    expect(useWorkspaceStore.getState().navigationChats[0]).toMatchObject({
      scheduledTask: { taskId: after.id, unseen: true }, updatedAt: "2026-10-04T08:01:00.000Z"
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(SCHEDULED_TASK_POLL_MS); });
    expect(onNewResult).toHaveBeenCalledTimes(1);
  });

  it("announces a failure that paused the task, never a routine skip or failure behind an older unread answer", async () => {
    // An earlier answer is still unread, so the aggregate stays true across these runs.
    const before = scheduledTaskFixture({ chatId: "chat-1", running: true, unseenResult: true, lastRun: answered("2026-10-03T08:01:00.000Z") });
    const skipped = scheduledTaskFixture({ chatId: "chat-1", unseenResult: true,
      lastRun: { scheduledFor: "2026-10-04T08:00:00.000Z", state: "skipped", reasonCode: "previous_running", finishedAt: "2026-10-04T08:00:01.000Z", unseen: false } });
    const failed = scheduledTaskFixture({ chatId: "chat-1", unseenResult: true,
      lastRun: { scheduledFor: "2026-10-04T09:00:00.000Z", state: "failed", reasonCode: "run_failed", finishedAt: "2026-10-04T09:01:00.000Z", unseen: false } });
    const paused = scheduledTaskFixture({ chatId: "chat-1", unseenResult: true, status: "paused", nextRunAt: null,
      pauseReason: "repeated_failures",
      lastRun: { scheduledFor: "2026-10-04T10:00:00.000Z", state: "failed", reasonCode: "run_failed", finishedAt: "2026-10-04T10:01:00.000Z", unseen: true } });
    useWorkspaceStore.setState({ navigationChats: [navigationRow("chat-1")] });
    list.mockResolvedValueOnce(listed([before])).mockResolvedValueOnce(listed([skipped])).mockResolvedValueOnce(listed([failed]))
      .mockResolvedValue(listed([paused]));
    const { onNewResult } = renderUpdates();
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(SCHEDULED_TASK_RUNNING_POLL_MS); });
    await act(async () => { await vi.advanceTimersByTimeAsync(SCHEDULED_TASK_POLL_MS); });
    expect(onNewResult).not.toHaveBeenCalled();
    expect(navigationMarker("chat-1")).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(SCHEDULED_TASK_POLL_MS); });
    expect(onNewResult).toHaveBeenCalledTimes(1);
    expect(onNewResult).toHaveBeenCalledWith(paused);
    expect(navigationMarker("chat-1")).toEqual({ taskId: paused.id, unseen: true });
  });

  it("keeps each chat's own unread marker when a task's results land in several chats", async () => {
    const first = scheduledTaskFixture({ chatMode: "new", chatId: "chat-1", unseenResult: true, lastRun: answered("2026-10-04T08:01:00.000Z") });
    const second = { ...first, chatId: "chat-2", lastRun: answered("2026-10-05T08:01:00.000Z") };
    useWorkspaceStore.setState({ navigationChats: [navigationRow("chat-1"), navigationRow("chat-2")] });
    list.mockResolvedValueOnce(listed([{ ...first, unseenResult: false, lastRun: null }])).mockResolvedValueOnce(listed([first]))
      .mockResolvedValue(listed([second]));
    const { onNewResult, update } = renderUpdates();
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(SCHEDULED_TASK_POLL_MS); });
    await act(async () => { await vi.advanceTimersByTimeAsync(SCHEDULED_TASK_POLL_MS); });
    expect(onNewResult).toHaveBeenCalledTimes(2);
    expect(navigationMarker("chat-1")).toEqual({ taskId: first.id, unseen: true });
    expect(navigationMarker("chat-2")).toEqual({ taskId: first.id, unseen: true });
    // Opening the newest chat clears only the result it renders.
    update({ activeChatId: "chat-2", renderedUnseenRuns: [{ taskId: first.id, taskRunId: "run-2" }] });
    await flush();
    expect(seen).toHaveBeenCalledWith(first.id, ["run-2"]);
    expect(navigationMarker("chat-2")).toEqual({ taskId: first.id, unseen: false });
    expect(navigationMarker("chat-1")).toEqual({ taskId: first.id, unseen: true });
  });

  it("marks seen only the results the open transcript renders, per task, while the conversation is shown", async () => {
    const task = scheduledTaskFixture({ chatId: "chat-1", unseenResult: true, lastRun: answered("2026-10-04T08:01:00.000Z") });
    useWorkspaceStore.setState({ navigationChats: [{ ...navigationRow("chat-1"), scheduledTask: { taskId: task.id, unseen: true } }] });
    list.mockResolvedValue(listed([task]));
    const rendered: ScheduledTaskRenderedRun[] = [
      { taskId: task.id, taskRunId: "run-1" }, { taskId: task.id, taskRunId: "run-2" }, { taskId: "task-2", taskRunId: "run-9" }
    ];
    const { update } = renderUpdates({ activeChatId: "chat-1", chatVisible: false, renderedUnseenRuns: rendered });
    await flush();
    expect(seen).not.toHaveBeenCalled();
    // The navigation marker alone never marks anything seen.
    update({ activeChatId: "chat-1", chatVisible: true, renderedUnseenRuns: [] });
    await flush();
    expect(seen).not.toHaveBeenCalled();
    update({ activeChatId: "chat-1", chatVisible: true, renderedUnseenRuns: rendered });
    await flush();
    expect(seen.mock.calls).toEqual([[task.id, ["run-1", "run-2"]], ["task-2", ["run-9"]]]);
    expect(navigationMarker("chat-1")).toMatchObject({ unseen: false });
    // The task's aggregate is reread, since other runs may still be unread.
    expect(list.mock.calls.length).toBeGreaterThan(1);
    update({ activeChatId: "chat-1", chatVisible: true, renderedUnseenRuns: [...rendered] });
    await flush();
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("keeps a result unread when marking it failed and tries again on the next render", async () => {
    list.mockResolvedValue(listed([scheduledTaskFixture({ chatId: "chat-1", unseenResult: true })]));
    useWorkspaceStore.setState({ navigationChats: [{ ...navigationRow("chat-1"), scheduledTask: { taskId: "task-1", unseen: true } }] });
    seen.mockRejectedValueOnce(new Error("offline"));
    const rendered = [{ taskId: "task-1", taskRunId: "run-1" }];
    const { update } = renderUpdates({ activeChatId: "chat-1", renderedUnseenRuns: rendered });
    await flush();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(navigationMarker("chat-1")).toEqual({ taskId: "task-1", unseen: true });
    update({ activeChatId: "chat-1", renderedUnseenRuns: [...rendered] });
    await flush();
    expect(seen).toHaveBeenCalledTimes(2);
    expect(navigationMarker("chat-1")).toEqual({ taskId: "task-1", unseen: false });
  });

  it("rereads the open task chat when its run starts and ends; the result is seen once the reread transcript renders it", async () => {
    const idle = scheduledTaskFixture({ chatId: "chat-1" });
    const running = scheduledTaskFixture({ chatId: "chat-1", running: true });
    const finished = scheduledTaskFixture({ chatId: "chat-1", unseenResult: true, lastRun: answered("2026-10-04T08:01:00.000Z") });
    useWorkspaceStore.setState({ navigationChats: [{ ...navigationRow("chat-1"), scheduledTask: { taskId: idle.id, unseen: false } }] });
    list.mockResolvedValueOnce(listed([idle])).mockResolvedValueOnce(listed([running])).mockResolvedValue(listed([finished]));
    const { refreshOpenChat, update } = renderUpdates({ activeChatId: "chat-1" });
    await flush();
    expect(refreshOpenChat).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(SCHEDULED_TASK_POLL_MS); });
    expect(refreshOpenChat).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(SCHEDULED_TASK_RUNNING_POLL_MS); });
    expect(refreshOpenChat).toHaveBeenCalledTimes(2);
    // The cached transcript has not rendered the answer yet.
    expect(seen).not.toHaveBeenCalled();
    update({ activeChatId: "chat-1", renderedUnseenRuns: [{ taskId: finished.id, taskRunId: "run-1" }] });
    await flush();
    expect(seen).toHaveBeenCalledWith(finished.id, ["run-1"]);
  });

  it("rereads the open task chat once when a check ends without news, and announces nothing", async () => {
    const running = scheduledTaskFixture({ chatId: "chat-1", kind: "monitoring", running: true });
    const quiet = scheduledTaskFixture({ chatId: "chat-1", kind: "monitoring",
      lastRun: { scheduledFor: "2026-10-04T08:00:00.000Z", state: "completed", reasonCode: "no_update", finishedAt: "2026-10-04T08:01:00.000Z", unseen: false } });
    useWorkspaceStore.setState({ navigationChats: [navigationRow("chat-1")] });
    list.mockResolvedValueOnce(listed([running])).mockResolvedValue(listed([quiet]));
    const { onNewResult, refreshOpenChat } = renderUpdates({ activeChatId: "chat-1" });
    await flush();
    expect(refreshOpenChat).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(SCHEDULED_TASK_RUNNING_POLL_MS); });
    // The reread carries the check's outcome, so its turn folds away.
    expect(refreshOpenChat).toHaveBeenCalledTimes(2);
    expect(onNewResult).not.toHaveBeenCalled();
    expect(navigationMarker("chat-1")).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(SCHEDULED_TASK_POLL_MS); });
    expect(refreshOpenChat).toHaveBeenCalledTimes(2);
  });

  it("keeps the result unread when the open chat could not be reread", async () => {
    const running = scheduledTaskFixture({ chatId: "chat-1", running: true });
    const finished = scheduledTaskFixture({ chatId: "chat-1", unseenResult: true, lastRun: answered("2026-10-04T08:01:00.000Z") });
    useWorkspaceStore.setState({ navigationChats: [navigationRow("chat-1")] });
    list.mockResolvedValueOnce(listed([running])).mockResolvedValue(listed([finished]));
    renderUpdates({ activeChatId: "chat-1", refreshOpenChat: vi.fn(async () => false) });
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(SCHEDULED_TASK_RUNNING_POLL_MS); });
    await flush();
    expect(seen).not.toHaveBeenCalled();
    expect(navigationMarker("chat-1")).toEqual({ taskId: finished.id, unseen: true });
  });
});
