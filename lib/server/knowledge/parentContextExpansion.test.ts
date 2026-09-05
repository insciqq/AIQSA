import { describe, expect, it } from "vitest";
import { knowledgeEvidenceOccurrenceKeyV1 } from "./evidenceOccurrence";
import {
  assembleKnowledgeParentExpansions,
  decodeKnowledgeParentExpansionEvidence,
  fitKnowledgeParentExpansionsToByteBudget,
  knowledgeParentExpansionEvidence,
  renderKnowledgeParentExpansionProjectionV1,
  renderKnowledgeParentExpansionUnits,
  usableKnowledgeParentContextWindow,
  type KnowledgeParentContextRow,
  type KnowledgeParentExpansionPrimary
} from "./parentContextExpansion";
import { KNOWLEDGE_PARENT_CONTEXT_MAX_TOKENS } from "./chunking";
import { createKnowledgeTableDocumentContext } from "./documentContext";
import type {
  KnowledgeParentExpansionUnit,
  KnowledgePassageLayoutKind
} from "./retrievalTypes";

function hash(seed: string): string {
  return seed.repeat(64).slice(0, 64).replace(/[^0-9a-f]/gu, "a");
}

function windowRow(input: Readonly<{
  documentContext?: KnowledgeParentContextRow["documentContext"];
  id: string;
  layoutKind?: KnowledgePassageLayoutKind;
  ordinal: number;
  page?: number;
  sectionId?: string;
  text?: string;
}>): KnowledgeParentContextRow {
  return {
    contentHash: hash(input.id.replace(/[^0-9a-f]/gu, "e").slice(-1) || "e"),
    documentContext: input.documentContext ?? null,
    id: input.id,
    layoutKind: input.layoutKind ?? "body",
    ordinal: input.ordinal,
    page: input.page ?? 1,
    sectionId: input.sectionId ?? "section-1",
    text: input.text ?? `Passage ${input.ordinal}.`
  };
}

function primary(input: Readonly<{
  chunkId: string;
  chunkIndex: number;
  documentContext?: KnowledgeParentExpansionPrimary["documentContext"];
  layoutKind?: KnowledgePassageLayoutKind;
  legacyUnits?: readonly KnowledgeParentExpansionUnit[];
  page?: number;
  sectionId?: string | null;
  sourceArtifactId?: string;
  text?: string;
}>): KnowledgeParentExpansionPrimary {
  return {
    chunkId: input.chunkId,
    chunkIndex: input.chunkIndex,
    contentHash: hash(input.chunkId.replace(/[^0-9a-f]/gu, "f").slice(-1) || "f"),
    ...(input.documentContext !== undefined ? { documentContext: input.documentContext } : {}),
    documentId: "source-1",
    documentVersionId: "version-1",
    layoutKind: input.layoutKind ?? "body",
    legacyUnits: input.legacyUnits ?? [],
    page: input.page ?? 1,
    sectionId: input.sectionId === undefined ? "section-1" : input.sectionId,
    sourceArtifactId: input.sourceArtifactId ?? "artifact-1",
    text: input.text ?? `Passage ${input.chunkIndex}.`
  };
}

function unit(input: Readonly<{
  chunkId: string;
  chunkIndex: number;
  label?: string;
  origin?: KnowledgeParentExpansionUnit["origin"];
  position?: KnowledgeParentExpansionUnit["position"];
  rank?: number;
  text?: string;
  tokens?: number;
}>): KnowledgeParentExpansionUnit {
  return {
    chunkId: input.chunkId,
    chunkIndex: input.chunkIndex,
    contentHash: hash(input.chunkId.replace(/[^0-9a-f]/gu, "d").slice(-1) || "d"),
    label: input.label ?? "Previous same-Source context",
    origin: input.origin ?? "section",
    position: input.position ?? "previous",
    rank: input.rank ?? 0,
    text: input.text ?? `Legacy ${input.chunkId}.`,
    tokens: input.tokens ?? 10
  };
}

const countTokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));

function sectionWindow(anchorOrdinal: number, radius: number): KnowledgeParentContextRow[] {
  const rows: KnowledgeParentContextRow[] = [];
  for (let ordinal = anchorOrdinal - radius; ordinal <= anchorOrdinal + radius; ordinal += 1) {
    if (ordinal < 0) continue;
    rows.push(windowRow({ id: `chunk-${ordinal}`, ordinal }));
  }
  return rows;
}

describe("parent context expansion assembly", () => {
  it("builds a centered same-section window around a body hit", () => {
    const hit = primary({ chunkId: "chunk-10", chunkIndex: 10 });
    const expansions = assembleKnowledgeParentExpansions({
      countTokens,
      excludedOccurrenceKeys: new Set(),
      primaries: [hit],
      windows: new Map([["chunk-10", sectionWindow(10, 3)]])
    });
    const expansion = expansions.get("chunk-10")!;
    expect(expansion.state).toBe("expanded");
    expect(expansion.units.map((entry) => entry.chunkIndex).sort((a, b) => a - b))
      .toEqual([7, 8, 9, 11, 12, 13]);
    expect(expansion.units.every((entry) => entry.origin === "section")).toBe(true);
    // The atomic hit itself never becomes context.
    expect(expansion.units.some((entry) => entry.chunkId === "chunk-10")).toBe(false);
    const rendered = renderKnowledgeParentExpansionUnits(expansion.units);
    expect(rendered).toBe([
      "Previous same-Source context:\nPassage 7.\nPassage 8.\nPassage 9.",
      "Next same-Source context:\nPassage 11.\nPassage 12.\nPassage 13."
    ].join("\n\n"));
  });

  it("respects the canonical section boundary and rejects cross-section windows", () => {
    const hit = primary({ chunkId: "chunk-10", chunkIndex: 10 });
    const crossSection = [
      windowRow({ id: "chunk-9", ordinal: 9, sectionId: "section-2" }),
      windowRow({ id: "chunk-10", ordinal: 10 }),
      windowRow({ id: "chunk-11", ordinal: 11 })
    ];
    expect(usableKnowledgeParentContextWindow(crossSection, hit)).toBeNull();
    const expansions = assembleKnowledgeParentExpansions({
      countTokens,
      excludedOccurrenceKeys: new Set(),
      primaries: [hit],
      windows: new Map([["chunk-10", crossSection]])
    });
    const expansion = expansions.get("chunk-10")!;
    expect(expansion.state).toBe("degraded");
    expect(expansion.reason).toBe("parent_context_window_unavailable");
    expect(expansion.units).toEqual([]);
  });

  it("stops extending a side at a non-body row instead of jumping the gap", () => {
    const hit = primary({ chunkId: "chunk-10", chunkIndex: 10 });
    const rows = [
      windowRow({ id: "chunk-7", ordinal: 7 }),
      windowRow({ id: "chunk-8", layoutKind: "table_ambiguous", ordinal: 8 }),
      windowRow({ id: "chunk-9", ordinal: 9 }),
      windowRow({ id: "chunk-10", ordinal: 10 }),
      windowRow({ id: "chunk-11", ordinal: 11 })
    ];
    const expansions = assembleKnowledgeParentExpansions({
      countTokens,
      excludedOccurrenceKeys: new Set(),
      primaries: [hit],
      windows: new Map([["chunk-10", rows]])
    });
    const kept = expansions.get("chunk-10")!.units.map((entry) => entry.chunkId).sort();
    expect(kept).toEqual(["chunk-11", "chunk-9"]);
  });

  it("bridges a short structural label to two immediately following headerless fragments", () => {
    const fragmented = createKnowledgeTableDocumentContext({
      blockId: "fragment-1",
      cells: [{ columnEnd: 0, columnStart: 0, text: "p(pc) != jump" }],
      headerLineage: [],
      rowIndex: 0
    });
    expect(fragmented.ambiguityReasons).toContain("missing_header");
    const hit = primary({
      chunkId: "chunk-10",
      chunkIndex: 10,
      text: "(Rule:NoSpec-epsilon)"
    });
    const rows = [
      windowRow({ id: "chunk-10", ordinal: 10, text: "(Rule:NoSpec-epsilon)" }),
      windowRow({
        documentContext: fragmented,
        id: "chunk-11",
        layoutKind: "table_row",
        ordinal: 11,
        text: "p(pc) != jump"
      }),
      windowRow({
        documentContext: fragmented,
        id: "chunk-12",
        layoutKind: "table_row",
        ordinal: 12,
        text: "state -> state-prime"
      }),
      windowRow({ id: "chunk-13", ordinal: 13, text: "(Rule:Next)" })
    ];

    const expansion = assembleKnowledgeParentExpansions({
      countTokens,
      excludedOccurrenceKeys: new Set(),
      primaries: [hit],
      windows: new Map([["chunk-10", rows]])
    }).get("chunk-10")!;

    expect(expansion.units.map((entry) => entry.chunkId)).toEqual(["chunk-11", "chunk-12"]);
    expect(renderKnowledgeParentExpansionUnits(expansion.units)).toBe(
      "Next same-Source context:\np(pc) != jump\nstate -> state-prime"
    );
  });

  it("does not bridge ordinary prose or a headerless fragment on another page", () => {
    const fragmented = createKnowledgeTableDocumentContext({
      blockId: "fragment-1",
      cells: [{ columnEnd: 0, columnStart: 0, text: "value" }],
      headerLineage: [],
      rowIndex: 0
    });
    const longProse = "x".repeat(257);
    const cases = [
      {
        hit: primary({ chunkId: "long-10", chunkIndex: 10, text: longProse }),
        rows: [
          windowRow({ id: "long-10", ordinal: 10, text: longProse }),
          windowRow({
            documentContext: fragmented,
            id: "long-11",
            layoutKind: "table_row",
            ordinal: 11
          })
        ]
      },
      {
        hit: primary({ chunkId: "page-10", chunkIndex: 10, page: 1, text: "Rule label" }),
        rows: [
          windowRow({ id: "page-10", ordinal: 10, page: 1, text: "Rule label" }),
          windowRow({
            documentContext: fragmented,
            id: "page-11",
            layoutKind: "table_row",
            ordinal: 11,
            page: 2
          })
        ]
      }
    ];

    for (const testCase of cases) {
      const expansion = assembleKnowledgeParentExpansions({
        countTokens,
        excludedOccurrenceKeys: new Set(),
        primaries: [testCase.hit],
        windows: new Map([[testCase.hit.chunkId, testCase.rows]])
      }).get(testCase.hit.chunkId)!;
      expect(expansion.units).toEqual([]);
    }
  });

  it("enforces the 900-model-token cap for one evidence group", () => {
    const hit = primary({ chunkId: "chunk-10", chunkIndex: 10 });
    const bigText = "x".repeat(400 * 4);
    const rows = sectionWindow(10, 4).map((row) =>
      row.id === "chunk-10" ? row : { ...row, text: bigText });
    const expansions = assembleKnowledgeParentExpansions({
      countTokens,
      excludedOccurrenceKeys: new Set(),
      primaries: [hit],
      windows: new Map([["chunk-10", rows]])
    });
    const expansion = expansions.get("chunk-10")!;
    const total = countTokens(renderKnowledgeParentExpansionUnits(expansion.units));
    expect(expansion.units).toHaveLength(2);
    expect(total).toBeLessThanOrEqual(KNOWLEDGE_PARENT_CONTEXT_MAX_TOKENS);
  });

  it("includes provider-visible labels and separators in the group token cap", () => {
    const hit = primary({ chunkId: "chunk-10", chunkIndex: 10 });
    const expansions = assembleKnowledgeParentExpansions({
      countTokens: (text) => text.length,
      excludedOccurrenceKeys: new Set(),
      maxTokensPerGroup: 10,
      primaries: [hit],
      windows: new Map([["chunk-10", [
        windowRow({ id: "chunk-10", ordinal: 10 }),
        windowRow({ id: "chunk-11", ordinal: 11, text: "short" })
      ]]])
    });

    // The raw passage fits (5 <= 10), but its rendered label does not.
    expect(expansions.get("chunk-10")!.units).toEqual([]);
  });

  it("also caps oversized pre-existing context and drops trailing whole units", () => {
    const hit = primary({
      chunkId: "chunk-10",
      chunkIndex: 10,
      legacyUnits: [
        unit({
          chunkId: "legacy-1",
          chunkIndex: 9,
          rank: 0,
          text: "x".repeat(2_000),
          tokens: 500
        }),
        unit({
          chunkId: "legacy-2",
          chunkIndex: 11,
          position: "next",
          rank: 1,
          text: "y".repeat(2_000),
          tokens: 500
        })
      ],
      sectionId: null
    });
    const expansions = assembleKnowledgeParentExpansions({
      countTokens,
      excludedOccurrenceKeys: new Set(),
      primaries: [hit],
      windows: new Map()
    });
    const expansion = expansions.get("chunk-10")!;
    expect(expansion.state).toBe("legacy");
    expect(expansion.units.map((entry) => entry.chunkId)).toEqual(["legacy-1"]);
  });

  it("merges overlapping windows so the same text never ships twice", () => {
    const first = primary({ chunkId: "chunk-10", chunkIndex: 10 });
    const second = primary({ chunkId: "chunk-12", chunkIndex: 12 });
    const rows = sectionWindow(11, 4);
    const windows = new Map([
      ["chunk-10", rows.filter((row) => Math.abs(row.ordinal - 10) <= 3)],
      ["chunk-12", rows.filter((row) => Math.abs(row.ordinal - 12) <= 3)]
    ]);
    const expansions = assembleKnowledgeParentExpansions({
      countTokens,
      excludedOccurrenceKeys: new Set(),
      primaries: [first, second],
      windows
    });
    const firstUnits = expansions.get("chunk-10")!.units;
    const secondUnits = expansions.get("chunk-12")!.units;
    const shipped = [...firstUnits, ...secondUnits].map((entry) => entry.chunkId);
    expect(new Set(shipped).size).toBe(shipped.length);
    // Both atomic evidence handles survive the merge with their own groups.
    expect(expansions.has("chunk-10")).toBe(true);
    expect(expansions.has("chunk-12")).toBe(true);
    // Neither primary ships the other primary as context.
    expect(shipped).not.toContain("chunk-10");
    expect(shipped).not.toContain("chunk-12");
  });

  it("keeps table mechanics and adds only bounded adjacent explanatory body context", () => {
    const table = createKnowledgeTableDocumentContext({
      blockId: "block-1",
      cells: [
        { columnEnd: 0, columnStart: 0, text: "Alpha" },
        { columnEnd: 1, columnStart: 1, text: "1" }
      ],
      headerLineage: [{ columnEnd: 1, columnStart: 0, rowIndex: 0, text: "Name" }],
      rowIndex: 3
    });
    const neighborRowContext = createKnowledgeTableDocumentContext({
      blockId: "block-1",
      cells: [
        { columnEnd: 0, columnStart: 0, text: "Beta" },
        { columnEnd: 1, columnStart: 1, text: "2" }
      ],
      headerLineage: [{ columnEnd: 1, columnStart: 0, rowIndex: 0, text: "Name" }],
      rowIndex: 4
    });
    const legacyRow = unit({
      chunkId: "chunk-11",
      chunkIndex: 11,
      label: "Next complete row in the same table",
      origin: "table",
      position: "next",
      rank: 0,
      text: "Name\tValue\nBeta\t2",
      tokens: 8
    });
    const hit = primary({
      chunkId: "chunk-10",
      chunkIndex: 10,
      documentContext: table,
      layoutKind: "table_row",
      legacyUnits: [legacyRow]
    });
    const rows = [
      windowRow({ id: "chunk-7", ordinal: 7, text: "Unrelated earlier paragraph." }),
      windowRow({ id: "chunk-8", ordinal: 8, text: "Table 3: quarterly totals." }),
      windowRow({
        documentContext: neighborRowContext,
        id: "chunk-9",
        layoutKind: "table_row",
        ordinal: 9
      }),
      windowRow({ documentContext: table, id: "chunk-10", layoutKind: "table_row", ordinal: 10 }),
      windowRow({
        documentContext: neighborRowContext,
        id: "chunk-11",
        layoutKind: "table_row",
        ordinal: 11
      }),
      windowRow({ id: "chunk-12", ordinal: 12, text: "Explanatory note after the table." })
    ];
    const expansions = assembleKnowledgeParentExpansions({
      countTokens,
      excludedOccurrenceKeys: new Set(),
      primaries: [hit],
      windows: new Map([["chunk-10", rows]])
    });
    const expansion = expansions.get("chunk-10")!;
    const ids = expansion.units.map((entry) => entry.chunkId);
    // The legacy complete-row segment survives; window rows of the same table
    // are never re-shipped as section context (no whole-table dumps).
    expect(ids).toContain("chunk-11");
    expect(ids.filter((id) => id === "chunk-11")).toHaveLength(1);
    expect(ids).not.toContain("chunk-9");
    // Exactly one adjacent explanatory body passage per side.
    expect(ids).toContain("chunk-8");
    expect(ids).toContain("chunk-12");
    expect(ids).not.toContain("chunk-7");
    const rendered = renderKnowledgeParentExpansionUnits(expansion.units);
    expect(rendered).toContain("Next complete row in the same table:\nName\tValue\nBeta\t2");
    expect(rendered.indexOf("Previous same-Source context:\nTable 3: quarterly totals."))
      .toBe(0);
  });

  it("never mixes a different form group into field evidence context", () => {
    const hit = primary({
      chunkId: "chunk-10",
      chunkIndex: 10,
      documentContext: {
        ambiguityReasons: [],
        locator: {
          fieldGroupId: "group-a",
          kind: "field_pair",
          labelCellId: 1,
          valueCellId: 2
        },
        observations: [],
        version: 1
      },
      layoutKind: "field_pair"
    });
    const rows = [
      windowRow({ id: "chunk-8", ordinal: 8, text: "Form section intro." }),
      windowRow({
        documentContext: {
          ambiguityReasons: [],
          locator: {
            fieldGroupId: "group-a",
            kind: "field_pair",
            labelCellId: 3,
            valueCellId: 4
          },
          observations: [],
          version: 1
        },
        id: "chunk-9",
        layoutKind: "field_pair",
        ordinal: 9
      }),
      windowRow({ documentContext: hit.documentContext!, id: "chunk-10", layoutKind: "field_pair", ordinal: 10 }),
      windowRow({
        documentContext: {
          ambiguityReasons: [],
          locator: {
            fieldGroupId: "group-b",
            kind: "field_pair",
            labelCellId: 5,
            valueCellId: 6
          },
          observations: [],
          version: 1
        },
        id: "chunk-11",
        layoutKind: "field_pair",
        ordinal: 11
      }),
      windowRow({ id: "chunk-12", ordinal: 12, text: "Note after the other group." })
    ];
    const expansions = assembleKnowledgeParentExpansions({
      countTokens,
      excludedOccurrenceKeys: new Set(),
      primaries: [hit],
      windows: new Map([["chunk-10", rows]])
    });
    const ids = expansions.get("chunk-10")!.units.map((entry) => entry.chunkId);
    // Same-group neighbors stay with the legacy mechanics; the different form
    // group blocks the next side entirely, so its trailing note never ships.
    expect(ids).toEqual(["chunk-8"]);
  });

  it("degrades to the atomic evidence with a content-free reason when loading failed", () => {
    const legacy = unit({ chunkId: "legacy-1", chunkIndex: 9 });
    const hit = primary({ chunkId: "chunk-10", chunkIndex: 10, legacyUnits: [legacy] });
    const expansions = assembleKnowledgeParentExpansions({
      countTokens,
      excludedOccurrenceKeys: new Set(),
      loadFailureCode: "parent_context_load_failed",
      primaries: [hit],
      windows: new Map()
    });
    const expansion = expansions.get("chunk-10")!;
    expect(expansion.state).toBe("degraded");
    expect(expansion.reason).toBe("parent_context_load_failed");
    expect(expansion.units).toEqual([legacy]);
  });

  it("preserves equal-text neighboring rows for two independently admitted Sources", () => {
    const alpha = primary({ chunkId: "alpha-0", chunkIndex: 0, sourceArtifactId: "artifact-alpha" });
    const beta = { ...primary({ chunkId: "beta-0", chunkIndex: 0, sourceArtifactId: "artifact-beta" }),
      documentId: "source-beta", documentVersionId: "version-beta" };
    const windows = new Map([alpha, beta].map((hit) => [hit.chunkId,
      [0, 1, 2].map((ordinal) => ({ ...windowRow({ id: hit.chunkId.replace("0", String(ordinal)), ordinal }),
        contentHash: "a".repeat(64), text: "The approved value is 19." }))]));
    const expansion = assembleKnowledgeParentExpansions({ countTokens, excludedOccurrenceKeys: new Set(),
      primaries: [alpha, beta], windows });
    expect(expansion.get(alpha.chunkId)?.units.map(({ chunkId }) => chunkId)).toEqual(["alpha-1", "alpha-2"]);
    expect(expansion.get(beta.chunkId)?.units.map(({ chunkId }) => chunkId)).toEqual(["beta-1", "beta-2"]);
  });

  it("excludes prior-round occurrences from every new window unit", () => {
    const hit = primary({ chunkId: "chunk-10", chunkIndex: 10 });
    const rows = sectionWindow(10, 2);
    const excluded = knowledgeEvidenceOccurrenceKeyV1({ ...hit, chunkId: "chunk-9" });
    const expansions = assembleKnowledgeParentExpansions({
      countTokens,
      excludedOccurrenceKeys: new Set([excluded]),
      primaries: [hit],
      windows: new Map([["chunk-10", rows]])
    });
    const ids = expansions.get("chunk-10")!.units.map((entry) => entry.chunkId);
    expect(ids).not.toContain("chunk-9");
    expect(ids).not.toContain("chunk-8");
    expect(ids).toEqual(expect.arrayContaining(["chunk-11", "chunk-12"]));
  });
});

