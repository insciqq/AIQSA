import { describe, expect, it } from "vitest";
import { renderLocalPromptTemplate } from "./promptTemplates";

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
