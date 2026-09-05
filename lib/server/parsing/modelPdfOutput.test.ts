import { describe, expect, it } from "vitest";
import {
  decodeModelPdfBatchOutput,
  modelPdfPageEndMarker,
  modelPdfPageStartMarker,
  modelPdfPagesToDocument,
  MODEL_PDF_PROMPT_VERSION,
  MODEL_PDF_ROW_CONTINUATION_CELL,
  MODEL_PDF_VISUAL_DATA_PROJECTION_PROFILE_VERSION,
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
    expect(prompt).toContain(MODEL_PDF_ROW_CONTINUATION_CELL);
    expect(MODEL_PDF_PROMPT_VERSION).toBe(7);
    expect(prompt).toContain("never establish a span");
    expect(MODEL_PDF_VISUAL_DATA_PROJECTION_PROFILE_VERSION).toBe(14);
    expect(prompt).toContain("Start the record with exactly `Visual data:`");
    expect(prompt).toContain("cover every visible series");
    expect(prompt).toContain("plateaus, crossings, and stability");
    expect(modelPdfTranscriptionPrompt({
      mode: "system_model_direct_pdf",
      pageEnd: 2,
      pageStart: 1,
      promptVersion: 1
    })).not.toContain("every non-empty table cell");
    const promptV3 = modelPdfTranscriptionPrompt({
      mode: "system_model_direct_pdf",
      pageEnd: 2,
      pageStart: 1,
      promptVersion: 3
    });
    expect(promptV3).not.toContain("visibly merged cell spans multiple rows or columns");
    expect(promptV3).not.toContain(MODEL_PDF_ROW_CONTINUATION_CELL);
    expect(modelPdfTranscriptionPrompt({
      mode: "system_model_direct_pdf",
      pageEnd: 2,
      pageStart: 1,
      promptVersion: 4
    })).toContain("visibly merged cell spans multiple rows or columns");
    const historicalPrompt = modelPdfTranscriptionPrompt({
      mode: "system_model_vision",
      pageEnd: 2,
      pageStart: 1,
      promptVersion: 5
    });
    expect(historicalPrompt).toContain(
      "Do not summarize, interpret, correct, calculate, or omit content."
    );
    expect(historicalPrompt).not.toContain("Visual data:");
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

  it("preserves row-complete merged-cell transcriptions as atomic table rows", () => {
    const pages = decodeModelPdfBatchOutput({
      mode: "system_model_vision",
      pageEnd: 1,
      pageStart: 1,
      text: [
        modelPdfPageStartMarker(1),
        "Group\tField\tValue",
        "Alpha\tIdentifier\tA-1",
        "Alpha\tExpiry\t2040-01-15",
        "Beta\tIdentifier\tB-1",
        "Beta\tExpiry\t2041-02-16",
        modelPdfPageEndMarker(1)
      ].join("\n")
    });
    const document = modelPdfPagesToDocument({
      maxBlocks: 100,
      maxCharacters: 10_000,
      mode: "system_model_vision",
      pageCount: 1,
      pages
    });

    expect(document.blocks[0]?.table).toMatchObject({ columnCount: 3, rowCount: 5 });
    expect(document.blocks[0]?.table?.cells.filter(({ row }) => row === 2).map(({ text }) => text))
      .toEqual(["Alpha", "Expiry", "2040-01-15"]);
  });

  it("collapses skipped Markdown heading levels without sparse heading paths", () => {
    const pages = decodeModelPdfBatchOutput({
      mode: "system_model_vision",
      pageEnd: 1,
      pageStart: 1,
      text: [
        modelPdfPageStartMarker(1),
        "### Standalone section",
        "First paragraph",
        "##### Nested section",
        "Nested paragraph",
        "## Replacement section",
        "Replacement paragraph",
        modelPdfPageEndMarker(1)
      ].join("\n")
    });
    const document = modelPdfPagesToDocument({
      maxBlocks: 100,
      maxCharacters: 10_000,
      mode: "system_model_vision",
      pageCount: 1,
      pages
    });

    expect(document.blocks.map(({ headingPath, text }) => ({ headingPath, text }))).toEqual([
      { headingPath: [], text: "Standalone section" },
      { headingPath: ["Standalone section"], text: "First paragraph" },
      { headingPath: ["Standalone section"], text: "Nested section" },
      {
        headingPath: ["Standalone section", "Nested section"],
        text: "Nested paragraph"
      },
      { headingPath: [], text: "Replacement section" },
      { headingPath: ["Replacement section"], text: "Replacement paragraph" }
    ]);
    expect(document.blocks.every(({ headingPath }) =>
      headingPath.every((value) => typeof value === "string"))).toBe(true);
  });

  it("decodes explicit logical-record continuation cells into vertical spans", () => {
    const pages = decodeModelPdfBatchOutput({
      mode: "system_model_vision",
      pageEnd: 1,
      pageStart: 1,
      text: [
        modelPdfPageStartMarker(1),
        "Group\tField\tValue",
        "Alpha\tIdentifier\tA-1",
        `${MODEL_PDF_ROW_CONTINUATION_CELL}\tSerial\tS-2`,
        `${MODEL_PDF_ROW_CONTINUATION_CELL}\tExpiry\t2040-01-15`,
        "Beta\tIdentifier\tB-1",
        modelPdfPageEndMarker(1)
      ].join("\n")
    });
    const document = modelPdfPagesToDocument({
      maxBlocks: 100,
      maxCharacters: 10_000,
      mode: "system_model_vision",
      pageCount: 1,
      pages,
      tableContinuationMarkers: true
    });
    const table = document.blocks[0]?.table;

    expect(table).toMatchObject({ columnCount: 3, rowCount: 5 });
    expect(table?.cells.find(({ column, row }) => column === 0 && row === 1))
      .toMatchObject({ rowSpan: 3, text: "Alpha" });
    expect(table?.cells.some(({ text }) => text === MODEL_PDF_ROW_CONTINUATION_CELL)).toBe(false);
    expect(document.blocks[0]?.text).toBe([
      "Group\tField\tValue",
      "Alpha\tIdentifier\tA-1",
      "Alpha\tSerial\tS-2",
      "Alpha\tExpiry\t2040-01-15",
      "Beta\tIdentifier\tB-1"
    ].join("\n"));
  });

  it("degrades orphan continuation markers without losing valid vertical spans", () => {
    const pages = decodeModelPdfBatchOutput({
      mode: "system_model_direct_pdf",
      pageEnd: 1,
      pageStart: 1,
      text: [
        modelPdfPageStartMarker(1),
        `\tTable heading\t${MODEL_PDF_ROW_CONTINUATION_CELL}`,
        "Field A\tField B\tField C",
        `${MODEL_PDF_ROW_CONTINUATION_CELL}\tSubfield\t${MODEL_PDF_ROW_CONTINUATION_CELL}`,
        modelPdfPageEndMarker(1)
      ].join("\n")
    });

    const document = modelPdfPagesToDocument({
      maxBlocks: 100,
      maxCharacters: 10_000,
      mode: "system_model_direct_pdf",
      pageCount: 1,
      pages,
      tableContinuationMarkers: true
    });
    const table = document.blocks[0]?.table;

    expect(table?.cells.find(({ column, row }) => column === 0 && row === 1))
      .toMatchObject({ rowSpan: 2, text: "Field A" });
    expect(table?.cells.find(({ column, row }) => column === 2 && row === 1))
      .toMatchObject({ rowSpan: 2, text: "Field C" });
    expect(table?.cells.some(({ text }) => text === MODEL_PDF_ROW_CONTINUATION_CELL)).toBe(false);
    expect(document.blocks[0]?.text).toBe([
      "\tTable heading",
      "Field A\tField B\tField C",
      "Field A\tSubfield\tField C"
    ].join("\n"));
  });

  it.each([false, true])("preserves blank cells unless reproducing legacy inference (%s)", (legacyTableInference) => {
    const pages = decodeModelPdfBatchOutput({
      mode: "system_model_vision",
      pageEnd: 1,
      pageStart: 1,
      text: [
        modelPdfPageStartMarker(1),
        "Group\tField\tValue",
        "Alpha\tIdentifier\tA-1",
        "\tSerial\tS-1",
        "\tExpiry\t2040-01-15",
        "Beta\tIdentifier\tB-1",
        "\tSerial\tS-2",
        "\tExpiry\t2041-02-16",
        "Gamma\tIdentifier\tC-1",
        "\tSerial\tS-3",
        "\tExpiry\t2042-03-17",
        modelPdfPageEndMarker(1)
      ].join("\n")
    });
    const document = modelPdfPagesToDocument({
      legacyTableInference,
      maxBlocks: 100,
      maxCharacters: 10_000,
      mode: "system_model_vision",
      pageCount: 1,
      pages,
      tableContinuationMarkers: true
    });
    const table = document.blocks[0]?.table;

    expect(table?.cells.filter(({ column, rowSpan }) => column === 0 && rowSpan === 3))
      .toHaveLength(legacyTableInference ? 3 : 0);
    expect(document.blocks[0]?.text).toContain(legacyTableInference
      ? "Alpha\tExpiry\t2040-01-15" : "\n\tExpiry\t2040-01-15");
    expect(document.blocks[0]?.text).toContain(legacyTableInference
      ? "Gamma\tSerial\tS-3" : "\n\tSerial\tS-3");
  });

  it("leaves sparse rows unchanged without three repeated record groups", () => {
    const pages = decodeModelPdfBatchOutput({
      mode: "system_model_direct_pdf",
      pageEnd: 1,
      pageStart: 1,
      text: [
        modelPdfPageStartMarker(1),
        "Group\tField\tValue",
        "Alpha\tIdentifier\tA-1",
        "\tSerial\tS-1",
        "Beta\tIdentifier\tB-1",
        "\tSerial\tS-2",
        modelPdfPageEndMarker(1)
      ].join("\n")
    });
    const document = modelPdfPagesToDocument({
      maxBlocks: 100,
      maxCharacters: 10_000,
      mode: "system_model_direct_pdf",
      pageCount: 1,
      pages,
      tableContinuationMarkers: true
    });

    expect(document.blocks[0]?.table?.cells.every(({ rowSpan }) => rowSpan === 1)).toBe(true);
    expect(document.blocks[0]?.text).toContain("\n\tSerial\tS-1");
  });

  it.each([false, true])("keeps ambiguous column positions unless reproducing legacy shifts (%s)", (legacyTableInference) => {
    const pages = decodeModelPdfBatchOutput({
      mode: "system_model_vision",
      pageEnd: 1,
      pageStart: 1,
      text: [
        modelPdfPageStartMarker(1),
        "Group\tField\tValue",
        "Alpha\tIdentifier\tA-1",
        "Serial\tS-1",
        "Expiry\t2040-01-15",
        "Beta\tIdentifier\tB-1",
        "Serial\tS-2",
        "Expiry\t2041-02-16",
        "Gamma\tIdentifier\tC-1",
        "Serial\tS-3",
        "Expiry\t2042-03-17",
        modelPdfPageEndMarker(1)
      ].join("\n")
    });
    const document = modelPdfPagesToDocument({
      legacyTableInference,
      maxBlocks: 100,
      maxCharacters: 10_000,
      mode: "system_model_vision",
      pageCount: 1,
      pages,
      tableContinuationMarkers: true
    });

    expect(document.blocks[0]?.table?.cells.filter(({ column, rowSpan }) =>
      column === 0 && rowSpan === 3)).toHaveLength(legacyTableInference ? 3 : 0);
    expect(document.blocks[0]?.text).toContain(legacyTableInference
      ? "Beta\tExpiry\t2041-02-16" : "\nExpiry\t2041-02-16");
  });

  it("preserves genuine leading tabs and never continues across a blank table boundary or page", () => {
    const pages = decodeModelPdfBatchOutput({ mode: "system_model_vision", pageStart: 1, pageEnd: 2,
      text: [modelPdfPageStartMarker(1), "\tValue\tUnit", "Alpha\t19\tkg", "",
        `${MODEL_PDF_ROW_CONTINUATION_CELL}\t21\tkg`, modelPdfPageEndMarker(1),
        modelPdfPageStartMarker(2), `${MODEL_PDF_ROW_CONTINUATION_CELL}\t23\tkg`,
        "Beta\t25\tkg", modelPdfPageEndMarker(2)].join("\n") });
    expect(pages[0]!.text).toMatch(/^\tValue\tUnit/u);
    const document = modelPdfPagesToDocument({ maxBlocks: 100, maxCharacters: 10_000,
      mode: "system_model_vision", pageCount: 2, pages, tableContinuationMarkers: true });
    const tables = document.blocks.filter(({ table }) => table);
    expect(tables).toHaveLength(3);
    expect(tables.every(({ table }) => table!.cells.every(({ rowSpan }) => rowSpan === 1))).toBe(true);
    expect(tables[0]!.table?.cells.find(({ row, column }) => row === 0 && column === 0)?.text).toBe("");
    expect(tables[1]!.text).toBe("\t21\tkg");
    expect(tables[2]!.text).toBe("\t23\tkg\nBeta\t25\tkg");
    expect(tables[2]!.page).toBe(2);
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
