import { describe, expect, it } from "vitest";
import {
  adminSectionConfig,
  adminSectionGroups,
  adminSectionMoveForKey,
  adminSectionPanelId,
  adminSectionPath,
  adminSections,
  adminSectionTabId,
  moveAdminSection,
  normalizeAdminSectionPath,
  parseAdminSection
} from "./adminSections";

describe("adminSections", () => {
  it("groups the approved destinations under static subject headings", () => {
    expect(adminSections.map(({ group, id, label }) => ({ group, id, label }))).toEqual([
      { group: "ai-setup", id: "providers", label: "Providers" },
      { group: "ai-setup", id: "search", label: "Search" },
      { group: "ai-setup", id: "knowledge", label: "Knowledge" },
      { group: "ai-setup", id: "memory", label: "Memory" },
      { group: "team-access", id: "users", label: "Users" },
      { group: "team-access", id: "access", label: "Access & groups" },
      { group: "team-access", id: "invites", label: "Invites" },
      { group: "team-access", id: "access-rules", label: "Access rules" },
      { group: "operations", id: "usage", label: "Usage" },
      { group: "infrastructure", id: "mcp", label: "MCP servers" },
      { group: "infrastructure", id: "workspace", label: "Workspace" },
      { group: "infrastructure", id: "email", label: "Email delivery" },
      { group: "safety", id: "safety", label: "Safety" }
    ]);
    expect(
      adminSectionGroups.map((group) => ({
        label: group.label,
        sections: adminSections.filter((section) => section.group === group.id).map((section) => section.label)
      }))
    ).toEqual([
      { label: "AI setup", sections: ["Providers", "Search", "Knowledge", "Memory"] },
      { label: "Team & access", sections: ["Users", "Access & groups", "Invites", "Access rules"] },
      { label: "Operations", sections: ["Usage"] },
      { label: "Infrastructure", sections: ["MCP servers", "Workspace", "Email delivery"] },
      { label: "Safety", sections: ["Safety"] }
    ]);
    expect(adminSectionConfig("access").description).toContain("model and search entitlements");
  });

  it("describes the current provider workspace without retired Run profiles", () => {
    const providers = adminSections.find((section) => section.id === "providers");

    expect(providers?.description).toContain("models");
    expect(providers?.description).not.toMatch(/profiles/i);
  });

  it("defaults unknown destinations to Providers", () => {
    expect(parseAdminSection("")).toBe("providers");
    expect(parseAdminSection("?section=invites")).toBe("invites");
    expect(parseAdminSection("?section=removed-section")).toBe("providers");
    expect(parseAdminSection("?section=unknown-section")).toBe("providers");
    expect(parseAdminSection("?section=unknown")).toBe("providers");

    expect(normalizeAdminSectionPath("https://aiqsa.example/admin?mode=compact&section=removed-section#current")).toBe(
      "/admin?mode=compact#current"
    );
    expect(normalizeAdminSectionPath("https://aiqsa.example/admin?section=unknown-section")).toBe(
      "/admin"
    );
    expect(normalizeAdminSectionPath("https://aiqsa.example/admin?section=unknown#current")).toBe(
      "/admin#current"
    );
  });

  it("updates only the section query while preserving the path, other queries, and hash", () => {
    expect(adminSectionPath("https://aiqsa.example/admin?mode=compact#current", "invites")).toBe(
      "/admin?mode=compact&section=invites#current"
    );
    expect(adminSectionPath("https://aiqsa.example/admin?mode=compact&section=invites#current", "access")).toBe(
      "/admin?mode=compact&section=access#current"
    );
    expect(adminSectionPath("https://aiqsa.example/admin?mode=compact&section=invites#current", "providers")).toBe(
      "/admin?mode=compact#current"
    );
  });

  it("maps roving keys and wraps through the ordered section inventory", () => {
    expect(adminSectionMoveForKey("ArrowRight")).toBe("next");
    expect(adminSectionMoveForKey("ArrowDown")).toBe("next");
    expect(adminSectionMoveForKey("ArrowLeft")).toBe("previous");
    expect(adminSectionMoveForKey("ArrowUp")).toBe("previous");
    expect(adminSectionMoveForKey("Home")).toBe("first");
    expect(adminSectionMoveForKey("End")).toBe("last");
    expect(adminSectionMoveForKey("PageDown")).toBeNull();

    expect(moveAdminSection("providers", "previous")).toBe("safety");
    expect(moveAdminSection("safety", "next")).toBe("providers");
    expect(moveAdminSection("access", "first")).toBe("providers");
    expect(moveAdminSection("access", "last")).toBe("safety");
  });

  it("owns stable tab and panel ids", () => {
    expect(adminSectionTabId("access")).toBe("admin-tab-access");
    expect(adminSectionPanelId("access")).toBe("admin-panel-access");
  });
});
