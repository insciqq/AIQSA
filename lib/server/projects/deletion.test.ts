import { describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => vi.fn());
vi.mock("../observability", () => ({ logEvent: log }));

import { logProjectDeletionPass } from "./deletion";

describe("Project deletion pass log", () => {
  it("stays quiet when nothing was deleted or failed", () => {
    logProjectDeletionPass({ completed: 0, failed: 0, pending: 3 });
    expect(log).not.toHaveBeenCalled();
  });

  it("reports content-free counts and asks for a retry only after a failure", () => {
    logProjectDeletionPass({ completed: 2, failed: 0, pending: 1 });
    logProjectDeletionPass({ completed: 0, failed: 1, pending: 0 });
    expect(log.mock.calls).toEqual([
      ["runtime_lifecycle", { completed_count: 2, failed_count: 0, outcome: "completed", pending_count: 1,
        stage: "delete", subsystem: "projects" }],
      ["runtime_lifecycle", { action: "retry", code: "project_deletion_failed", completed_count: 0, failed_count: 1,
        outcome: "failed", pending_count: 0, stage: "delete", subsystem: "projects" }]
    ]);
  });
});
