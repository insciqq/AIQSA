import { describe, expect, it } from "vitest";
import {
  adminSectionConfig,
  adminSectionMoveForKey,
  adminSectionPanelId,
  adminSectionPath,
  adminSections,
  adminSectionTabId,
  moveAdminSection,
  parseAdminSection
} from "./adminSections";

describe("adminSections", () => {
  it("keeps the documented section order and semantic labels", () => {
    expect(adminSections.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "users", label: "Users" },
      { id: "usage", label: "Usage" },
      { id: "groups", label: "Groups" },
      { id: "model-access", label: "Model access" },
      { id: "providers", label: "Providers" },
      { id: "mcp", label: "MCP servers" },
      { id: "email", label: "Email delivery" },
      { id: "invites", label: "Invites" },
      { id: "access-rules", label: "Access rules" },
      { id: "safety", label: "Safety" }
    ]);
    expect(adminSectionConfig("model-access").description).toBe(
      "Toggle provider, model, and search access for active groups."
    );
    expect(adminSectionConfig("email").description).toContain("monitor installation email delivery");
  });

  it("parses only known deep-linked sections and otherwise selects Users", () => {
    expect(parseAdminSection("")).toBe("users");
    expect(parseAdminSection("?section=invites")).toBe("invites");
    expect(parseAdminSection("?section=mcp")).toBe("mcp");
    expect(parseAdminSection("?section=email")).toBe("email");
    expect(parseAdminSection("?mode=compact&section=access-rules")).toBe("access-rules");
    expect(parseAdminSection("?section=unknown")).toBe("users");
    expect(parseAdminSection("?section=")).toBe("users");
  });

  it("updates only the section query while preserving the path, other queries, and hash", () => {
    expect(adminSectionPath("https://aiqsa.example/admin?mode=compact#current", "invites")).toBe(
      "/admin?mode=compact&section=invites#current"
    );
    expect(adminSectionPath("https://aiqsa.example/admin?mode=compact&section=invites#current", "groups")).toBe(
      "/admin?mode=compact&section=groups#current"
    );
    expect(adminSectionPath("https://aiqsa.example/admin?mode=compact&section=invites#current", "users")).toBe(
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

    expect(moveAdminSection("users", "previous")).toBe("safety");
    expect(moveAdminSection("safety", "next")).toBe("users");
    expect(moveAdminSection("groups", "first")).toBe("users");
    expect(moveAdminSection("groups", "last")).toBe("safety");
  });

  it("owns stable tab and panel ids", () => {
    expect(adminSectionTabId("access-rules")).toBe("admin-tab-access-rules");
    expect(adminSectionPanelId("access-rules")).toBe("admin-panel-access-rules");
  });
});
