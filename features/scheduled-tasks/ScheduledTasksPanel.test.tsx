import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledTask, ScheduledTaskListResponse } from "@/lib/contracts/scheduledTasks";
import { ScheduledTasksPanel } from "./ScheduledTasksPanel";
import {
  createScheduledTask,
  deleteScheduledTask,
  getScheduledTask,
  listScheduledTasks,
  markScheduledTaskSeen,
  runScheduledTaskNow,
  ScheduledTaskApiError,
  updateScheduledTask
} from "./scheduledTasksApi";
import { scheduledTaskCatalogFixture, scheduledTaskFixture } from "./scheduledTaskFixtures";
import { useScheduledTasksStore } from "./scheduledTasksStore";

vi.mock("./scheduledTasksApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scheduledTasksApi")>();
  return {
    ...actual,
    createScheduledTask: vi.fn(),
    deleteScheduledTask: vi.fn(),
    getScheduledTask: vi.fn(),
    listScheduledTasks: vi.fn(),
    markScheduledTaskSeen: vi.fn(),
    runScheduledTaskNow: vi.fn(),
    updateScheduledTask: vi.fn()
  };
});

const list = vi.mocked(listScheduledTasks);
const create = vi.mocked(createScheduledTask);
const update = vi.mocked(updateScheduledTask);
const remove = vi.mocked(deleteScheduledTask);
const detail = vi.mocked(getScheduledTask);
const run = vi.mocked(runScheduledTaskNow);
const catalog = scheduledTaskCatalogFixture();
let account = 0;

function listed(tasks: ScheduledTask[], emailAvailable = false): ScheduledTaskListResponse {
  return { tasks, limits: { maxActive: 10, maxTotal: 50 }, emailAvailable };
}

function renderPanel(onOpenChat = vi.fn()) {
  account += 1;
  render(<ScheduledTasksPanel accountId={`account-${account}`} catalog={catalog} onOpenChat={onOpenChat} />);
  return { onOpenChat };
}

