import { describe, expect, it } from "vitest";
import { attachmentFailureIsFinal, attachmentLimitSentence, attachmentNeedsWorkspaceMessage } from "./attachmentExtraction";

describe("attachment extraction copy", () => {
  it("names a spreadsheet's numbers, and no number the browser cannot know for other documents", () => {
    expect(attachmentLimitSentence("parser_output_too_large", "report.xlsx"))
      .toBe("This spreadsheet is over the reader's limits: 250,000 filled cells, 100,000 rows and 512 columns per sheet, 64 sheets.");
    expect(attachmentLimitSentence("parser_output_too_large", "data.csv")).toContain("250,000");
    expect(attachmentLimitSentence("parser_output_too_large", "deck.pptx")).toBe("The text in this file is over the document reader's size limit.");
    expect(attachmentLimitSentence("animated_gif_not_supported", "loop.gif")).toContain("one frame");
    expect(attachmentLimitSentence("parser_unavailable", "report.xlsx")).toBeNull();
  });

  it("offers Retry only where the same file may get another outcome", () => {
    expect(["animated_gif_not_supported", "parser_output_too_large", "parser_rejected"].every(attachmentFailureIsFinal)).toBe(true);
    expect(attachmentFailureIsFinal("parser_timeout")).toBe(false);
    expect(attachmentNeedsWorkspaceMessage("parser_output_too_large", "report.xlsx")).toContain("Remove the file");
    expect(attachmentNeedsWorkspaceMessage("parser_output_too_large", "report.xlsx")).not.toContain("Retry");
    expect(attachmentNeedsWorkspaceMessage("parser_timeout", "report.xlsx")).toContain("Retry its processing");
  });

  it("fits the 240 characters a refusal may carry to the composer (`responseErrorMessageDetails`)", () => {
    for (const code of ["parser_output_too_large", "animated_gif_not_supported", "parser_timeout"]) {
      for (const fileName of ["report.xlsx", "deck.pptx", "loop.gif"]) {
        expect(attachmentNeedsWorkspaceMessage(code, fileName).length).toBeLessThanOrEqual(240);
      }
    }
  });
});
