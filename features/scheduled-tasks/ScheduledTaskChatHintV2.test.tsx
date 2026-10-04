import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduledTaskChatHintV2 } from "./ScheduledTaskChatHintV2";
import { markScheduledTaskSeen } from "./scheduledTasksApi";

afterEach(() => vi.unstubAllGlobals());

describe("ScheduledTaskChatHintV2", () => {
  it("says replies do not change the task and offers its editor", () => {
    const onEdit = vi.fn();
    render(<ScheduledTaskChatHintV2 title="Inbox check" onEdit={onEdit} />);
    expect(screen.getByTestId("scheduled-task-chat-hint")).toHaveTextContent("Replies here don't change the scheduled task.");
    fireEvent.click(screen.getByRole("button", { name: "Edit task Inbox check" }));
    expect(onEdit).toHaveBeenCalledOnce();
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
