import { describe, expect, it } from "vitest";
import { assistantUnavailabilityCopy } from "./assistantAvailabilityCopy";

describe("assistantUnavailabilityCopy", () => {
  it("names an owner's failing MCP dependency and offers the actionable settings route", () => {
    expect(assistantUnavailabilityCopy({
      availability: {
        dependencies: [{ kind: "mcp", name: "GitHub" }],
        ok: false,
        reason: "tools_access"
      },
      owned: true
    })).toEqual({
      action: { kind: "mcp-settings", label: "Fix in Settings…" },
      explanation: "GitHub is turned off or needs attention.",
      headline: "Needs the GitHub tools"
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
      headline: "Needs tools you cannot use"
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
      headline: "Needs MCP tools you cannot use"
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
      headline: "Needs MCP tools you cannot use"
    });
  });

  it("returns no failure copy for an available Assistant", () => {
    expect(assistantUnavailabilityCopy({ availability: { ok: true }, owned: true })).toBeNull();
  });
});
