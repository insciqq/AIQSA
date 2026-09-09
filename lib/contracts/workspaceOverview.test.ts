import { describe, expect, it } from "vitest";
import { decodeWorkspaceOverviewResponse } from "./workspaceOverview";

const overview = {
  activeCount: 1, filter: "active", observedAt: "2026-09-09T12:00:00.000Z", page: 1, pageSize: 20,
  rows: [{ context: "personal", id: "ws-1234567890abcdef", lastActiveAt: "2026-09-09T12:00:00.000Z", state: "ready", user: "User" }],
  state: "fresh", stoppedCount: 0, totalCount: 1, transitioningCount: 0, unknownCount: 0, updatedAt: "2026-09-09T12:00:00.000Z"
};

describe("Workspace overview browser decoder", () => {
  it("projects only reviewed metadata and drops additive private fields", () => {
    expect(decodeWorkspaceOverviewResponse({ overview: { ...overview, token: "private", rows: [
      { ...overview.rows[0], sandboxName: "private", chatId: "private", projectTitle: "private" }
    ] } })).toEqual(overview);
  });
  it.each([
    { activeCount: -1 }, { page: 0 }, { pageSize: 100 }, { totalCount: 0 }, { observedAt: null },
    { state: "unavailable" }, { rows: [{ ...overview.rows[0], id: "internal_runtime_id" }] },
    { rows: [{ ...overview.rows[0], state: "invented" }] }, { rows: Array(21).fill(overview.rows[0]) }
  ])("rejects malformed counts, evidence, identifiers and pages: %j", (patch) => {
    expect(decodeWorkspaceOverviewResponse({ overview: { ...overview, ...patch } })).toBeNull();
  });
});
