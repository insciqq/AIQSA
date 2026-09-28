import { describe, expect, it } from "vitest";
import {
  assistantCardStatusText,
  assistantRowDeviationCopy,
  assistantUnavailabilityCopy
} from "./assistantAvailabilityCopy";

describe("assistantUnavailabilityCopy", () => {
  it("words archival as the chat's notice does, in full sentences", () => {
    const availability = { ok: false as const, reason: "archived" as const };
    expect(assistantUnavailabilityCopy({ availability, owned: true })?.headline).toBe("You archived this Assistant.");
    expect(assistantUnavailabilityCopy({ availability, owned: false })?.headline).toBe("This Assistant was archived by its owner.");
  });

  it.each([true, false])("shows Knowledge readiness and check failures without suggesting access loss (owned: %s)", (owned) => {
    expect(assistantUnavailabilityCopy({ owned, availability: { ok: false, reason: "knowledge_not_ready" } }))
      .toEqual({ headline: "Knowledge is not ready yet.", explanation: "Required Knowledge has no ready documents yet. Try again when the documents are ready." });
    expect(assistantUnavailabilityCopy({ owned, availability: { ok: false, reason: "knowledge_unavailable" } }))
      .toEqual({ headline: "Knowledge is temporarily unavailable.", explanation: "Required Knowledge could not be checked. Try again later or ask an administrator to check its configuration." });
  });

  it.each(["skills_access", "knowledge_access"] as const)("offers owner repair and neutral recipient copy for %s", (reason) => {
    const availability = { ok: false as const, reason };
    expect(assistantUnavailabilityCopy({ availability, owned: true })).toMatchObject({ action: { kind: "open-editor", label: "Edit setup" } });
    expect(assistantUnavailabilityCopy({ availability, owned: false })).not.toHaveProperty("action");
    expect(assistantUnavailabilityCopy({ availability, owned: false })?.explanation).toContain("not available to you");
  });
  it("names an owner's failing MCP dependency and offers the actionable settings route", () => {
    expect(assistantUnavailabilityCopy({
      availability: {
        dependencies: [{ kind: "mcp", name: "GitHub" }],
        ok: false,
        reason: "tools_access"
      },
      owned: true
    })).toEqual({
      action: { kind: "mcp-settings", label: "Fix in MCP servers…" },
      explanation: "GitHub is turned off or needs attention.",
      headline: "This Assistant needs the GitHub tools."
    });
  });

  it("never reveals dependency names or fix actions for a shared Assistant", () => {
    const copy = assistantUnavailabilityCopy({
      availability: {
        dependencies: [{ kind: "mcp", name: "Private finance server" }],
        ok: false,
        reason: "tools_access"
      },
      owned: false
    });

    expect(copy).toEqual({
      explanation: "A saved tool dependency is not available to you.",
      headline: "This Assistant needs tools you cannot use."
    });
    expect(JSON.stringify(copy)).not.toContain("Private finance server");
  });

  it("does not offer Settings for an MCP dependency the owner can no longer access", () => {
    expect(assistantUnavailabilityCopy({
      availability: {
        dependencies: [{ kind: "mcp", name: "Required MCP tools" }],
        ok: false,
        reason: "tools_access"
      },
      owned: true
    })).toEqual({
      action: { kind: "open-editor", label: "Edit setup" },
      explanation: "A required MCP server is no longer available to you.",
      headline: "This Assistant needs MCP tools you cannot use."
    });
  });

  it("prefers editing when a mixed MCP failure includes an inaccessible dependency", () => {
    expect(assistantUnavailabilityCopy({
      availability: {
        dependencies: [
          { kind: "mcp", name: "GitHub" },
          { kind: "mcp", name: "Required MCP tools" }
        ],
        ok: false,
        reason: "tools_access"
      },
      owned: true
    })).toMatchObject({
      action: { kind: "open-editor" },
      headline: "This Assistant needs MCP tools you cannot use."
    });
  });

  it("returns no failure copy for an available Assistant", () => {
    expect(assistantUnavailabilityCopy({ availability: { ok: true }, owned: true })).toBeNull();
  });
});

describe("assistantCardStatusText", () => {
  const blocked = { ok: false as const, reason: "tools_access" as const };

  it("says nothing for a usable card and one neutral line for someone else's", () => {
    expect(assistantCardStatusText({ kind: "ready" }, { ok: true })).toBeNull();
    expect(assistantCardStatusText({ kind: "unavailable" }, blocked)).toBe("Not available to you");
    expect(assistantCardStatusText({ kind: "archived" }, { ok: false, reason: "archived" })).toBe("Archived");
  });

  it("names the owner's missing dependencies, and counts them from three upwards", () => {
    expect(assistantCardStatusText({ count: 1, kind: "attention", names: ["Jira"] }, blocked))
      .toBe("Needs attention: Jira isn't available");
    expect(assistantCardStatusText({ count: 2, kind: "attention", names: ["Jira", "GitHub"] }, blocked))
      .toBe("Needs attention: Jira, GitHub aren't available");
    expect(assistantCardStatusText({ count: 3, kind: "attention", names: ["Jira", "GitHub", "GitLab"] }, blocked))
      .toBe("3 dependencies unavailable");
    expect(assistantCardStatusText({ count: 1, kind: "attention", names: [] }, { ok: false, reason: "skills_access" }))
      .toBe("Needs attention: a linked Skill isn't available");
  });
});

describe("assistantRowDeviationCopy", () => {
  it("marks the fixed row that blocks the Assistant, with names only for the owner", () => {
    const availability = { dependencies: [{ kind: "mcp" as const, name: "Jira" }], ok: false as const, reason: "tools_access" as const };
    expect(assistantRowDeviationCopy({ availability, owned: true, row: "tools", rowAvailability: {} }))
      .toBe("Not available to you: Jira");
    expect(assistantRowDeviationCopy({ availability, owned: false, row: "tools", rowAvailability: {} }))
      .toBe("Not available to you");
    expect(assistantRowDeviationCopy({ availability, owned: true, row: "model", rowAvailability: {} })).toBeNull();
  });

  it("tells an adjustable row falls back to the viewer's default", () => {
    const rowAvailability = { search: { dependencies: [{ kind: "search" as const, name: "News" }], reason: "search_access" as const } };
    expect(assistantRowDeviationCopy({ availability: { ok: true }, owned: true, row: "search", rowAvailability }))
      .toBe("News isn't available to you. Your default will be used.");
    expect(assistantRowDeviationCopy({ availability: { ok: true }, owned: false, row: "search", rowAvailability }))
      .toBe("Your default will be used");
  });
});
