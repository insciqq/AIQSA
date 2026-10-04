import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledTask, ScheduledTaskCard } from "@/lib/contracts/scheduledTasks";
import { activateScheduledTasksAccount, useScheduledTasksStore } from "@/features/scheduled-tasks/scheduledTasksStore";
import { AnswerOutputsV2 } from "./AnswerOutputsV2";
import { openScheduledTaskEditorV2, ScheduledTaskCardsV2 } from "./ScheduledTaskCardV2";

const card: ScheduledTaskCard = {
  taskId: "task-1", title: "Check mail", kind: "standard",
  schedule: { kind: "weekly", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] }, timeZone: "Europe/Moscow",
  timeZoneFallback: false, toolsEnabled: true, workspaceEnabled: true, status: "active", nextRunAt: "2026-10-05T06:00:00.000Z"
};
const listed: ScheduledTask = {
  id: "task-1", title: "Check mail", prompt: "Remind me to check my mail.", schedule: card.schedule, timeZone: "Europe/Moscow",
  modelId: "model-1", provider: "connection-1", searchEnabled: false, emailNotify: false, toolsEnabled: true, workspaceEnabled: true,
  chatMode: "new", kind: "standard", status: "active", pauseReason: null, completionReason: null,
  nextRunAt: "2026-10-05T06:00:00.000Z", lastRun: null, running: false, chatId: null, unseenResult: false, revision: 1,
  createdAt: "2026-10-04T10:00:00.000Z", updatedAt: "2026-10-04T10:00:00.000Z"
};
const summary = (cards: ScheduledTaskCard[]) => ({ citations: [], reasoningText: [], scheduledTasks: cards, sources: [] });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-04T10:00:00.000Z"));
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    ...new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Moscow" }).resolvedOptions()
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  activateScheduledTasksAccount(null);
});

describe("ScheduledTaskCardsV2", () => {
  it("shows what was created, how often, with which capabilities and when it runs next", () => {
    render(<ScheduledTaskCardsV2 cards={[{ ...card, kind: "monitoring" }]} onEdit={vi.fn()} />);
    const item = screen.getByTestId("scheduled-task-card");
    expect(within(item).getByRole("status")).toHaveTextContent("Scheduled task created");
    expect(item).toHaveTextContent("Check mail");
    expect(item).toHaveTextContent("Every weekday at 09:00 · Monitoring · Tools · Workspace");
    expect(item).toHaveTextContent("Next run Mon 5 Oct, 09:00");
    // The viewer's own zone is not repeated.
    expect(item).not.toHaveTextContent("Europe/Moscow");
    expect(within(item).getByRole("button", { name: "Edit scheduled task Check mail" })).toBeVisible();
    expect(within(item).getByRole("button", { name: "Delete scheduled task Check mail" })).toBeVisible();
  });

  it("names the zone a UTC fallback chose, and states paused, completed and deleted tasks", () => {
    const { rerender } = render(<ScheduledTaskCardsV2 cards={[{ ...card, timeZone: "UTC", timeZoneFallback: true }]} />);
    expect(screen.getByTestId("scheduled-task-card")).toHaveTextContent("Every weekday at 09:00 · UTC · Tools · Workspace");
    // Without an editor only Delete is offered.
    expect(screen.queryByRole("button", { name: /Edit/u })).toBeNull();
    rerender(<ScheduledTaskCardsV2 cards={[{ ...card, nextRunAt: null, status: "paused" }]} />);
    expect(screen.getByTestId("scheduled-task-card")).toHaveTextContent("Paused");
    rerender(<ScheduledTaskCardsV2 cards={[{ ...card, nextRunAt: null, status: "completed" }]} />);
    expect(screen.getByTestId("scheduled-task-card")).toHaveTextContent("Completed");
    rerender(<ScheduledTaskCardsV2 cards={[{ ...card, deleted: true }]} />);
    const deleted = screen.getByTestId("scheduled-task-card");
    expect(within(deleted).getByRole("status")).toHaveTextContent("Scheduled task deleted");
    expect(deleted).not.toHaveTextContent("Next run");
    expect(within(deleted).queryAllByRole("button")).toEqual([]);
  });

  it("opens the task's editor", async () => {
    const onEdit = vi.fn(async () => undefined);
    render(<ScheduledTaskCardsV2 cards={[card]} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit scheduled task Check mail" }));
    await waitFor(() => expect(onEdit).toHaveBeenCalledExactlyOnceWith("task-1"));
  });

  it("deletes only after the inline confirmation, then says so and offers nothing more", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    useScheduledTasksStore.setState({ tasks: [listed] });
    render(<ScheduledTaskCardsV2 cards={[card]} onEdit={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete scheduled task Check mail" }));
    const confirm = screen.getByRole("group", { name: "Delete Check mail" });
    expect(confirm).toHaveTextContent("Delete “Check mail”? Its chats and answers stay in your history.");
    expect(within(confirm).getByRole("button", { name: "Keep task" })).toHaveFocus();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep task" }));
    expect(screen.queryByRole("group")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete scheduled task Check mail" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
    });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/me/scheduled-tasks/task-1",
      expect.objectContaining({ method: "DELETE" }));
    const item = screen.getByTestId("scheduled-task-card");
    await waitFor(() => expect(within(item).getByRole("status")).toHaveTextContent("Scheduled task deleted"));
    expect(within(item).queryAllByRole("button")).toEqual([]);
    expect(useScheduledTasksStore.getState().tasks).toEqual([]);
  });

  it("treats a task already gone as deleted and keeps a failed delete recoverable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "scheduled_task_not_found" }, { status: 404 })));
    render(<ScheduledTaskCardsV2 cards={[card]} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete scheduled task Check mail" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Delete task" })); });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Scheduled task deleted"));
    cleanup();

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "scheduled_tasks_unavailable" }, { status: 503 })));
    render(<ScheduledTaskCardsV2 cards={[card]} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete scheduled task Check mail" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Delete task" })); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Scheduled tasks are unavailable right now. Try again.");
    expect(screen.getByRole("button", { name: "Delete task" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("Scheduled task created");
  });
});

