import { describe, expect, it } from "vitest";
import { announcementExcerpt } from "./excerpt";

describe("announcement plain-text excerpts", () => {
  it("removes supported Markdown and HTML markers while retaining readable text", () => {
    expect(announcementExcerpt("# Release\n\nUse **fast** replies, _quietly_.\n- Read [the notes](https://example.com).\n![Diagram](https://example.com/image.png)\n> `safe` <b>text</b>"))
      .toBe("Release Use fast replies, quietly. Read the notes. Diagram safe text");
  });
  it("omits fences and reference destinations", () => {
    expect(announcementExcerpt("```ts\nhello()\n```\n[News][n]\n[n]: https://example.com"))
      .toBe("hello() News");
  });
  it("flattens nested blocks, task lists, tables and parenthesized link destinations", () => {
    expect(announcementExcerpt("## Release ##\n===\n> - [x] [Ready](https://example.com/a_(b))\n---\n| Feature | State |\n| :--- | ---: |\n| Search | Live |"))
      .toBe("Release Ready Feature State Search Live");
  });
  it("bounds the complete excerpt including ellipsis without splitting a surrogate pair", () => {
    expect(announcementExcerpt("x".repeat(180))).toHaveLength(180);
    expect(announcementExcerpt("x".repeat(181))).toBe(`${"x".repeat(179)}…`);
    expect(announcementExcerpt(`${"x".repeat(178)}🙂more`)).toBe(`${"x".repeat(178)}…`);
  });
});
