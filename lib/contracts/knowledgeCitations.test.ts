import { describe, expect, it } from "vitest";
import {
  decodeKnowledgeCitationViewerResponse,
  decodeKnowledgeSourceViewerResponse
} from "./knowledgeCitations";

function available() {
  return {
    blocks: [{
      boundingBoxes: [{
        bottom: 40,
        coordinateOrigin: "top_left",
        left: 10,
        page: 18,
        right: 90,
        top: 20
      }],
      headingPath: ["Policy", "Retrieval"],
      pageEnd: 18,
      pageStart: 18,
      relation: "target",
      table: {
        cells: [{ column: 0, columnSpan: 1, row: 0, rowSpan: 1, text: "Value" }],
        columnCount: 1,
        rowCount: 1,
        truncated: false
      },
      text: "Accepted normalized block.",
      type: "table"
    }],
    excerpt: "Accepted exact excerpt.",
    excerptTruncated: false,
    headingPath: ["Policy", "Retrieval"],
    locator: {
      boundingBoxes: [{
        bottom: 40,
        coordinateOrigin: "top_left",
        left: 10,
        page: 18,
        right: 90,
        top: 20
      }],
      pageEnd: 18,
      pageStart: 18
    },
    originalKind: "pdf",
    source: {
      baseName: "Engineering handbook",
      fileName: "retrieval-policy.pdf",
      mimeType: "application/pdf",
      name: "Retrieval policy",
      statuses: ["earlier_version", "removed"],
      versionNumber: 3
    },
    state: "available",
    visual: null,
    workbook: null
  };
}

function workbookEvidence() {
  return {
    operationSummary: "Summed Revenue over 2 matching rows.",
    ranges: [{
      cells: [
        {
          address: "B2",
          column: 1,
          display: "100",
          formula: null,
          row: 1,
          type: "number",
          value: 100
        },
        {
          address: "B3",
          column: 1,
          display: "200",
          formula: "B2*2",
          row: 2,
          type: "number",
          value: 200
        }
      ],
      range: "B2:B3",
      role: "value",
      sheet: "Sales",
      sheetIndex: 0,
      truncated: false
    }],
    result: { columns: ["sum Revenue"], rows: [[300]] },
    warnings: ["Cached formula values were used."]
  };
}

describe("Knowledge citation viewer contracts", () => {
  it("decodes bounded available citation and Source Library projections", () => {
    const citation = { ...available(), handle: "K7" };
    expect(decodeKnowledgeCitationViewerResponse({ citation })).toEqual({ citation });
    expect(decodeKnowledgeSourceViewerResponse({ source: available() })).toEqual({
      source: available()
    });
  });

  it("allows a metadata-free deletion tombstone and rejects leaked fields", () => {
    expect(decodeKnowledgeCitationViewerResponse({
      citation: { handle: "K12.1", state: "deleted" }
    })).toEqual({ citation: { handle: "K12.1", state: "deleted" } });
    expect(decodeKnowledgeCitationViewerResponse({
      citation: { fileName: "leak.pdf", handle: "K12.1", state: "deleted" }
    })).toBeNull();
  });

  it("decodes bounded workbook evidence and rejects malformed ranges", () => {
    const citation = {
      ...available(),
      handle: "K1",
      workbook: workbookEvidence()
    };
    expect(decodeKnowledgeCitationViewerResponse({ citation })).toEqual({ citation });
    expect(decodeKnowledgeCitationViewerResponse({
      citation: {
        ...citation,
        workbook: {
          ...workbookEvidence(),
          ranges: [{ ...workbookEvidence().ranges[0], range: "entire sheet" }]
        }
      }
    })).toBeNull();
    expect(decodeKnowledgeCitationViewerResponse({
      citation: {
        ...citation,
        workbook: {
          ...workbookEvidence(),
          ranges: [{
            ...workbookEvidence().ranges[0],
            cells: [{ ...workbookEvidence().ranges[0]!.cells[0], address: "C2" }]
          }]
        }
      }
    })).toBeNull();
    expect(decodeKnowledgeCitationViewerResponse({
      citation: {
        ...citation,
        workbook: {
          ...workbookEvidence(),
          ranges: [{
            ...workbookEvidence().ranges[0],
            cells: [{
              ...workbookEvidence().ranges[0]!.cells[0],
              type: "number",
              value: "100"
            }]
          }]
        }
      }
    })).toBeNull();
  });

  it("rejects malformed locators, handles, source labels, and duplicate states", () => {
    expect(decodeKnowledgeCitationViewerResponse({
      citation: { ...available(), handle: "K0" }
    })).toBeNull();
    expect(decodeKnowledgeCitationViewerResponse({
      citation: {
        ...available(),
        handle: "K1",
        locator: { boundingBoxes: [], pageEnd: 1, pageStart: 2 }
      }
    })).toBeNull();
    expect(decodeKnowledgeCitationViewerResponse({
      citation: {
        ...available(),
        handle: "K1",
        source: { ...available().source, baseName: 42 }
      }
    })).toBeNull();
    expect(decodeKnowledgeCitationViewerResponse({
      citation: {
        ...available(),
        handle: "K1",
        source: {
          ...available().source,
          statuses: ["removed", "removed"]
        }
      }
    })).toBeNull();
  });
});
