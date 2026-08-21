import { describe, expect, it } from "vitest";
import {
  createKnowledgeFieldContextSegments,
  createKnowledgeTableDocumentContext,
  decodeKnowledgeDocumentContext,
  isCompleteKnowledgeTableRowProjectionSequence,
  KNOWLEDGE_TABLE_ROW_MAX_PROJECTIONS,
  normalizeKnowledgeObservationValue,
  normalizeKnowledgeTableHeaderPeriodV1
} from "./documentContext";

describe("Knowledge document context v1", () => {
  it("normalizes unambiguous EN/RU decimals and dates without conflating thousands", () => {
    expect(normalizeKnowledgeObservationValue("5,40")).toMatchObject({
      ambiguityReasons: [],
      kind: "number",
      normalizedValue: "5.4"
    });
    expect(normalizeKnowledgeObservationValue("5.40")).toMatchObject({
      ambiguityReasons: [],
      kind: "number",
      normalizedValue: "5.4"
    });
    expect(normalizeKnowledgeObservationValue("3,9–6,1")).toMatchObject({
      ambiguityReasons: [],
      kind: "number_range",
      normalizedValue: "3.9..6.1"
    });
    expect(normalizeKnowledgeObservationValue("20.08.2026")).toMatchObject({
      date: "2026-08-20",
      kind: "date",
      normalizedValue: "2026-08-20"
    });
    expect(normalizeKnowledgeObservationValue("2026-08-20")).toMatchObject({
      date: "2026-08-20",
      kind: "date"
    });
    expect(normalizeKnowledgeObservationValue("1,234")).toMatchObject({
      ambiguityReasons: ["ambiguous_number"],
      kind: "number",
      normalizedValue: null
    });
    expect(normalizeKnowledgeObservationValue("08/09/2026")).toMatchObject({
      ambiguityReasons: ["ambiguous_date"],
      kind: "date",
      normalizedValue: null
    });
    expect(normalizeKnowledgeObservationValue("2026-02-30")).toMatchObject({
      ambiguityReasons: ["ambiguous_date"],
      kind: "date",
      normalizedValue: null
    });
  });

  it.each([
    ["5 mg", "5", "mg"],
    ["37°C", "37", "°C"],
    ["1e3", "1000", null],
    ["1e3mg", "1000", "mg"],
    ["99мг", "99", "мг"],
    ["−5 mg", "-5", "mg"],
    ["5m²", "5", "m2"]
  ])("normalizes a recognized numeric/scientific evidence value %s", (
    rawValue,
    normalizedValue,
    unit
  ) => {
    expect(normalizeKnowledgeObservationValue(rawValue!)).toMatchObject({
      ambiguityReasons: [],
      kind: "number",
      normalizedValue,
      unit
    });
  });

  it("fails closed on an unknown attached unit", () => {
    expect(normalizeKnowledgeObservationValue("5widgets")).toMatchObject({
      ambiguityReasons: ["ambiguous_number"],
      kind: "number",
      normalizedValue: null,
      unit: null
    });
  });

  it("binds conservative year and quarter headers as effective observation periods", () => {
    expect(normalizeKnowledgeTableHeaderPeriodV1("2024")).toEqual({
      effectiveFrom: "2024-01-01",
      effectiveTo: "2024-12-31"
    });
    expect(normalizeKnowledgeTableHeaderPeriodV1("Q1 2026")).toEqual({
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-03-31"
    });
    expect(normalizeKnowledgeTableHeaderPeriodV1("2025/Q1 2026")).toBeNull();

    const context = createKnowledgeTableDocumentContext({
      blockId: "block-series",
      cells: [
        { columnEnd: 0, columnStart: 0, text: "Revenue" },
        { columnEnd: 1, columnStart: 1, text: "100" },
        { columnEnd: 2, columnStart: 2, text: "100" },
        { columnEnd: 3, columnStart: 3, text: "25" }
      ],
      headerLineage: [
        { columnEnd: 0, columnStart: 0, rowIndex: 0, text: "Metric" },
        { columnEnd: 1, columnStart: 1, rowIndex: 0, text: "2024" },
        { columnEnd: 2, columnStart: 2, rowIndex: 0, text: "2025" },
        { columnEnd: 3, columnStart: 3, rowIndex: 0, text: "Q1 2026" }
      ],
      rowIndex: 1
    });
    const observationAt = (columnStart: number) => context.observations.find((observation) =>
      observation.origin.kind === "table_cell" && observation.origin.columnStart === columnStart);

    expect(observationAt(1)).toMatchObject({
      ambiguityReasons: [],
      effectiveFrom: "2024-01-01",
      effectiveTo: "2024-12-31",
      metric: "Revenue",
      normalizedValue: "100",
      role: "observation"
    });
    expect(observationAt(2)).toMatchObject({
      effectiveFrom: "2025-01-01",
      effectiveTo: "2025-12-31",
      metric: "Revenue",
      normalizedValue: "100",
      role: "observation"
    });
    expect(observationAt(3)).toMatchObject({
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-03-31",
      metric: "Revenue",
      normalizedValue: "25",
      role: "observation"
    });
    const serialized = decodeKnowledgeDocumentContext(JSON.parse(JSON.stringify(context)));
    expect(serialized).toEqual(context);
  });

  it("serializes attached evidence units and rejects a conflicting authoritative unit", () => {
    const attached = createKnowledgeTableDocumentContext({
      blockId: "block-attached-unit",
      cells: [{ columnEnd: 0, columnStart: 0, text: "1e3mg" }],
      headerLineage: [{ columnEnd: 0, columnStart: 0, rowIndex: 0, text: "Actual" }],
      rowIndex: 1
    });
    expect(attached.observations[0]).toMatchObject({
      ambiguityReasons: [],
      normalizedValue: "1000",
      role: "observation",
      unit: "mg"
    });
    expect(decodeKnowledgeDocumentContext(JSON.parse(JSON.stringify(attached)))).toEqual(attached);

    const conflict = createKnowledgeTableDocumentContext({
      blockId: "block-conflicting-unit",
      cells: [{ columnEnd: 0, columnStart: 0, text: "1e3mg" }],
      headerLineage: [{ columnEnd: 0, columnStart: 0, rowIndex: 0, text: "Actual (g)" }],
      rowIndex: 1
    });
    expect(conflict.observations[0]).toMatchObject({
      ambiguityReasons: ["ambiguous_role"],
      normalizedValue: "1000",
      unit: null
    });
  });

  it("binds actual and reference values to the same explicit table metric, unit, and date", () => {
    const context = createKnowledgeTableDocumentContext({
      blockId: "block-lab",
      cells: [
        { columnEnd: 0, columnStart: 0, text: "Глюкоза" },
        { columnEnd: 1, columnStart: 1, text: "20.08.2026" },
        { columnEnd: 2, columnStart: 2, text: "5,4" },
        { columnEnd: 3, columnStart: 3, text: "3,9–6,1" },
        { columnEnd: 4, columnStart: 4, text: "ммоль/л" }
      ],
      headerLineage: [
        { columnEnd: 0, columnStart: 0, rowIndex: 0, text: "Показатель" },
        { columnEnd: 1, columnStart: 1, rowIndex: 0, text: "Дата" },
        { columnEnd: 2, columnStart: 2, rowIndex: 0, text: "Факт" },
        { columnEnd: 3, columnStart: 3, rowIndex: 0, text: "Референс" },
        { columnEnd: 4, columnStart: 4, rowIndex: 0, text: "Ед." }
      ],
      rowIndex: 1
    });

    expect(context.locator).toMatchObject({
      blockId: "block-lab",
      kind: "table_row",
      rowIndex: 1
    });
    expect(context.observations.find((entry) => entry.origin.kind === "table_cell" &&
      entry.origin.columnStart === 2)).toMatchObject({
      ambiguityReasons: [],
      date: "2026-08-20",
      metric: "Глюкоза",
      normalizedValue: "5.4",
      role: "observation",
      unit: "ммоль/л"
    });
    expect(context.observations.find((entry) => entry.origin.kind === "table_cell" &&
      entry.origin.columnStart === 3)).toMatchObject({
      date: "2026-08-20",
      metric: "Глюкоза",
      normalizedValue: "3.9..6.1",
      role: "reference",
      unit: "ммоль/л"
    });
    expect(decodeKnowledgeDocumentContext(JSON.parse(JSON.stringify(context)))).toEqual(context);
  });

  it("deduplicates reciprocal parser links and propagates only explicit field-group metadata", () => {
    const segments = createKnowledgeFieldContextSegments({
      cells: [
        { confidence: 0.99, id: 1, label: "key", order: 0, text: "Metric" },
        { confidence: 0.99, id: 2, label: "value", order: 1, text: "Glucose" },
        { confidence: 0.98, id: 3, label: "key", order: 2, text: "Date" },
        { confidence: 0.98, id: 4, label: "value", order: 3, text: "2026-08-20" },
        { confidence: 0.97, id: 5, label: "key", order: 4, text: "Unit" },
        { confidence: 0.97, id: 6, label: "value", order: 5, text: "mmol/L" },
        { confidence: 0.96, id: 7, label: "key", order: 6, text: "Actual" },
        { confidence: 0.96, id: 8, label: "value", order: 7, text: "5.4" },
        { confidence: 0.95, id: 9, label: "key", order: 8, text: "Reference" },
        { confidence: 0.95, id: 10, label: "value", order: 9, text: "3.9–6.1" },
        { confidence: 0.94, id: 11, label: "key", order: 10, text: "Effective from" },
        { confidence: 0.94, id: 12, label: "value", order: 11, text: "2026-08-01" },
        { confidence: 0.94, id: 13, label: "key", order: 12, text: "Effective to" },
        { confidence: 0.94, id: 14, label: "value", order: 13, text: "2026-08-31" }
      ],
      confidence: 0.94,
      id: "field-group-1",
      links: [
        ...[1, 3, 5, 7, 9, 11, 13].flatMap((keyId) => [{
          confidence: 0.93,
          label: "to_value" as const,
          sourceCellId: keyId,
          targetCellId: keyId + 1
        }, {
          confidence: 0.93,
          label: "to_key" as const,
          sourceCellId: keyId + 1,
          targetCellId: keyId
        }])
      ]
    });

    expect(segments).toHaveLength(7);
    const actual = segments.find((segment) => segment.text === "Actual\t5.4");
    const reference = segments.find((segment) => segment.text === "Reference\t3.9–6.1");
    expect(actual?.context.locator).toMatchObject({
      kind: "field_pair",
      labelCellId: 7,
      valueCellId: 8
    });
    expect(actual?.context.observations[0]).toMatchObject({
      date: "2026-08-20",
      effectiveFrom: "2026-08-01",
      effectiveTo: "2026-08-31",
      metric: "Glucose",
      normalizedValue: "5.4",
      role: "observation",
      unit: "mmol/L"
    });
    expect(reference?.context.observations[0]).toMatchObject({
      metric: "Glucose",
      normalizedValue: "3.9..6.1",
      role: "reference"
    });
  });

  it("keeps propagated field units inside the serialized context contract", () => {
    const segments = createKnowledgeFieldContextSegments({
      cells: [
        { confidence: null, id: 1, label: "key", order: 0, text: "Unit" },
        { confidence: null, id: 2, label: "value", order: 1, text: "u".repeat(200) },
        { confidence: null, id: 3, label: "key", order: 2, text: "Actual" },
        { confidence: null, id: 4, label: "value", order: 3, text: "5.4" }
      ],
      confidence: null,
      id: "field-group-unit-bound",
      links: [
        { confidence: null, label: "to_value", sourceCellId: 1, targetCellId: 2 },
        { confidence: null, label: "to_value", sourceCellId: 3, targetCellId: 4 }
      ]
    });
    const actual = segments.find((segment) => segment.text === "Actual\t5.4");

    expect(actual?.context.observations[0]?.unit).toHaveLength(128);
    expect(actual && decodeKnowledgeDocumentContext(JSON.parse(JSON.stringify(actual.context))))
      .toEqual(actual?.context);
  });

  it("keeps competing or unlinked field cells separate and explicitly ambiguous", () => {
    const segments = createKnowledgeFieldContextSegments({
      cells: [
        { confidence: null, id: 1, label: "key", order: 0, text: "Actual" },
        { confidence: null, id: 2, label: "key", order: 1, text: "Reference" },
        { confidence: null, id: 3, label: "value", order: 2, text: "20" },
        { confidence: null, id: 4, label: "unspecified", order: 3, text: "orphan" }
      ],
      confidence: null,
      id: "field-group-ambiguous",
      links: [{ confidence: null, label: "to_value", sourceCellId: 1, targetCellId: 3 }, {
        confidence: null,
        label: "to_value",
        sourceCellId: 2,
        targetCellId: 3
      }]
    });

    expect(segments.map((segment) => segment.text)).toEqual(["Actual", "Reference", "20", "orphan"]);
    expect(segments.every((segment) => segment.context.locator.kind === "field_ambiguous"))
      .toBe(true);
    expect(segments.slice(0, 3).every((segment) =>
      segment.context.ambiguityReasons.includes("competing_pair"))).toBe(true);
    expect(segments[3]!.context.ambiguityReasons).toEqual(["missing_pair", "unspecified_role"]);
  });

  it("rejects unknown or non-canonical fields instead of accepting a widened contract", () => {
    const context = createKnowledgeTableDocumentContext({
      blockId: "block-1",
      cells: [{ columnEnd: 0, columnStart: 0, text: "10" }],
      headerLineage: [{ columnEnd: 0, columnStart: 0, rowIndex: 0, text: "Actual" }],
      rowIndex: 1
    });
    expect(decodeKnowledgeDocumentContext({ ...context, privateMetadata: "no" })).toBeNull();
    expect(decodeKnowledgeDocumentContext({
      ...context,
      locator: { ...context.locator, rowId: "forged-row" }
    })).toBeNull();
    expect(decodeKnowledgeDocumentContext({
      ...context,
      ambiguityReasons: ["missing_header", "ambiguous_date"]
    })).toBeNull();
  });

  it("accepts repeated fragments of one cell but rejects unreachable projection groups", () => {
    const projection = (
      projectionIndex: number,
      projectionCount: number,
      columnStart: number,
      columnEnd: number
    ) => {
      const context = createKnowledgeTableDocumentContext({
        blockId: "block-projected-row",
        cells: [{ columnEnd, columnStart, text: `fragment-${projectionIndex}` }],
        columnEnd,
        columnStart,
        headerLineage: [],
        projectionCount,
        projectionIndex,
        rowIndex: 1
      });
      if (context.locator.kind !== "table_row_projection") {
        throw new Error("missing_projection_locator");
      }
      return context.locator;
    };
    const repeatedCell = [
      projection(0, 3, 0, 0),
      projection(1, 3, 0, 0),
      projection(2, 3, 1, 2)
    ];

    expect(isCompleteKnowledgeTableRowProjectionSequence(repeatedCell)).toBe(true);
    expect(isCompleteKnowledgeTableRowProjectionSequence([
      repeatedCell[0]!,
      { ...repeatedCell[1]!, columnEnd: 1 },
      repeatedCell[2]!
    ])).toBe(false);
    expect(() => projection(0, KNOWLEDGE_TABLE_ROW_MAX_PROJECTIONS + 1, 0, 0))
      .toThrow("knowledge_document_context_invalid");

    const boundary = createKnowledgeTableDocumentContext({
      blockId: "block-projected-row",
      cells: [{ columnEnd: 7, columnStart: 7, text: "last fragment" }],
      columnEnd: 7,
      columnStart: 7,
      headerLineage: [],
      projectionCount: KNOWLEDGE_TABLE_ROW_MAX_PROJECTIONS,
      projectionIndex: KNOWLEDGE_TABLE_ROW_MAX_PROJECTIONS - 1,
      rowIndex: 1
    });
    expect(decodeKnowledgeDocumentContext(boundary)).toEqual(boundary);
    expect(decodeKnowledgeDocumentContext({
      ...boundary,
      locator: {
        ...boundary.locator,
        projectionCount: KNOWLEDGE_TABLE_ROW_MAX_PROJECTIONS + 1
      }
    })).toBeNull();
  });
});
