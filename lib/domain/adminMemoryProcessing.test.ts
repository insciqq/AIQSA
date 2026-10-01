import { describe, expect, it } from "vitest";
import type { AdminMemoryStatus } from "../contracts/adminMemory";
import { adminMemoryProcessingCopy, adminMemoryStatusForAttention } from "./adminMemoryProcessing";

describe("administrator Memory recent-activity diagnostics", () => {
  const issues: AdminMemoryStatus["processing"]["issues"] = [
    { stage: "LEARNING", reason: "PROCESSING_FAILED", severity: "bad", count: 1, oldestAgeSeconds: 60 },
    { stage: "COMMAND", reason: "COMMAND_UNKNOWN", severity: "warn", count: 1, oldestAgeSeconds: 60 },
    { stage: "SEARCH", reason: "SEARCH_DEGRADED", severity: "warn", count: 3, oldestAgeSeconds: 3600 }
  ];

  it("uses neutral titles that name no user, content or raw failure", () => {
    expect(adminMemoryProcessingCopy(issues[1]!)).toMatchObject({
      action: "Open Memory", section: "retrieval", title: "Memory commands failed recently" });
    const search = adminMemoryProcessingCopy(issues[2]!);
    expect(search).toMatchObject({ title: "Memory search degraded recently" });
    expect(search.detail).toContain("3 searches; oldest 1h.");
  });

  it("keeps command and search diagnostics out of Overview attention", () => {
    const status = { processing: { enabled: true, issues } } as AdminMemoryStatus;
    expect(adminMemoryStatusForAttention(status).processing.issues).toEqual([issues[0]]);
    expect(status.processing.issues).toHaveLength(3);
  });
});