describe("a created task and the account's task list", () => {
  it("asks the ready list to read a task it does not know yet, once", async () => {
    activateScheduledTasksAccount("account-1");
    const fetchMock = vi.fn(async () => Response.json({ tasks: [{ ...listed, id: "task-new" }], emailAvailable: false,
      limits: { maxActive: 10, maxTotal: 50, maxActiveHourly: 3 } }));
    vi.stubGlobal("fetch", fetchMock);
    // Still loading: the list's own read will include the task.
    useScheduledTasksStore.setState({ loadState: "loading", tasks: [] });
    const loading = render(<ScheduledTaskCardsV2 cards={[{ ...card, taskId: "task-new" }]} />);
    loading.unmount();
    expect(fetchMock).not.toHaveBeenCalled();
    useScheduledTasksStore.setState({ loadState: "ready", tasks: [listed] });
    const shown = render(<ScheduledTaskCardsV2 cards={[{ ...card, taskId: "task-new" }, card, { ...card, deleted: true, taskId: "gone" }]} />);
    await waitFor(() => expect(useScheduledTasksStore.getState().tasks.map((task) => task.id)).toEqual(["task-new"]));
    expect(fetchMock).toHaveBeenCalledOnce();
    shown.unmount();
    render(<ScheduledTaskCardsV2 cards={[{ ...card, taskId: "task-new" }]} />);
    useScheduledTasksStore.setState({ tasks: [] });
    render(<ScheduledTaskCardsV2 cards={[{ ...card, taskId: "task-new" }]} />);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("scheduled task cards in an answer", () => {
  it("shows the card while the answer is still running and after it settles", () => {
    const { rerender } = render(<AnswerOutputsV2 artifact={summary([card])} live onEditScheduledTask={vi.fn()} />);
    expect(screen.getByTestId("scheduled-task-card")).toHaveTextContent("Scheduled task created");
    rerender(<AnswerOutputsV2 artifact={summary([card])} onEditScheduledTask={vi.fn()} />);
    expect(screen.getByTestId("scheduled-task-card")).toHaveTextContent("Check mail");
    rerender(<AnswerOutputsV2 artifact={summary([])} />);
    expect(screen.queryByTestId("answer-outputs")).toBeNull();
  });

  it("opens Studio's editor on the task once the account's list knows it", async () => {
    activateScheduledTasksAccount("account-1");
    const fetchMock = vi.fn(async () => Response.json({ tasks: [listed], emailAvailable: false,
      limits: { maxActive: 10, maxTotal: 50, maxActiveHourly: 3 } }));
    vi.stubGlobal("fetch", fetchMock);
    const order: string[] = [];
    await openScheduledTaskEditorV2("task-1", (afterSelect) => {
      order.push(`open:${useScheduledTasksStore.getState().tasks.map((task) => task.id).join(",")}`);
      afterSelect();
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(order).toEqual(["open:task-1"]);
    expect(useScheduledTasksStore.getState().editRequest).toBe("task-1");
  });
});