describe("parent context expansion byte-budget fitting", () => {
  const bigUnit = (chunkId: string, chunkIndex: number, position: "next" | "previous", bytes: number, rank: number) =>
    unit({ chunkId, chunkIndex, position, rank, text: "y".repeat(bytes), tokens: bytes / 4 });

  it("shrinks with per-source round-robin fairness before dropping any expansion", () => {
    const fitted = fitKnowledgeParentExpansionsToByteBudget({
      entries: [{
        key: "first",
        sourceKey: "source-1",
        units: [
          bigUnit("a-1", 9, "previous", 15_000, 0),
          bigUnit("a-2", 11, "next", 15_000, 1)
        ]
      }, {
        key: "second",
        sourceKey: "source-2",
        units: [bigUnit("b-1", 21, "previous", 15_000, 0)]
      }],
      maximumBytes: 32_000
    });
    // Each primary keeps one expansion slot before any primary keeps two.
    expect(fitted.get("first")!.units.map((entry) => entry.chunkId)).toEqual(["a-1"]);
    expect(fitted.get("second")!.units.map((entry) => entry.chunkId)).toEqual(["b-1"]);
  });

  it("drops the least relevant expansion entirely only after shrinking", () => {
    const fitted = fitKnowledgeParentExpansionsToByteBudget({
      entries: [{
        key: "first",
        sourceKey: "source-1",
        units: [bigUnit("a-1", 9, "previous", 20_000, 0)]
      }, {
        key: "second",
        sourceKey: "source-2",
        units: [bigUnit("b-1", 21, "previous", 20_000, 0)]
      }],
      maximumBytes: 21_000
    });
    expect(fitted.get("first")!.units).toHaveLength(1);
    expect(fitted.get("second")!.units).toHaveLength(0);
    expect(fitted.get("second")!.text).toBe("");
  });

  it("keeps everything when the budget is generous", () => {
    const units = [
      bigUnit("a-1", 9, "previous", 100, 0),
      bigUnit("a-2", 11, "next", 100, 1)
    ];
    const fitted = fitKnowledgeParentExpansionsToByteBudget({
      entries: [{ key: "first", sourceKey: "source-1", units }],
      maximumBytes: 10_000
    });
    expect(fitted.get("first")!.units).toHaveLength(2);
    expect(fitted.get("first")!.text)
      .toBe(renderKnowledgeParentExpansionUnits(units));
  });
});

