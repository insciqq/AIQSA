import { describe, expect, it } from "vitest";
import { getWorkspaceConfig } from "../workspace/config";
import { workspaceTurnSoftDeadlineMs } from "./workspaceTurnDeadline";

describe("Workspace turn soft deadline", () => {
  it("lets a default turn work for 54 of its 60 minutes before it must answer", () => {
    const config = getWorkspaceConfig({});
    expect(workspaceTurnSoftDeadlineMs(config.turnTimeoutSeconds, config.syncToolTimeoutSeconds)).toBe(3_240_000);
  });

  it("follows an explicit turn time and keeps half of a short one for work", () => {
    expect(workspaceTurnSoftDeadlineMs(1_800, 120)).toBe(1_440_000);
    expect(workspaceTurnSoftDeadlineMs(7_200, 120)).toBe(6_840_000);
    expect(workspaceTurnSoftDeadlineMs(300, 120)).toBe(150_000);
  });
});
