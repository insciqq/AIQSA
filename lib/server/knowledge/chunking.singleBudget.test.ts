import { describe, expect, it } from "vitest";
import type { ParsedDocumentBlock } from "../parsing";
import { finalizeParsedDocument } from "../parsing/assessment";
import {
  chunkKnowledgeDocument,
  KNOWLEDGE_CHUNK_MAX_TOKENS,
  KNOWLEDGE_CHUNK_OVERLAP_TOKENS
} from "./chunking";
import { KNOWLEDGE_CHUNKING_PROFILE_VERSION } from "./indexProfile";
import { encodeKnowledgeNormalizedDocument } from "./normalizedDocument";
import { requireKnowledgeTokenCounter } from "./tokenizer/knowledgeTokenCounter";

const counter = requireKnowledgeTokenCounter("qwen/qwen3-embedding-8b");
const config = {
  maxChunksPerDocument: 100,
  maxFileBytes: 100_000,
  maxNormalizedChars: 100_000,
  maxNormalizedObjectBytes: 400_000,
  maxPages: 10
};

function block(index: number, text: string, overrides: Partial<ParsedDocumentBlock> = {}): ParsedDocumentBlock {
  return {
    assetIds: [], boundingBoxes: [], headingPath: [], index, isTable: false,
    languageHints: [], page: 1, pageEnd: 1, readingOrder: index, table: null,
    text, type: "paragraph", ...overrides
  };
}

function document(blocks: ParsedDocumentBlock[], sourceDisplayName = "manual.txt") {
  return encodeKnowledgeNormalizedDocument(finalizeParsedDocument({
    blocks, engine: "inline", mediaType: "text/plain",
    pageCount: Math.max(...blocks.map(item => item.pageEnd)), status: "complete"
  }), config, { sourceDisplayName }).document;
}

function chunks(normalized: ReturnType<typeof document>, profileVersion = KNOWLEDGE_CHUNKING_PROFILE_VERSION) {
  return chunkKnowledgeDocument({
    document: normalized, maxChunks: 100, profileVersion, tokenCounter: counter
  });
}

describe("Knowledge chunking with one embedding-input budget", () => {
  it("covers native-token prose once per window without stacking two overlaps", () => {
    const text = Array.from({ length: 55 }, (_, index) =>
      `Запись M${String(index + 1).padStart(3, "0")}: давление равно семи, клапан открыт.`
    ).join("\n");
    const normalized = document([block(0, text)]);
    const previous = chunks(normalized, 12);
    const current = chunks(normalized);

    function coverage(entries: typeof current) {
      const counts = new Uint8Array(text.length);
      let previousStart = -1;
      let previousEnd = 0;
      const overlapTokens: number[] = [];
      for (const entry of entries) {
        const start = text.indexOf(entry.text, previousStart + 1);
        expect(start).toBeGreaterThanOrEqual(0);
        const end = start + entry.text.length;
        expect(end).toBeGreaterThan(previousEnd);
        overlapTokens.push(counter.countTokens(text.slice(start, previousEnd)));
        for (let index = start; index < end; index += 1) counts[index]! += 1;
        expect(counter.countTokens(entry.embeddingText)).toBeLessThanOrEqual(KNOWLEDGE_CHUNK_MAX_TOKENS);
        expect(entry.sourceBlockIds).toEqual([normalized.blocks[0]!.id]);
        expect(entry.text.isWellFormed()).toBe(true);
        previousStart = start;
        previousEnd = end;
      }
      expect([...text].every((character, index) => /\s/u.test(character) || counts[index]! > 0)).toBe(true);
      return { maximumMultiplicity: Math.max(...counts), overlapTokens };
    }

    expect(coverage(previous).maximumMultiplicity).toBe(3);
    const result = coverage(current);
    expect(result.maximumMultiplicity).toBeLessThanOrEqual(2);
    expect(result.overlapTokens.every(tokens => tokens <= KNOWLEDGE_CHUNK_OVERLAP_TOKENS)).toBe(true);
    expect(current.every(entry => entry.contextPrefix === "manual.txt")).toBe(true);
  });

  it("reserves context before merging so two fitting paragraphs retain their boundaries", () => {
    const first = "Pressure stays stable. ".repeat(47).trim();
    const second = "Voltage stays stable. ".repeat(47).trim();
    const normalized = document([block(0, first), block(1, second)], "calibration ".repeat(40).trim());
    const entries = chunks(normalized);
    const prefix = entries[0]!.contextPrefix;

    expect(counter.countTokens(`${prefix}\n\n${first}\n\n${second}`)).toBeGreaterThan(KNOWLEDGE_CHUNK_MAX_TOKENS);
    expect(counter.countTokens(`${prefix}\n\n${first}`)).toBeLessThanOrEqual(KNOWLEDGE_CHUNK_MAX_TOKENS);
    expect(counter.countTokens(`${prefix}\n\n${second}`)).toBeLessThanOrEqual(KNOWLEDGE_CHUNK_MAX_TOKENS);
    expect(entries.map(entry => entry.text)).toEqual([first, second]);
    expect(entries.map(entry => entry.sourceBlockIds)).toEqual(normalized.blocks.map(item => [item.id]));
    expect(entries.every(entry => counter.countTokens(entry.embeddingText) <= KNOWLEDGE_CHUNK_MAX_TOKENS)).toBe(true);
  });

  it("keeps code and heading boundaries with their original page and block provenance", () => {
    const normalized = document([
      block(0, "Read the pump pressure.", { headingPath: ["Pump"] }),
      block(1, "const pressure = readSensor();", { headingPath: ["Pump"], type: "code" }),
      block(2, "Close the access hatch.", { headingPath: ["Pump"], page: 2, pageEnd: 2 }),
      block(3, "Inspect the valve seal.", { headingPath: ["Valve"], page: 2, pageEnd: 2 })
    ]);
    const entries = chunks(normalized);

    expect(entries).toHaveLength(4);
    for (const [index, entry] of entries.entries()) {
      const original = normalized.blocks[index]!;
      expect(entry.text).toBe(original.text);
      expect(entry.sourceBlockIds).toEqual([original.id]);
      expect(entry.sourceBlockStart).toBe(original.order);
      expect(entry.sourceBlockEnd).toBe(original.order);
      expect(entry.headingPath).toEqual(original.headingPath);
      expect(entry.page).toBe(original.locator.pageStart);
      expect(entry.pageEnd).toBe(original.locator.pageEnd);
    }
  });

  it("keeps a fitting source identical and fails closed when the chunk limit is too small", () => {
    const normalized = document([block(0, "Inspect the amber pump every thirty days.")]);
    expect(chunks(normalized)).toEqual(chunks(normalized, 12));

    const long = document([block(0, "Pressure stays stable. ".repeat(220).trim())]);
    expect(() => chunkKnowledgeDocument({
      document: long, maxChunks: 1,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION, tokenCounter: counter
    })).toThrowError(expect.objectContaining({ code: "knowledge_chunk_limit_exceeded" }));
  });
});