describe("parent expansion evidence decoding", () => {
  it("persists injection-safe source positions over the rendered context", () => {
    const units = [
      unit({
        chunkId: "chunk-11",
        chunkIndex: 11,
        label: "Next same-Source context",
        position: "next",
        text: "After the focal passage."
      }),
      unit({
        chunkId: "chunk-9",
        chunkIndex: 9,
        position: "previous",
        text: "Before the focal passage."
      })
    ];
    const rendered = renderKnowledgeParentExpansionProjectionV1(units);
    const evidence = knowledgeParentExpansionEvidence({
      state: "expanded",
      units
    }, units);

    expect(evidence.contextOrder?.segments.map((segment) => ({
      position: segment.position,
      sourceOrdinal: segment.sourceOrdinal,
      text: rendered.text.slice(segment.start, segment.end)
    }))).toEqual([{
      position: "previous",
      sourceOrdinal: 9,
      text: "Before the focal passage."
    }, {
      position: "next",
      sourceOrdinal: 11,
      text: "After the focal passage."
    }]);
    expect(decodeKnowledgeParentExpansionEvidence(evidence)).toEqual(evidence);
  });

  it("round-trips content-free facts and rejects malformed values", () => {
    expect(decodeKnowledgeParentExpansionEvidence({
      passageCount: 3,
      state: "expanded",
      tokens: 640
    })).toEqual({ passageCount: 3, state: "expanded", tokens: 640 });
    expect(decodeKnowledgeParentExpansionEvidence({
      passageCount: 0,
      reason: "parent_context_load_failed",
      state: "degraded",
      tokens: 0
    })).toEqual({
      passageCount: 0,
      reason: "parent_context_load_failed",
      state: "degraded",
      tokens: 0
    });
    expect(decodeKnowledgeParentExpansionEvidence(null)).toBeNull();
    expect(decodeKnowledgeParentExpansionEvidence({
      passageCount: -1,
      state: "expanded",
      tokens: 0
    })).toBeNull();
    expect(decodeKnowledgeParentExpansionEvidence({
      passageCount: 1,
      state: "invented",
      tokens: 1
    })).toBeNull();
    expect(decodeKnowledgeParentExpansionEvidence({
      passageCount: 1,
      reason: "",
      state: "degraded",
      tokens: 1
    })).toBeNull();
  });
});
