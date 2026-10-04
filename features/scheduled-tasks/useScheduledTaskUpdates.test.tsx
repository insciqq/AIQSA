import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import type { ScheduledTask, ScheduledTaskListResponse } from "@/lib/contracts/scheduledTasks";
import { listScheduledTasks, markScheduledTaskSeen } from "./scheduledTasksApi";
import { scheduledTaskFixture } from "./scheduledTaskFixtures";
import { activateScheduledTasksAccount, useScheduledTasksStore } from "./scheduledTasksStore";
import { SCHEDULED_TASK_POLL_MS, SCHEDULED_TASK_RUNNING_POLL_MS, useScheduledTaskUpdates } from "./useScheduledTaskUpdates";

vi.mock("./scheduledTasksApi", async (importOriginal) => ({
  ...await importOriginal<typeof import("./scheduledTasksApi")>(),
  listScheduledTasks: vi.fn(),
  markScheduledTaskSeen: vi.fn()
}));
vi.mock("@/components/app-shell/chatNavigationActions", () => ({ loadChatNavigation: vi.fn(async () => true) }));

const list = vi.mocked(listScheduledTasks);
const seen = vi.mocked(markScheduledTaskSeen);
let account = 0;
let visibility: DocumentVisibilityState = "visible";

function listed(tasks: ScheduledTask[]): ScheduledTaskListResponse {
  return { tasks, limits: { maxActive: 10, maxTotal: 50 }, emailAvailable: false };
}

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

function navigationRow(id: string, updatedAt = "2026-10-03T08:00:00.000Z") {
  return { activeRun: false, assistant: null, folderId: null, id, title: "Brief", updatedAt };
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function renderUpdates(props: Partial<Parameters<typeof useScheduledTaskUpdates>[0]> = {}) {
  account += 1;
  const onNewResult = vi.fn();
  const refreshOpenChat = vi.fn(async () => true);
  const view = renderHook((current: Parameters<typeof useScheduledTaskUpdates>[0]) => useScheduledTaskUpdates(current), {
    initialProps: { accountId: `account-${account}`, activeChatId: null, chatVisible: true, onNewResult, refreshOpenChat, ...props }
  });
  return { ...view, onNewResult, refreshOpenChat: props.refreshOpenChat ?? refreshOpenChat };
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
    const after = scheduledTaskFixture({
      chatId: "chat-1", unseenResult: true,
      lastRun: { scheduledFor: "2026-10-04T08:00:00.000Z", state: "completed", reasonCode: null, finishedAt: "2026-10-04T08:01:00.000Z" }
    });
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

  it("marks a result seen when its chat is open in the conversation, not while Studio covers it", async () => {
    const task = scheduledTaskFixture({ chatId: "chat-1", unseenResult: true,
      lastRun: { scheduledFor: "2026-10-04T08:00:00.000Z", state: "completed", reasonCode: null, finishedAt: "2026-10-04T08:01:00.000Z" } });
    useWorkspaceStore.setState({ navigationChats: [{ ...navigationRow("chat-1"), scheduledTask: { taskId: task.id, unseen: true } }] });
    list.mockResolvedValue(listed([task]));
    const { rerender, onNewResult, refreshOpenChat } = renderUpdates({ activeChatId: "chat-1", chatVisible: false });
    await flush();
    expect(seen).not.toHaveBeenCalled();
    rerender({ accountId: `account-${account}`, activeChatId: "chat-1", chatVisible: true, onNewResult, refreshOpenChat });
    await flush();
    expect(seen).toHaveBeenCalledWith(task.id);
    expect(useScheduledTasksStore.getState().tasks[0]?.unseenResult).toBe(false);
    expect(useWorkspaceStore.getState().navigationChats[0]?.scheduledTask).toEqual({ taskId: task.id, unseen: false });
  });

  it("rereads the open task chat when its run starts and marks the result seen only after the transcript reloads", async () => {
    const idle = scheduledTaskFixture({ chatId: "chat-1" });
    const running = scheduledTaskFixture({ chatId: "chat-1", running: true });
    const finished = scheduledTaskFixture({ chatId: "chat-1", unseenResult: true,
      lastRun: { scheduledFor: "2026-10-04T08:00:00.000Z", state: "completed", reasonCode: null, finishedAt: "2026-10-04T08:01:00.000Z" } });
    useWorkspaceStore.setState({ navigationChats: [{ ...navigationRow("chat-1"), scheduledTask: { taskId: idle.id, unseen: false } }] });
    let release: (loaded: boolean) => void = () => undefined;
    const refreshOpenChat = vi.fn(async () => true);
    list.mockResolvedValueOnce(listed([idle])).mockResolvedValueOnce(listed([running])).mockResolvedValue(listed([finished]));
    renderUpdates({ activeChatId: "chat-1", refreshOpenChat });
    await flush();
    expect(refreshOpenChat).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(SCHEDULED_TASK_POLL_MS); });
    expect(refreshOpenChat).toHaveBeenCalledTimes(1);
    refreshOpenChat.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = resolve; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(SCHEDULED_TASK_RUNNING_POLL_MS); });
    expect(refreshOpenChat).toHaveBeenCalledTimes(2);
    // The cached transcript has not shown the answer yet.
    expect(seen).not.toHaveBeenCalled();
    await act(async () => { release(true); await Promise.resolve(); await Promise.resolve(); });
    expect(seen).toHaveBeenCalledWith(finished.id);
  });

  it("keeps the result unread when the open chat could not be reread", async () => {
    const running = scheduledTaskFixture({ chatId: "chat-1", running: true });
    const finished = scheduledTaskFixture({ chatId: "chat-1", unseenResult: true,
      lastRun: { scheduledFor: "2026-10-04T08:00:00.000Z", state: "completed", reasonCode: null, finishedAt: "2026-10-04T08:01:00.000Z" } });
    useWorkspaceStore.setState({ navigationChats: [navigationRow("chat-1")] });
    list.mockResolvedValueOnce(listed([running])).mockResolvedValue(listed([finished]));
    renderUpdates({ activeChatId: "chat-1", refreshOpenChat: vi.fn(async () => false) });
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(SCHEDULED_TASK_RUNNING_POLL_MS); });
    await flush();
    expect(seen).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().navigationChats[0]?.scheduledTask).toEqual({ taskId: finished.id, unseen: true });
  });
});
