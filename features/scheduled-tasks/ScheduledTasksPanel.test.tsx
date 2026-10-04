import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledTask, ScheduledTaskListResponse, ScheduledTaskRun } from "@/lib/contracts/scheduledTasks";
import { ScheduledTasksPanel } from "./ScheduledTasksPanel";
import type { ScheduledTaskWorkspaceAvailability } from "./scheduledTaskDraft";
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
import { requestScheduledTaskEdit, useScheduledTasksStore } from "./scheduledTasksStore";

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
  return { tasks, limits: { maxActive: 10, maxActiveHourly: 3, maxTotal: 50 }, emailAvailable };
}

function renderPanel(onOpenChat = vi.fn(), workspace: ScheduledTaskWorkspaceAvailability = "available") {
  account += 1;
  render(<ScheduledTasksPanel accountId={`account-${account}`} catalog={catalog} onOpenChat={onOpenChat} workspace={workspace} />);
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
      searchEnabled: false, emailNotify: false, chatMode: "new"
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
      { id: "run-2", scheduledFor: "2026-10-02T08:00:00.000Z", trigger: "schedule", state: "completed", reasonCode: null,
        startedAt: "2026-10-02T08:00:05.000Z", finishedAt: "2026-10-02T08:01:00.000Z", chatId: "chat-1", unseen: false,
        unavailableSources: [] },
      { id: "run-1", scheduledFor: "2026-10-01T12:00:00.000Z", trigger: "manual", state: "failed", reasonCode: "model_unavailable",
        startedAt: "2026-10-01T12:00:00.000Z", finishedAt: "2026-10-01T12:00:02.000Z", chatId: "chat-1", unseen: false,
        unavailableSources: [] }
    ] }).mockResolvedValueOnce({ task: { ...task, revision: 3, title: "Renamed elsewhere" }, recentRuns: [] });
    update.mockRejectedValueOnce(new ScheduledTaskApiError("scheduled_task_stale", 409))
      .mockResolvedValueOnce({ ...task, revision: 4, title: "My brief" });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "More actions for Weekday news brief" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    const sheet = screen.getByRole("dialog", { name: "Edit scheduled task" });
    const runs = await within(sheet).findByRole("region", { name: "Recent runs" });
    expect(within(runs).getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      "Fri 2 Oct, 09:00ScheduledAnsweredOpen chat", "Thu 1 Oct, 13:00Run nowFailed: the model was unavailableOpen chat"
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

  it("marks seen only the unread runs its history renders and opens each run's own chat", async () => {
    const answered = { scheduledFor: "2026-10-03T08:00:00.000Z", state: "completed", reasonCode: null,
      finishedAt: "2026-10-03T08:01:00.000Z" } as const;
    const task = scheduledTaskFixture({ chatMode: "new", chatId: "chat-3", unseenResult: true, lastRun: answered });
    list.mockResolvedValueOnce(listed([task])).mockResolvedValue(listed([{ ...task, unseenResult: false }]));
    detail.mockResolvedValueOnce({ task, recentRuns: [
      { id: "run-3", scheduledFor: "2026-10-03T08:00:00.000Z", trigger: "schedule", state: "completed", reasonCode: null,
        startedAt: "2026-10-03T08:00:01.000Z", finishedAt: "2026-10-03T08:01:00.000Z", chatId: "chat-3", unseen: true,
        unavailableSources: [] },
      { id: "run-2", scheduledFor: "2026-10-02T08:00:00.000Z", trigger: "schedule", state: "skipped", reasonCode: "previous_running",
        startedAt: null, finishedAt: "2026-10-02T08:00:01.000Z", chatId: null, unseen: false, unavailableSources: [] },
      { id: "run-1", scheduledFor: "2026-10-01T08:00:00.000Z", trigger: "manual", state: "completed", reasonCode: null,
        startedAt: "2026-10-01T08:00:01.000Z", finishedAt: "2026-10-01T08:01:00.000Z", chatId: "chat-1", unseen: true,
        unavailableSources: [] }
    ] });
    const seen = vi.mocked(markScheduledTaskSeen).mockReset().mockResolvedValue();
    const { onOpenChat } = renderPanel();
    expect(await screen.findByRole("heading", { name: "Weekday news briefNew result" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "More actions for Weekday news brief" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    // Nothing is seen before the history renders it.
    expect(seen).not.toHaveBeenCalled();
    const sheet = screen.getByRole("dialog", { name: "Edit scheduled task" });
    const runs = await within(sheet).findByRole("region", { name: "Recent runs" });
    expect(within(runs).getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      "Sat 3 Oct, 09:00ScheduledNew result: AnsweredOpen chat",
      "Fri 2 Oct, 09:00ScheduledSkipped: the previous run was still in progress",
      "Thu 1 Oct, 09:00Run nowNew result: AnsweredOpen chat"
    ]);
    await waitFor(() => expect(seen).toHaveBeenCalledWith(task.id, ["run-3", "run-1"]));
    expect(seen).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(useScheduledTasksStore.getState().tasks[0]?.unseenResult).toBe(false));

    // Each run opens its own chat; unsaved edits are confirmed first.
    fireEvent.change(within(sheet).getByLabelText("Name"), { target: { value: "Edited" } });
    fireEvent.click(within(runs).getByRole("button", { name: "Open chat from Thu 1 Oct, 09:00" }));
    expect(onOpenChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm discard changes" }));
    await waitFor(() => expect(onOpenChat).toHaveBeenCalledWith("chat-1"));
    expect(screen.queryByRole("dialog", { name: "Edit scheduled task" })).toBeNull();
  });

  it("edits an hourly window with the chat fixed to the task's chat", async () => {
    list.mockResolvedValue(listed([]));
    const created = scheduledTaskFixture({ id: "hourly", title: "Inbox check", chatMode: "same",
      schedule: { kind: "hourly", everyHours: 2, time: "09:00", until: "18:00", days: ["mon", "tue", "wed", "thu", "fri"] } });
    create.mockResolvedValue(created);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    const sheet = screen.getByRole("dialog", { name: "New scheduled task" });
    fireEvent.change(within(sheet).getByLabelText("Name"), { target: { value: "Inbox check" } });
    fireEvent.change(within(sheet).getByLabelText("Instructions"), { target: { value: "Summarize new mail." } });
    expect(within(sheet).getByRole("radio", { name: "Each run starts a new chat" })).toBeChecked();
    fireEvent.change(within(sheet).getByLabelText("Time zone"), { target: { value: "Europe/London" } });
    fireEvent.change(within(sheet).getByLabelText("Repeat"), { target: { value: "hourly" } });
    expect(within(sheet).queryByLabelText("Time")).toBeNull();
    expect(within(sheet).getByRole("radio", { name: "All day" })).toBeChecked();
    expect(within(sheet).getByTestId("scheduled-task-preview")).toHaveTextContent("Next run: Sun 4 Oct, 12:00");
    // Hourly tasks continue in one chat: the other choice is unavailable and the line says why.
    const newChat = within(sheet).getByRole("radio", { name: "Each run starts a new chat" });
    expect(newChat).toBeDisabled();
    expect(within(sheet).getByRole("radio", { name: "Continue in this task's chat" })).toBeChecked();
    expect(within(sheet).getByRole("group", { name: "Chat" })).toHaveAccessibleDescription("Hourly tasks always continue in one chat.");

    fireEvent.change(within(sheet).getByLabelText("Interval"), { target: { value: "2" } });
    fireEvent.click(within(sheet).getByRole("radio", { name: "Set hours" }));
    fireEvent.change(within(sheet).getByLabelText("From"), { target: { value: "09:00" } });
    fireEvent.change(within(sheet).getByLabelText("Until"), { target: { value: "08:00" } });
    for (const day of ["Saturday", "Sunday"]) fireEvent.click(within(sheet).getByRole("button", { name: day }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Create task" }));
    expect(within(sheet).getByRole("alert")).toHaveTextContent("Choose an end time later than the start time.");
    expect(create).not.toHaveBeenCalled();
    fireEvent.change(within(sheet).getByLabelText("Until"), { target: { value: "18:00" } });
    expect(within(sheet).getByTestId("scheduled-task-preview")).toHaveTextContent("Next run: Mon 5 Oct, 09:00");
    fireEvent.click(within(sheet).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      chatMode: "same",
      schedule: { kind: "hourly", everyHours: 2, time: "09:00", until: "18:00", days: ["mon", "tue", "wed", "thu", "fri"] }
    }));
    expect(screen.getByText(/^Every 2 hours, 09:00–18:00, Mon–Fri/u)).toBeInTheDocument();
  });

  it("sends the same chat when a task switches to hourly, restores its own choice when it switches back and shows the hourly limit inline", async () => {
    const task = scheduledTaskFixture({ chatMode: "new", schedule: { kind: "daily", time: "08:00" } });
    list.mockResolvedValue(listed([task]));
    detail.mockResolvedValue({ task, recentRuns: [] });
    update.mockRejectedValueOnce(new ScheduledTaskApiError("scheduled_task_hourly_limit", 409));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "More actions for Weekday news brief" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    const sheet = screen.getByRole("dialog", { name: "Edit scheduled task" });
    fireEvent.change(within(sheet).getByLabelText("Repeat"), { target: { value: "hourly" } });
    fireEvent.change(within(sheet).getByLabelText("Repeat"), { target: { value: "daily" } });
    expect(within(sheet).getByRole("radio", { name: "Each run starts a new chat" })).toBeChecked();
    fireEvent.change(within(sheet).getByLabelText("Repeat"), { target: { value: "hourly" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save changes" }));
    const error = await within(sheet).findByText(/up to 3 active hourly tasks/u);
    expect(within(sheet).getByRole("group", { name: "Schedule" })).toHaveAttribute("aria-describedby", error.id);
    expect(update).toHaveBeenCalledWith(task.id, {
      expectedRevision: 1, chatMode: "same",
      schedule: { kind: "hourly", everyHours: 1, time: "00:00", until: null, days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }
    });
  });

  it("opens a task's editor when its chat asks for it", async () => {
    const task = scheduledTaskFixture({ chatId: "chat-1" });
    list.mockResolvedValue(listed([task]));
    detail.mockResolvedValue({ task, recentRuns: [] });
    renderPanel();
    await screen.findByRole("heading", { name: task.title });
    act(() => requestScheduledTaskEdit(task.id));
    const sheet = await screen.findByRole("dialog", { name: "Edit scheduled task" });
    expect(within(sheet).getByLabelText("Name")).toHaveValue(task.title);
    expect(useScheduledTasksStore.getState().editRequest).toBeNull();
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
    expect(confirm).toHaveTextContent("Its chats and answers stay in your history.");
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete task" }));
    expect(await screen.findByTestId("scheduled-tasks-empty")).toBeInTheDocument();
    expect(remove).toHaveBeenCalledWith(task.id);
  });

  it("offers a monitoring type that continues in one chat and needs a model that can call tools", async () => {
    list.mockResolvedValue(listed([]));
    create.mockResolvedValue(scheduledTaskFixture({ id: "new", chatMode: "new" }));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    const sheet = screen.getByRole("dialog", { name: "New scheduled task" });
    fireEvent.change(within(sheet).getByLabelText("Name"), { target: { value: "Release watch" } });
    fireEvent.change(within(sheet).getByLabelText("Instructions"), { target: { value: "Tell me when 2.0 ships." } });
    const type = within(sheet).getByRole("group", { name: "Type" });
    expect(within(type).getByRole("radio", { name: "Regular" })).toBeChecked();
    expect(type).toHaveAccessibleDescription("Monitoring reports only when something changed and can stop itself when the goal is reached.");
    expect(within(sheet).getByRole("radio", { name: "Each run starts a new chat" })).toBeChecked();

    fireEvent.click(within(type).getByRole("radio", { name: "Monitoring" }));
    const chat = within(sheet).getByRole("group", { name: "Chat" });
    expect(within(chat).getByRole("radio", { name: "Each run starts a new chat" })).toBeDisabled();
    expect(within(chat).getByRole("radio", { name: "Continue in this task's chat" })).toBeChecked();
    expect(chat).toHaveAccessibleDescription("Monitoring compares each check with the last result, so it always continues in one chat.");

    // A model without tool calling cannot report a check: the reason shows at once, and its switches turn off.
    expect(within(sheet).getByRole("switch", { name: "Tools (MCP and Skills)" })).toHaveAttribute("aria-checked", "true");
    fireEvent.change(within(sheet).getByLabelText("Model"), { target: { value: "provider-a:model-c" } });
    expect(type).toHaveAccessibleDescription(/Monitoring needs a model that can use tools\. Choose another model\./u);
    for (const name of ["Tools (MCP and Skills)", "Workspace"]) {
      const control = within(sheet).getByRole("switch", { name });
      expect(control).toHaveAttribute("aria-checked", "false");
      expect(control).toBeDisabled();
      expect(control).toHaveAccessibleDescription("Not available with this model.");
    }
    fireEvent.click(within(sheet).getByRole("button", { name: "Create task" }));
    expect(within(sheet).getByRole("alert")).toHaveTextContent("Monitoring needs a model that can use tools. Choose another model.");
    expect(create).not.toHaveBeenCalled();

    // Back to Regular: the owner's own chat choice returns and the task saves.
    fireEvent.click(within(type).getByRole("radio", { name: "Regular" }));
    expect(within(chat).getByRole("radio", { name: "Each run starts a new chat" })).toBeChecked();
    expect(within(sheet).queryByText(/Monitoring needs a model/u)).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      kind: "standard", chatMode: "new", modelId: "model-c", toolsEnabled: false, workspaceEnabled: false
    })));
  });

  it("starts the tool switches from the composer defaults, explains a Workspace the administrator turned off and shows save refusals inline", async () => {
    list.mockResolvedValue(listed([]));
    create.mockRejectedValueOnce(new ScheduledTaskApiError("scheduled_task_tools_unavailable", 400));
    renderPanel(vi.fn(), "installation_disabled");
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    const sheet = screen.getByRole("dialog", { name: "New scheduled task" });
    const tools = within(sheet).getByRole("switch", { name: "Tools (MCP and Skills)" });
    expect(tools).toHaveAttribute("aria-checked", "true");
    expect(tools).toHaveAccessibleDescription("Lets each run use your MCP tools and Skills in Auto mode, as in a chat.");
    const workspace = within(sheet).getByRole("switch", { name: "Workspace" });
    expect(workspace).toHaveAttribute("aria-checked", "false");
    expect(workspace).toBeDisabled();
    expect(workspace).toHaveAccessibleDescription("Workspace is turned off by the administrator.");
    fireEvent.change(within(sheet).getByLabelText("Name"), { target: { value: "Inbox" } });
    fireEvent.change(within(sheet).getByLabelText("Instructions"), { target: { value: "Check mail." } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Create task" }));
    const error = await within(sheet).findByText("This model cannot use tools. Turn tools off or choose another model.");
    expect(tools.getAttribute("aria-describedby")).toContain(error.id);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ toolsEnabled: true, workspaceEnabled: false }));
  });

  it("labels monitoring tasks, keeps Resume for a reached goal and shows check outcomes and missing sources in the history", async () => {
    const watching = scheduledTaskFixture({ id: "watch", title: "Release watch", kind: "monitoring", chatId: "chat-w" });
    const done = scheduledTaskFixture({ id: "done", title: "Ticket watch", kind: "monitoring", status: "completed", nextRunAt: null,
      completionReason: "goal_reached", schedule: { kind: "daily", time: "09:00" },
      lastRun: { scheduledFor: "2026-10-03T08:00:00.000Z", state: "completed", reasonCode: "goal_reached", finishedAt: "2026-10-03T08:01:00.000Z" } });
    list.mockResolvedValue(listed([watching, done]));
    update.mockResolvedValueOnce({ ...done, status: "active", completionReason: null, nextRunAt: "2026-10-05T08:00:00.000Z", revision: 2 });
    const run = (id: string, reasonCode: string, extra: Partial<ScheduledTaskRun> = {}): ScheduledTaskRun => ({
      id, scheduledFor: "2026-10-02T08:00:00.000Z", trigger: "schedule", state: "completed", reasonCode,
      startedAt: "2026-10-02T08:00:01.000Z", finishedAt: "2026-10-02T08:01:00.000Z", chatId: "chat-w", unseen: false,
      unavailableSources: [], ...extra
    });
    detail.mockResolvedValueOnce({ task: watching, recentRuns: [
      run("r3", "could_not_check", { unavailableSources: [{ name: "Release tracker", reason: "mcp_reauthorization_required" }] }),
      run("r2", "no_update"),
      run("r1", "baseline")
    ] });
    renderPanel();
    const rows = await screen.findAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Monitoring · Next run Tue 6 Oct, 09:00");
    expect(rows[1]).toHaveTextContent("Monitoring · Goal reached — completed");
    expect(rows[1]).toHaveTextContent("Last run Sat 3 Oct, 09:00 · Goal reached");
    const resume = within(rows[1]!).getByRole("switch", { name: "Run Ticket watch on schedule" });
    expect(resume).toHaveAttribute("aria-checked", "false");
    fireEvent.click(resume);
    await waitFor(() => expect(update).toHaveBeenCalledWith("done", { expectedRevision: 1, status: "active" }));

    fireEvent.click(screen.getByRole("button", { name: "More actions for Release watch" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    const sheet = screen.getByRole("dialog", { name: "Edit scheduled task" });
    expect(within(sheet).getByRole("radio", { name: "Monitoring" })).toBeChecked();
    const history = await within(sheet).findByRole("region", { name: "Recent runs" });
    const entries = within(history).getAllByRole("listitem");
    expect(entries[0]).toHaveAttribute("data-tone", "attention");
    expect(entries[0]).toHaveTextContent("Could not check: a source was unavailableRelease tracker needs sign-in.");
    expect(entries[1]).toHaveAttribute("data-tone", "quiet");
    expect(entries[1]).toHaveTextContent("No update: nothing changed since the last shown result");
    expect(entries[2]).toHaveTextContent("First check: the starting point later checks compare with");
  });

  it("disables New task at the active limit with the reason", async () => {
    list.mockResolvedValue({ ...listed(Array.from({ length: 10 }, (_, index) => scheduledTaskFixture({ id: `task-${index}`, title: `Task ${index}` }))) });
    renderPanel();
    const button = await screen.findByRole("button", { name: "New task" });
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveAccessibleDescription("You have 10 active tasks. Pause or delete one to add another.");
  });
});
