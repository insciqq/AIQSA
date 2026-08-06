import { describe, expect, it } from "vitest";
import {
  renderLocalPromptTemplate,
  resolveStandardChatBaseline,
  validateIanaTimeZone
} from "./promptTemplates";

describe("prompt template rendering", () => {
  it("renders local date and time placeholders while leaving the preset editable", () => {
    const rendered = renderLocalPromptTemplate(
      "You are a helpful AI assistant. Today is {local_date}, local time is {local_time}.",
      {
        locale: "en-US",
        now: new Date("2026-06-07T12:34:00Z"),
        timeZone: "UTC"
      }
    );

    expect(rendered).toBe("You are a helpful AI assistant. Today is June 7, 2026, local time is 12:34 PM UTC.");
  });
});

describe("IANA time-zone validation", () => {
  it("accepts only resolvable, bounded IANA identifiers", () => {
    expect(validateIanaTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
    expect(validateIanaTimeZone("UTC")).toBe("UTC");
    expect(validateIanaTimeZone("Invalid/Zone")).toBeNull();
    expect(validateIanaTimeZone("Bad zone!")).toBeNull();
    expect(validateIanaTimeZone(`America/${"x".repeat(64)}`)).toBeNull();
    expect(validateIanaTimeZone("  ")).toBeNull();
    expect(validateIanaTimeZone(42)).toBeNull();
    expect(validateIanaTimeZone(undefined)).toBeNull();
  });
});

describe("standard chat baseline resolution", () => {
  const now = new Date("2026-06-07T12:34:00Z");

  it("renders the code-owned template with a validated client zone", () => {
    // Literal expectation: proves the client zone shifts the rendered clock
    // (12:34Z -> 2:34 PM CEST) instead of echoing the renderer's own output.
    expect(resolveStandardChatBaseline({ now, timeZone: "Europe/Berlin" })).toEqual({
      renderedSystemPrompt:
        "You are a helpful AI assistant. Today is June 7, 2026, local time is 02:34 PM GMT+2.",
      timeZone: "Europe/Berlin",
      timeZoneSource: "client"
    });
  });

  it("records the UTC fallback for missing or unusable client zones", () => {
    for (const timeZone of [undefined, "Invalid/Zone", 7]) {
      expect(resolveStandardChatBaseline({ now, timeZone })).toEqual({
        renderedSystemPrompt:
          "You are a helpful AI assistant. Today is June 7, 2026, local time is 12:34 PM UTC.",
        timeZone: "UTC",
        timeZoneSource: "utc_fallback"
      });
    }
  });
});
