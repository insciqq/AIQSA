import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduledTaskChatHintV2, scheduledTaskChatHintText, type ScheduledTaskChatHintTask } from "./ScheduledTaskChatHintV2";
import { markScheduledTaskSeen } from "./scheduledTasksApi";

afterEach(() => vi.unstubAllGlobals());

const now = new Date("2026-10-04T10:00:00.000Z");
const active: ScheduledTaskChatHintTask = {
  kind: "monitoring", nextRunAt: "2026-10-04T14:03:00.000Z", running: false, scheduleEnabled: true, status: "active", webhookEnabled: false
};

describe("ScheduledTaskChatHintV2", () => {
  it("says when the task runs next, offers its editor and keeps the note that replies don't change it", () => {
    const onEdit = vi.fn();
    render(<ScheduledTaskChatHintV2 now={now} task={active} timeZone="Europe/London" title="Inbox check" onEdit={onEdit} />);
    const hint = screen.getByTestId("scheduled-task-chat-hint");
    expect(hint).toHaveTextContent("Next check Sun 4 Oct, 15:03·Replies here don't change the automation.·Edit automation");
    expect(hint).toHaveAttribute("title", "Replies here don't change the automation.");
    fireEvent.click(screen.getByRole("button", { name: "Edit automation Inbox check" }));
    expect(onEdit).toHaveBeenCalledOnce();
  });

  it("names each state of the task in the viewer's zone", () => {
    const text = (task: Partial<ScheduledTaskChatHintTask> | null, zone = "Europe/London") =>
      scheduledTaskChatHintText(task ? { ...active, ...task } : null, zone, now);
    expect(text({})).toBe("Next check Sun 4 Oct, 15:03");
    expect(text({}, "Asia/Tokyo")).toBe("Next check Sun 4 Oct, 23:03");
    expect(text({ kind: "standard" })).toBe("Next run Sun 4 Oct, 15:03");
    expect(text({ running: true })).toBe("Checking now");
    expect(text({ kind: "standard", running: true })).toBe("Running now");
    expect(text({ nextRunAt: null, status: "paused" })).toBe("Paused");
    expect(text({ nextRunAt: null, status: "completed" })).toBe("Completed");
    expect(text({ nextRunAt: null, scheduleEnabled: false, webhookEnabled: true })).toBe("Runs on each webhook call");
    expect(text({ nextRunAt: null })).toBe("No upcoming run");
    expect(text(null)).toBeNull();
  });

  it("says only that replies don't change the task until the task list has loaded", () => {
    render(<ScheduledTaskChatHintV2 title="Inbox check" onEdit={vi.fn()} />);
    expect(screen.getByTestId("scheduled-task-chat-hint")).toHaveTextContent("Replies here don't change the automation.·Edit automation");
  });

  it("stays a plain note when the editor is unreachable", () => {
    render(<ScheduledTaskChatHintV2 title="Inbox check" />);
    expect(screen.getByTestId("scheduled-task-chat-hint")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("markScheduledTaskSeen", () => {
  it("posts the rendered run ids, unique and at most 50 per request", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const runIds = Array.from({ length: 51 }, (_, index) => `run-${index}`);
    await markScheduledTaskSeen("task/1", [...runIds, "run-0"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((call) => {
      const [url, init] = call as unknown as [string, RequestInit];
      expect(url).toBe("/api/me/scheduled-tasks/task%2F1/seen");
      expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
      return JSON.parse(String(init.body)) as { runIds: string[] };
    });
    expect(bodies.map((body) => body.runIds.length)).toEqual([50, 1]);
    expect(bodies.flatMap((body) => body.runIds)).toEqual(runIds);
  });
});
