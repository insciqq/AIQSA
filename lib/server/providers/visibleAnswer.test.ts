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

  it.each([
    [
      "README",
      [
        "# MyLib",
        "",
        "## Installation",
        "Install it.",
        "",
        "## Usage",
        "Use it.",
        "",
        "## License",
        "MIT"
      ].join("\n")
    ],
    [
      "API documentation",
      [
        "## Endpoints",
        "`GET /items`",
        "",
        "## Errors",
        "| Code | Meaning |",
        "| --- | --- |",
        "| 404 | Missing |",
        "",
        "## Rate limits",
        "Ten per minute."
      ].join("\n")
    ],
    ["FAQ", ["## Question", "Why?", "", "Because."].join("\n")]
  ])("keeps an ordinary %s answer with a structured-looking heading", (_name, answer) => {
    expect(visibleAnswerText(answer)).toBe(answer);
  });

  it.each([
    [
      "backtick",
      [
        "A shell example:",
        "",
        "```sh",
        "# Usage",
        "echo hello",
        "```",
        "",
        "The paragraph after the fence stays visible."
      ].join("\n")
    ],
    [
      "tilde",
      [
        "An API example:",
        "",
        "   ~~~~markdown",
        "## Errors",
        "Nothing failed.",
        "   ~~~~",
        "",
        "The trailing paragraph stays visible."
      ].join("\n")
    ],
    [
      "unterminated",
      ["An unfinished sample:", "", "```md", "## Request Preview", "not a real section"].join("\n")
    ]
  ])("ignores headings inside a %s fenced code block", (_name, answer) => {
    expect(visibleAnswerText(answer)).toBe(answer);
  });

  it("strips a recognizable debug template that has no answer heading", () => {
    expect(
      visibleAnswerText(
        [
          "Visible introduction.",
          "",
          "## Question",
          "What happened?",
          "",
          "## Request Preview",
          "private request facts",
          "",
          "## Usage",
          "- tokens: 10"
        ].join("\n")
      )
    ).toBe("Visible introduction.");
  });

  it("does not truncate an answer at a structured-looking heading inside a fence", () => {
    expect(
      visibleAnswerText(
        [
          "## Answer",
          "Use this example:",
          "",
          "```md",
          "## Usage",
          "ordinary sample content",
          "```",
          "",
          "Keep this conclusion.",
          "",
          "## Provider Parameters",
          "- hidden: true"
        ].join("\n")
      )
    ).toBe(
      [
        "Use this example:",
        "",
        "```md",
        "## Usage",
        "ordinary sample content",
        "```",
        "",
        "Keep this conclusion."
      ].join("\n")
    );
  });

  it("returns an empty visible answer for a debug-only recognizable template", () => {
    expect(
      visibleAnswerText(
        ["## Request Preview", "private request facts", "", "## Usage", "- tokens: 10"].join("\n")
      )
    ).toBe("");
  });
});
