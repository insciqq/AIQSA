import { describe, expect, it } from "vitest";
import { safeInternalPath } from "./internalPath";

describe("safeInternalPath", () => {
  it("keeps legitimate internal paths with search and hash", () => {
    expect(safeInternalPath("/admin?tab=users#section", "https://aiqsa.example")).toBe(
      "/admin?tab=users#section"
    );
  });

  it.each([
    "",
    "admin",
    "//evil.com",
    "/\\evil.com",
    "/\\/evil.com",
    "\\\\evil.com",
    "%5C%5Cevil.com",
    "/%5Cevil.com",
    "https://evil.com",
    "javascript:alert(1)",
    "data:text/html,evil",
    "/admin https://evil.com",
    "/admin\n/evil"
  ])("falls back for unsafe redirect target %s", (nextPath) => {
    expect(safeInternalPath(nextPath, "https://aiqsa.example")).toBe("/");
  });
});
