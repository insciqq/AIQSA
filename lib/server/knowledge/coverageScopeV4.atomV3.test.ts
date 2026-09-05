import { describe, expect, it } from "vitest";
import {
  knowledgeCoverageEvidenceAtomIndexV2,
  knowledgeCoverageEvidenceAtomIndexV3,
  knowledgeCoverageEvidenceFitsAtomLimitV3
} from "./coverageScopeV4";

describe("occurrence-preserving Scope atoms", () => {
  it("keeps both TSV rows and their repeated values addressable under one handle", () => {
    const evidence = [{ exactExcerpt: "A\tX\t10\nB\tX\t10", handle: "K1" }];
    const atoms = knowledgeCoverageEvidenceAtomIndexV3(evidence);
    expect(atoms.version).toBe(3);
    expect(atoms.items.map(({ id, text, occurrence }) => ({ id, text, occurrence }))).toEqual([
      { id: "A1", text: "A\tX\t10", occurrence: { end: 6, lineIndex: 0, partCount: 1, partIndex: 0,
        segmentIndex: 0, start: 0, unitId: "U1", unitKind: "table_row" } },
      { id: "A2", text: "B\tX\t10", occurrence: { end: 13, lineIndex: 1, partCount: 1, partIndex: 0,
        segmentIndex: 0, start: 7, unitId: "U2", unitKind: "table_row" } }
    ]);
    expect(knowledgeCoverageEvidenceAtomIndexV2(evidence).items.map(({ text }) => text)).toEqual(["A", "X", "10", "B"]);
  });

  it("retains equal occurrences, distinct Sources and the document date outside each row", () => {
    const row = "2040-01-01\t42\tkg";
    const exactExcerpt = `Issued 2041-02-03.\n${row}\n${row}`;
    const index = knowledgeCoverageEvidenceAtomIndexV3([
      { exactExcerpt, handle: "K1", sourceVersionNumber: 1 },
      { exactExcerpt: row, handle: "K2", sourceVersionNumber: 2 }
    ]);
    expect(index.items.map(({ text }) => text)).toEqual(["Issued 2041-02-03.", row, row, row]);
    expect(new Set(index.items.map(({ occurrence }) => occurrence.unitId)).size).toBe(4);
    expect(index.items.slice(1).map(({ handle }) => handle)).toEqual(["K1", "K1", "K2"]);
    for (const item of index.items.filter(({ handle }) => handle === "K1")) {
      expect(exactExcerpt.slice(item.occurrence.start, item.occurrence.end)).toBe(item.text);
    }
  });

  it("keeps a long Unicode row in bounded fragments with one row identity and exact offsets", () => {
    const row = `\tObject\t${"😀".repeat(650)}\t170 cm\t`;
    const index = knowledgeCoverageEvidenceAtomIndexV3([{ exactExcerpt: row, handle: "K1" }]);
    expect(index.items).toHaveLength(2);
    expect(index.items.map(({ text }) => text).join("")).toBe(row);
    expect(index.items.every(({ text }) => Array.from(text).length <= 500)).toBe(true);
    expect(index.items.map(({ occurrence }) => occurrence.unitId)).toEqual(["U1", "U1"]);
    expect(index.items.map(({ occurrence }) => occurrence.partCount)).toEqual([2, 2]);
    for (const item of index.items) expect(row.slice(item.occurrence.start, item.occurrence.end)).toBe(item.text);
  });

  it.each([1_024, 1_025])("uses the same bounded occurrence count for packing and atomization (%i rows)", (rows) => {
    const evidence = [{ exactExcerpt: Array.from({ length: rows }, () => "A\tX\t10").join("\n"), handle: "K1" }];
    expect(knowledgeCoverageEvidenceFitsAtomLimitV3(evidence)).toBe(rows <= 1_024);
    if (rows <= 1_024) expect(knowledgeCoverageEvidenceAtomIndexV3(evidence).items).toHaveLength(rows);
    else expect(() => knowledgeCoverageEvidenceAtomIndexV3(evidence)).toThrow("knowledge_coverage_atom_limit_exceeded");
  });

  it("keeps repeated narrative occurrences and marks unordered context without trusting its labels", () => {
    const index = knowledgeCoverageEvidenceAtomIndexV3([{ exactExcerpt: "A fact. A fact.",
      expandedContext: "Previous same-Source context:\nA\tX\t10\nA\tX\t10", handle: "K1" }]);
    expect(index.items.filter(({ text }) => text === "A fact.")).toHaveLength(2);
    expect(index.items.filter(({ text }) => text === "A\tX\t10")).toHaveLength(2);
    expect(index.items.slice(2).every(({ contextRole }) => contextRole === "related_context")).toBe(true);
    expect(index.items.every(({ handle }) => handle === "K1")).toBe(true);
  });
});