function expectDirty(value: boolean) {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(value);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date("2026-10-04T10:00:00.000Z") });
  for (const mock of [list, create, update, remove, detail, run]) mock.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("ScheduledTasksPanel", () => {
  it("lists active, running, paused, completed and unread tasks with human status lines", async () => {
    list.mockResolvedValue(listed([
      scheduledTaskFixture({ id: "done", title: "Launch reminder", status: "completed", nextRunAt: null,
        schedule: { kind: "once", date: "2026-10-01", time: "10:00" } }),
      scheduledTaskFixture({ id: "auto", title: "Model check", status: "paused", nextRunAt: null, pauseReason: "model_unavailable",
        schedule: { kind: "daily", time: "08:30" } }),
      scheduledTaskFixture({ id: "live", title: "Market notes", running: true, chatId: "chat-live", unseenResult: true,
        lastRun: { scheduledFor: "2026-10-03T08:00:00.000Z", state: "failed", reasonCode: "chat_busy", finishedAt: "2026-10-03T08:30:00.000Z" } }),
      scheduledTaskFixture({ id: "brief" })
    ]));
    renderPanel();
    const rows = await screen.findAllByRole("listitem");
    expect(rows.map((row) => within(row).getByRole("heading").textContent)).toEqual([
      "Market notesNew result", "Weekday news brief", "Model check", "Launch reminder"
    ]);
    expect(screen.getByText("2 of 10 active")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Running now")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Last run Sat 3 Oct, 09:00 · Failed: the task's chat was busy with another answer")).toBeInTheDocument();
    expect(within(rows[0]!).getByRole("button", { name: "Open chat for Market notes" })).toBeEnabled();
    expect(within(rows[1]!).getByText("Next run Tue 6 Oct, 09:00")).toBeInTheDocument();
    expect(within(rows[1]!).getByRole("switch", { name: "Run Weekday news brief on schedule" })).toHaveAttribute("aria-checked", "true");
    expect(within(rows[2]!).getByText("Paused: the model is no longer available. Edit to choose another model.")).toBeInTheDocument();
    expect(within(rows[2]!).getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(within(rows[3]!).getByText("Completed")).toBeInTheDocument();
    expect(within(rows[3]!).queryByRole("switch")).toBeNull();
    expect(screen.queryByText(/model_unavailable|chat_busy/u)).toBeNull();
  });

  it("keeps a failed load distinct from an empty list and retries", async () => {
    list.mockRejectedValueOnce(new ScheduledTaskApiError("scheduled_tasks_unavailable", 503)).mockResolvedValueOnce(listed([]));
    renderPanel();
    expect(await screen.findByText("Scheduled tasks could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByTestId("scheduled-tasks-empty")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("scheduled-tasks-empty")).toBeInTheDocument();
  });

  it("prefills the sheet from an idea and creates a weekly task after field validation", async () => {
    list.mockResolvedValue(listed([]));
    const created = scheduledTaskFixture({ id: "new", title: "Weekly summary", schedule: { kind: "weekly", time: "17:00", days: ["fri"] } });
    create.mockResolvedValue(created);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Weekly summary every Friday at 17:00" }));
    const sheet = screen.getByRole("dialog", { name: "New scheduled task" });
    expect(within(sheet).getByLabelText("Name")).toHaveValue("Weekly summary");
    expect(within(sheet).getByLabelText("Repeat")).toHaveValue("weekly");
    expect(within(sheet).getByRole("button", { name: "Friday" })).toHaveAttribute("aria-pressed", "true");
    expectDirty(false);
    fireEvent.click(within(sheet).getByRole("button", { name: "Friday" }));
    expectDirty(true);
    expect(within(sheet).getByTestId("scheduled-task-preview")).toHaveTextContent("Choose at least one day to see the next run.");
    fireEvent.click(within(sheet).getByRole("button", { name: "Create task" }));
    expect(within(sheet).getByRole("alert")).toHaveTextContent("Choose at least one day.");
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(within(sheet).getByRole("button", { name: "Friday" }));
    expect(within(sheet).getByTestId("scheduled-task-preview")).toHaveTextContent("Next run: Fri 9 Oct, 17:00");
    fireEvent.click(within(sheet).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      title: "Weekly summary", schedule: { kind: "weekly", time: "17:00", days: ["fri"] }, modelId: "model-a", provider: "provider-a",
      searchEnabled: false, emailNotify: false
    }));
    expect(screen.getByRole("status")).toHaveTextContent("“Weekly summary” is scheduled.");
    expect(screen.getByRole("heading", { name: "Weekly summary" })).toBeInTheDocument();
  });

  it("attaches server codes to their fields and disables Search for a model without it", async () => {
    list.mockResolvedValue(listed([], true));
    create.mockRejectedValueOnce(new ScheduledTaskApiError("scheduled_task_model_unavailable", 400));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    const sheet = screen.getByRole("dialog", { name: "New scheduled task" });
    fireEvent.change(within(sheet).getByLabelText("Name"), { target: { value: "Brief" } });
    fireEvent.change(within(sheet).getByLabelText("Instructions"), { target: { value: "Summarize" } });
    expect(within(sheet).getByRole("switch", { name: "Email me when it runs" })).toBeEnabled();
    fireEvent.click(within(sheet).getByRole("switch", { name: "Web search" }));
    fireEvent.change(within(sheet).getByLabelText("Model"), { target: { value: "provider-a:model-b" } });
    expect(within(sheet).getByRole("switch", { name: "Web search" })).toHaveAttribute("aria-checked", "false");
    expect(within(sheet).getByRole("switch", { name: "Web search" })).toBeDisabled();
    expect(within(sheet).getByText("Not available with this model.")).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "Create task" }));
    const error = await within(sheet).findByText("This model is no longer available to you. Choose another model.");
    expect(within(sheet).getByLabelText("Model")).toHaveAttribute("aria-describedby", error.id);
    expect(within(sheet).getByLabelText("Name")).toHaveValue("Brief");
  });

  it("edits with recent runs, reloads a stale task with a notice and keeps the draft", async () => {
    const task = scheduledTaskFixture({ revision: 2, chatId: "chat-1" });
    list.mockResolvedValue(listed([task]));
    detail.mockResolvedValueOnce({ task, recentRuns: [
      { scheduledFor: "2026-10-02T08:00:00.000Z", trigger: "schedule", state: "completed", reasonCode: null,
        startedAt: "2026-10-02T08:00:05.000Z", finishedAt: "2026-10-02T08:01:00.000Z", chatId: "chat-1" },
      { scheduledFor: "2026-10-01T12:00:00.000Z", trigger: "manual", state: "failed", reasonCode: "model_unavailable",
        startedAt: "2026-10-01T12:00:00.000Z", finishedAt: "2026-10-01T12:00:02.000Z", chatId: "chat-1" }
    ] }).mockResolvedValueOnce({ task: { ...task, revision: 3, title: "Renamed elsewhere" }, recentRuns: [] });
    update.mockRejectedValueOnce(new ScheduledTaskApiError("scheduled_task_stale", 409))
      .mockResolvedValueOnce({ ...task, revision: 4, title: "My brief" });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "More actions for Weekday news brief" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    const sheet = screen.getByRole("dialog", { name: "Edit scheduled task" });
    const runs = await within(sheet).findByRole("region", { name: "Recent runs" });
    expect(within(runs).getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      "Fri 2 Oct, 09:00ScheduledAnswered", "Thu 1 Oct, 13:00Run nowFailed: the model was unavailable"
    ]);
    fireEvent.change(within(sheet).getByLabelText("Name"), { target: { value: "My brief" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save changes" }));
    expect(await within(sheet).findByText(/changed elsewhere/u)).toBeInTheDocument();
    expect(within(sheet).getByLabelText("Name")).toHaveValue("My brief");
    expect(update).toHaveBeenLastCalledWith(task.id, { expectedRevision: 2, title: "My brief" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(update).toHaveBeenLastCalledWith(task.id, { expectedRevision: 3, title: "My brief" });
  });

  it("marks an unread result seen when its editor opens, even for a task without a chat", async () => {
    const failed = { scheduledFor: "2026-10-03T08:00:00.000Z", state: "failed", reasonCode: "model_unavailable",
      finishedAt: "2026-10-03T08:00:02.000Z" } as const;
    const task = scheduledTaskFixture({ chatId: null, unseenResult: true, lastRun: failed });
    list.mockResolvedValue(listed([task]));
    detail.mockResolvedValueOnce({ task, recentRuns: [] });
    const seen = vi.mocked(markScheduledTaskSeen).mockReset().mockResolvedValue();
    renderPanel();
    expect(await screen.findByRole("heading", { name: "Weekday news briefNew result" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "More actions for Weekday news brief" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(seen).toHaveBeenCalledWith(task.id);
    expect(useScheduledTasksStore.getState().tasks[0]?.unseenResult).toBe(false);
    await within(screen.getByRole("dialog", { name: "Edit scheduled task" })).findByText("No runs yet.");
    // The detail read predates the server's clear: it is cleared again, never shown as unread.
    expect(seen).toHaveBeenCalledTimes(2);
    expect(useScheduledTasksStore.getState().tasks[0]?.unseenResult).toBe(false);
  });

  it("pauses, runs now with a conflict message, opens the chat and deletes after naming the consequence", async () => {
    const task = scheduledTaskFixture({ chatId: "chat-1" });
    list.mockResolvedValue(listed([task]));
    update.mockResolvedValueOnce({ ...task, status: "paused", nextRunAt: null, revision: 2 });
    run.mockRejectedValueOnce(new ScheduledTaskApiError("scheduled_task_running", 409));
    remove.mockResolvedValueOnce();
    const { onOpenChat } = renderPanel();
    fireEvent.click(await screen.findByRole("switch", { name: "Run Weekday news brief on schedule" }));
    await waitFor(() => expect(screen.getByText("Paused")).toBeInTheDocument());
    expect(update).toHaveBeenCalledWith(task.id, { expectedRevision: 1, status: "paused" });

    fireEvent.click(screen.getByRole("button", { name: "More actions for Weekday news brief" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Run now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This task is already running.");

    fireEvent.click(screen.getByRole("button", { name: "Open chat for Weekday news brief" }));
    await waitFor(() => expect(onOpenChat).toHaveBeenCalledWith("chat-1"));

    fireEvent.click(screen.getByRole("button", { name: "More actions for Weekday news brief" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    const confirm = screen.getByRole("group", { name: "Delete Weekday news brief" });
    expect(confirm).toHaveTextContent("Its chat and answers stay in your history.");
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete task" }));
    expect(await screen.findByTestId("scheduled-tasks-empty")).toBeInTheDocument();
    expect(remove).toHaveBeenCalledWith(task.id);
  });

  it("disables New task at the active limit with the reason", async () => {
    list.mockResolvedValue({ ...listed(Array.from({ length: 10 }, (_, index) => scheduledTaskFixture({ id: `task-${index}`, title: `Task ${index}` }))) });
    renderPanel();
    const button = await screen.findByRole("button", { name: "New task" });
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveAccessibleDescription("You have 10 active tasks. Pause or delete one to add another.");
  });
});
