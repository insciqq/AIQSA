import { describe, expect, it } from "vitest";
import { visibleAnswerText } from "./visibleAnswer";

describe("visibleAnswerText", () => {
  it("keeps the answer and removes inspector/debug sections from the common template", () => {
    expect(
      visibleAnswerText(
        [
          "## Question",
          "`hi1`",
          "",
          "## Search",
          "No external search was needed.",
          "",
          "## Answer",
          "Hi! How can I help you today?",
          "",
          "## Provider Parameters",
          "- Model: not exposed",
          "",
          "## Request Preview",
          "User sent: `hi1`",
          "",
          "## Usage",
          "Token usage is not available."
        ].join("\n")
      )
    ).toBe("Hi! How can I help you today?");
  });

  it("leaves ordinary markdown answers alone", () => {
    const answer = ["## Notes", "", "- One", "- Two"].join("\n");
    expect(visibleAnswerText(answer)).toBe(answer);
  });
});
