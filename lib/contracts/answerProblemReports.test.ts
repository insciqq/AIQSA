import { describe, expect, it } from "vitest";
import {
  ANSWER_PROBLEM_REPORT_COMMENT_MAX,
  decodeAnswerProblemReportReadResponse,
  decodeAnswerProblemReportSaveResponse,
  normalizeAnswerProblemReportComment
} from "./answerProblemReports";

describe("answer problem report comment", () => {
  it("keeps line breaks and tabs, removes other control and bidi characters, and trims", () => {
    expect(normalizeAnswerProblemReportComment("  First line\r\nSecond\tline\rThird \u0007‮end\u0085  ")).toBe(
      "First line\nSecond\tline\nThird end"
    );
  });

  it("stores nothing for an absent or blank comment", () => {
    for (const value of [null, undefined, "", "  \n\t ", "\u0000‪\u0007 "]) {
      expect(normalizeAnswerProblemReportComment(value)).toBeNull();
    }
  });

  it("refuses a non-text value or one longer than the limit instead of truncating", () => {
    expect(normalizeAnswerProblemReportComment(42)).toBeUndefined();
    expect(normalizeAnswerProblemReportComment({ text: "x" })).toBeUndefined();
    expect(normalizeAnswerProblemReportComment("x".repeat(ANSWER_PROBLEM_REPORT_COMMENT_MAX))).toHaveLength(
      ANSWER_PROBLEM_REPORT_COMMENT_MAX
    );
    expect(normalizeAnswerProblemReportComment("x".repeat(ANSWER_PROBLEM_REPORT_COMMENT_MAX + 1))).toBeUndefined();
    // Whitespace around the limit is trimmed first.
    expect(normalizeAnswerProblemReportComment(` ${"x".repeat(ANSWER_PROBLEM_REPORT_COMMENT_MAX)} `)).toHaveLength(
      ANSWER_PROBLEM_REPORT_COMMENT_MAX
    );
  });

  it("replaces a lone surrogate so the stored text stays valid UTF-8", () => {
    expect(normalizeAnswerProblemReportComment("a\uD800b 😀")).toBe("a�b 😀");
  });
});

describe("answer problem report wire", () => {
  const report = { comment: "Kept", reason: "other", updatedAt: "2026-10-09T12:00:00.000Z" };

  it("decodes the read and save responses", () => {
    expect(decodeAnswerProblemReportReadResponse({ report: null })).toEqual({ report: null });
    expect(decodeAnswerProblemReportReadResponse({ report })).toEqual({ report });
    expect(decodeAnswerProblemReportSaveResponse({ outcome: "updated", report })).toEqual({ outcome: "updated", report });
  });

  it("rejects malformed responses", () => {
    expect(decodeAnswerProblemReportReadResponse({})).toBeNull();
    expect(decodeAnswerProblemReportReadResponse({ report: { ...report, reason: "rude" } })).toBeNull();
    expect(decodeAnswerProblemReportSaveResponse({ outcome: "saved", report })).toBeNull();
    expect(decodeAnswerProblemReportSaveResponse({ outcome: "created", report: { ...report, updatedAt: "later" } })).toBeNull();
  });
});
