import { describe, expect, it } from "vitest";
import { finalizeParsedDocument } from "../parsing/assessment";
import type { ParsedBoundingBox, ParsedDocumentBlock } from "../parsing";
import { chunkKnowledgeDocument } from "./chunking";
import { KNOWLEDGE_CHUNKING_PROFILE_VERSION } from "./indexProfile";
import { withLayoutAwareInlineReferences } from "./layoutInlineReferences";
import { encodeKnowledgeNormalizedDocument } from "./normalizedDocument";
import { KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER } from "./tokenizer/knowledgeTokenCounter";

const config = {
  maxChunksPerDocument: 100,
  maxFileBytes: 1_000_000,
  maxNormalizedChars: 1_000_000,
  maxNormalizedObjectBytes: 4_000_000,
  maxPages: 10
};

function box(
  left: number,
  right: number,
  bottom: number,
  top: number
): ParsedBoundingBox {
  return { bottom, coordinateOrigin: "bottom_left", left, page: 1, right, top };
}

function block(
  index: number,
  text: string,
  boundingBox: ParsedBoundingBox,
  type: ParsedDocumentBlock["type"] = "paragraph"
): ParsedDocumentBlock {
  return {
    assetIds: [],
    boundingBoxes: [boundingBox],
    headingPath: [],
    index,
    isTable: false,
    languageHints: ["und-Latn"],
    page: 1,
    pageEnd: 1,
    readingOrder: index,
    table: null,
    text,
    type
  };
}

function parsed() {
  return finalizeParsedDocument({
    blocks: [
      block(0, "переходит на упрощенную систему налогообложения", box(28, 416, 935, 955)),
      block(1, ":2:", box(430, 464, 929, 960)),
      block(2, "3", box(638, 645, 915, 925)),
      block(3, "года; 2 — с даты постановки на учет;", box(293, 639, 899, 918)),
      block(4, "1", box(430, 451, 850, 875)),
      block(5, "Выбранный объект", box(28, 369, 847, 873)),
      block(6, "3 — пояснение сноски", box(28, 600, 100, 118), "footnote")
    ],
    engine: "docling",
    mediaType: "application/pdf",
    pageCount: 1,
    status: "complete"
  });
}

describe("layout-aware inline references", () => {
  it("classifies only a raised marker at a punctuated line end", () => {
    const document = withLayoutAwareInlineReferences(parsed());

    expect(document.blocks.map(({ text, type }) => ({ text, type }))).toEqual([
      { text: "переходит на упрощенную систему налогообложения", type: "paragraph" },
      { text: ":2:", type: "paragraph" },
      { text: "3", type: "footnote" },
      { text: "года; 2 — с даты постановки на учет;", type: "paragraph" },
      { text: "1", type: "paragraph" },
      { text: "Выбранный объект", type: "paragraph" },
      { text: "3 — пояснение сноски", type: "footnote" }
    ]);
  });

  it("keeps the boxed value, omits the reference glyph, and isolates footnote prose", () => {
    const document = encodeKnowledgeNormalizedDocument(parsed(), config, {
      layoutAwareInlineReferences: true,
      layoutAwareTables: true,
      sourceDisplayName: "form.pdf"
    }).document;
    const chunks = chunkKnowledgeDocument({
      document,
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });

    expect(document.blocks.find((item) => item.text === "3")?.type).toBe("footnote");
    expect(chunks.map((chunk) => chunk.text).join("\n")).toContain(
      "переходит на упрощенную систему налогообложения\n\n:2:"
    );
    expect(chunks.some((chunk) => chunk.text === "3")).toBe(false);
    expect(chunks.at(-1)?.text).toBe("3 — пояснение сноски");
  });
});
