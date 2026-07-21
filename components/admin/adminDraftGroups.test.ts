import { describe, expect, it } from "vitest";
import { activeDraftGroupIds } from "./adminDraftGroups";

const activeGroup = {
  archivedAt: null,
  id: "active"
};
const archivedGroup = {
  archivedAt: "2026-07-12T00:00:00.000Z",
  id: "archived"
};

describe("activeDraftGroupIds", () => {
  it("preserves order while removing archived and stale group ids", () => {
    expect(activeDraftGroupIds([activeGroup, archivedGroup], ["archived", "active", "missing"])).toEqual(["active"]);
  });
});
