import { describe, expect, it } from "vitest";
import {
  adminSectionConfig,
  adminSectionGroups,
  adminSectionPath,
  adminSections,
  normalizeAdminSectionPath,
  parseAdminSection,
  resolveAdminSectionId
} from "./adminSections";

describe("adminSections", () => {
  it("lists Overview first and groups the other destinations as Models, People and Platform", () => {
    expect(adminSections.map(({ group, id, label }) => ({ group, id, label }))).toEqual([
      { group: null, id: "overview", label: "Overview" },
      { group: "models", id: "providers", label: "Providers" },
      { group: "models", id: "roles", label: "Defaults & roles" },
      { group: "models", id: "search", label: "Search" },
      { group: "models", id: "retrieval", label: "Knowledge & Memory" },
      { group: "people", id: "users", label: "Users" },
      { group: "people", id: "groups", label: "Groups" },
      { group: "platform", id: "mcp", label: "MCP servers" },
      { group: "platform", id: "workspace", label: "Workspace" },
      { group: "platform", id: "email", label: "Email" },
      { group: "platform", id: "usage", label: "Usage" }
    ]);
    expect(adminSectionGroups.map((group) => group.label)).toEqual(["Models", "People", "Platform"]);
    expect(adminSectionConfig("roles").label).toBe("Defaults & roles");
  });

  it("defaults to Overview and maps every retired section id to its new owner", () => {
    expect(parseAdminSection("")).toBe("overview");
    expect(parseAdminSection("?section=groups")).toBe("groups");
    expect(parseAdminSection("?section=unknown-section")).toBe("overview");
    expect(resolveAdminSectionId("system-models")).toBe("roles");
    expect(resolveAdminSectionId("access")).toBe("groups");
    expect(resolveAdminSectionId("invites")).toBe("users");
    expect(resolveAdminSectionId("access-rules")).toBe("users");
    expect(resolveAdminSectionId("safety")).toBe("users");
    expect(resolveAdminSectionId("knowledge")).toBe("retrieval");
    expect(resolveAdminSectionId("memory")).toBe("retrieval");
    expect(resolveAdminSectionId(null)).toBe("overview");
  });

  it("rewrites legacy and unknown sections in the URL while keeping other parts", () => {
    expect(normalizeAdminSectionPath("https://aiqsa.example/admin?mode=compact&section=system-models#current"))
      .toBe("/admin?mode=compact&section=roles#current");
    expect(normalizeAdminSectionPath("https://aiqsa.example/admin?section=invites")).toBe("/admin?section=users");
    expect(normalizeAdminSectionPath("https://aiqsa.example/admin?section=removed-section")).toBe("/admin");
    expect(normalizeAdminSectionPath("https://aiqsa.example/admin?section=search")).toBe("/admin?section=search");
    expect(normalizeAdminSectionPath("https://aiqsa.example/admin")).toBe("/admin");
  });

  it("updates only the section query while preserving the path, other queries and hash", () => {
    expect(adminSectionPath("https://aiqsa.example/admin?mode=compact#current", "users")).toBe(
      "/admin?mode=compact&section=users#current"
    );
    expect(adminSectionPath("https://aiqsa.example/admin?mode=compact&section=users#current", "groups")).toBe(
      "/admin?mode=compact&section=groups#current"
    );
    expect(adminSectionPath("https://aiqsa.example/admin?mode=compact&section=users#current", "overview")).toBe(
      "/admin?mode=compact#current"
    );
  });
});
