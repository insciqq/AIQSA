import { describe, expect, it } from "vitest";
import { assistantUnavailabilityCopy } from "./assistantAvailabilityCopy";

describe("assistantUnavailabilityCopy", () => {
  it.each([true, false])("shows Knowledge readiness and check failures without suggesting access loss (owned: %s)", (owned) => {
    expect(assistantUnavailabilityCopy({ owned, availability: { ok: false, reason: "knowledge_not_ready" } }))
      .toEqual({ headline: "Knowledge is not ready yet", explanation: "Required Knowledge has no ready documents yet. Try again when the documents are ready." });
    expect(assistantUnavailabilityCopy({ owned, availability: { ok: false, reason: "knowledge_unavailable" } }))
      .toEqual({ headline: "Knowledge is temporarily unavailable", explanation: "Required Knowledge could not be checked. Try again later or ask an administrator to check its configuration." });
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
