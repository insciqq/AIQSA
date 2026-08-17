import { describe, expect, it } from "vitest";
import {
  highestProjectRole,
  isProjectRole,
  projectRoleAtLeast
} from "./projects";

describe("Project roles", () => {
  it("orders fixed roles and chooses the strongest grant", () => {
    expect(projectRoleAtLeast("MANAGER", "CONTRIBUTOR")).toBe(true);
    expect(projectRoleAtLeast("VIEWER", "CONTRIBUTOR")).toBe(false);
    expect(highestProjectRole(["VIEWER", "OWNER", "MANAGER"])).toBe("OWNER");
    expect(highestProjectRole([])).toBeNull();
  });

  it("rejects roles outside the fixed MVP vocabulary", () => {
    expect(isProjectRole("CONTRIBUTOR")).toBe(true);
    expect(isProjectRole("ADMIN")).toBe(false);
    expect(isProjectRole(null)).toBe(false);
  });
});
