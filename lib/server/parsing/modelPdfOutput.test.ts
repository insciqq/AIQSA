import { describe, expect, it } from "vitest";
import {
  decodeModelPdfBatchOutput,
  modelPdfPageEndMarker,
  modelPdfPageStartMarker,
  modelPdfPagesToDocument,
  modelPdfTranscriptionPrompt
} from "./modelPdfOutput";

function output(): string {
  return [
    modelPdfPageStartMarker(1),
    "# Results",
    "Metric\tValue\tUnit",
    "Widget\t42\titems",
    modelPdfPageEndMarker(1),
    modelPdfPageStartMarker(2),
    "| Date | Value |",
    "| --- | --- |",
    "| 2040-01-15 | 84 |",
    modelPdfPageEndMarker(2)
  ].join("\n");
}

describe("model PDF transcription contract", () => {
  it("uses deterministic page markers and preserves TSV and Markdown table cells", () => {
    const prompt = modelPdfTranscriptionPrompt({
      mode: "system_model_direct_pdf",
      pageEnd: 2,
      pageStart: 1
    });
    expect(prompt).toContain(modelPdfPageStartMarker(2));
    expect(prompt).toContain("every non-empty table cell");
    expect(modelPdfTranscriptionPrompt({
      mode: "system_model_direct_pdf",
      pageEnd: 2,
      pageStart: 1,
      promptVersion: 1
    })).not.toContain("every non-empty table cell");
    const pages = decodeModelPdfBatchOutput({
      mode: "system_model_direct_pdf",
      pageEnd: 2,
      pageStart: 1,
      text: output()
    });
    const document = modelPdfPagesToDocument({
      maxBlocks: 100,
      maxCharacters: 10_000,
      mode: "system_model_direct_pdf",
      pageCount: 2,
      pages
    });
    expect(document.blocks.filter(({ isTable }) => isTable)).toHaveLength(2);
    expect(document.blocks[1]?.table?.cells.map(({ text }) => text)).toEqual([
      "Metric", "Value", "Unit", "Widget", "42", "items"
    ]);
    expect(document.blocks[2]?.table?.cells.map(({ text }) => text)).toEqual([
      "Date", "Value", "2040-01-15", "84"
    ]);
  });

  it("rejects prose outside the exact page contract", () => {
    expect(() => decodeModelPdfBatchOutput({
      mode: "system_model_vision",
      pageEnd: 2,
      pageStart: 1,
      text: `Here you go\n${output()}`
    })).toThrowError(expect.objectContaining({ code: "parser_invalid_output" }));
  });

  it("accepts one exact outer code fence without weakening the page contract", () => {
    expect(decodeModelPdfBatchOutput({
      mode: "system_model_direct_pdf",
      pageEnd: 2,
      pageStart: 1,
      text: `\`\`\`text\n${output()}\n\`\`\``
    })).toHaveLength(2);
    expect(() => decodeModelPdfBatchOutput({
      mode: "system_model_direct_pdf",
      pageEnd: 2,
      pageStart: 1,
      text: `Explanation\n\`\`\`text\n${output()}\n\`\`\``
    })).toThrowError(expect.objectContaining({ code: "parser_invalid_output" }));
  });
});
