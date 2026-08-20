export const KNOWLEDGE_DOCUMENT_CONTEXT_INTEGRITY_CORPUS_VERSION = 2 as const;

export type KnowledgeDocumentContextFixtureLanguage = "en" | "ru";

export type KnowledgeDocumentContextFixture = Readonly<{
  contract: Readonly<{
    dataRowIndexes: readonly number[];
    explicitFieldPairCount: number;
    oversizedDataRowIndex: number | null;
    positionedOcr: Readonly<{
      confidence: number;
      fragmentCount: number;
      outcome: "abstained" | "reconstructed";
    }> | null;
    repeatedHeaderRowIndex: number | null;
    rowCount: number;
  }>;
  doclingResponse: unknown;
  language: KnowledgeDocumentContextFixtureLanguage;
}>;

type DoclingTableCell = Readonly<{
  end_col_offset_idx: number;
  end_row_offset_idx: number;
  start_col_offset_idx: number;
  start_row_offset_idx: number;
  text: string;
}>;

type DoclingGraphCell = Readonly<{
  cell_id: number;
  label: "key" | "value";
  orig: string;
  text: string;
}>;

function tableCells(rows: readonly (readonly string[])[]): readonly DoclingTableCell[] {
  return Object.freeze(rows.flatMap((row, rowIndex) => row.map((text, columnIndex) =>
    Object.freeze({
      end_col_offset_idx: columnIndex + 1,
      end_row_offset_idx: rowIndex + 1,
      start_col_offset_idx: columnIndex,
      start_row_offset_idx: rowIndex,
      text
    }))));
}

function pairGraph(pairs: readonly (readonly [string, string])[]): Readonly<{
  cells: readonly DoclingGraphCell[];
  links: readonly Readonly<{
    label: "to_value";
    source_cell_id: number;
    target_cell_id: number;
  }>[];
}> {
  const cells = pairs.flatMap(([key, value], index) => {
    const keyId = index * 2 + 1;
    return [
      Object.freeze({ cell_id: keyId, label: "key" as const, orig: key, text: key }),
      Object.freeze({ cell_id: keyId + 1, label: "value" as const, orig: value, text: value })
    ];
  });
  return Object.freeze({
    cells: Object.freeze(cells),
    links: Object.freeze(pairs.map((_pair, index) => Object.freeze({
      label: "to_value" as const,
      source_cell_id: index * 2 + 1,
      target_cell_id: index * 2 + 2
    })))
  });
}

function competingGraph(): Readonly<{
  cells: readonly DoclingGraphCell[];
  links: readonly Readonly<{
    label: "to_value";
    source_cell_id: number;
    target_cell_id: number;
  }>[];
}> {
  return Object.freeze({
    cells: Object.freeze([
      Object.freeze({ cell_id: 101, label: "key", orig: "Actual", text: "Actual" }),
      Object.freeze({ cell_id: 102, label: "key", orig: "Reference", text: "Reference" }),
      Object.freeze({ cell_id: 103, label: "value", orig: "20", text: "20" })
    ]),
    links: Object.freeze([
      Object.freeze({ label: "to_value", source_cell_id: 101, target_cell_id: 103 }),
      Object.freeze({ label: "to_value", source_cell_id: 102, target_cell_id: 103 })
    ])
  });
}

function doclingFixture(input: Readonly<{
  explicitPairs?: readonly (readonly [string, string])[];
  rows: readonly (readonly string[])[];
  title: string;
}>): unknown {
  const explicitPairs = input.explicitPairs ?? [];
  const children: Array<Readonly<{ $ref: string }>> = [
    Object.freeze({ $ref: "#/texts/0" }),
    Object.freeze({ $ref: "#/tables/0" })
  ];
  if (explicitPairs.length > 0) {
    children.push(
      Object.freeze({ $ref: "#/key_value_items/0" }),
      Object.freeze({ $ref: "#/form_items/0" })
    );
  }
  return Object.freeze({
    document: Object.freeze({
      json_content: Object.freeze({
        body: Object.freeze({ children: Object.freeze(children) }),
        ...(explicitPairs.length > 0
          ? {
              form_items: Object.freeze([Object.freeze({
                graph: competingGraph(),
                prov: Object.freeze([{ page_no: 1 }]),
                self_ref: "#/form_items/0"
              })]),
              key_value_items: Object.freeze([Object.freeze({
                graph: pairGraph(explicitPairs),
                prov: Object.freeze([{ page_no: 1 }]),
                self_ref: "#/key_value_items/0"
              })])
            }
          : {}),
        pages: Object.freeze({ "1": Object.freeze({ page_no: 1 }) }),
        schema_name: "DoclingDocument",
        tables: Object.freeze([Object.freeze({
          content_layer: "body",
          data: Object.freeze({ table_cells: tableCells(input.rows) }),
          prov: Object.freeze([{ page_no: 1 }])
        })]),
        texts: Object.freeze([Object.freeze({
          content_layer: "body",
          label: "title",
          prov: Object.freeze([{ page_no: 1 }]),
          text: input.title
        })])
      })
    }),
    status: "success"
  });
}

function positionedOcrDoclingFixture(input: Readonly<{
  rows: readonly (readonly string[])[];
  title: string;
}>): unknown {
  const fragments = input.rows.flatMap((row, rowIndex) => row.map((value, columnIndex) => {
    const left = 10 + columnIndex * 180;
    const top = 40 + rowIndex * 20;
    return Object.freeze({
      content_layer: "body",
      label: "paragraph",
      prov: Object.freeze([Object.freeze({
        bbox: Object.freeze({
          b: top + 10,
          coord_origin: "TOPLEFT",
          l: left,
          r: left + 140,
          t: top
        }),
        page_no: 1
      })]),
      text: value
    });
  }));
  const texts = Object.freeze([
    Object.freeze({
      content_layer: "body",
      label: "title",
      prov: Object.freeze([Object.freeze({ page_no: 1 })]),
      text: input.title
    }),
    ...fragments
  ]);
  return Object.freeze({
    document: Object.freeze({
      json_content: Object.freeze({
        body: Object.freeze({
          children: Object.freeze(texts.map((_text, index) =>
            Object.freeze({ $ref: `#/texts/${index}` })))
        }),
        pages: Object.freeze({ "1": Object.freeze({ page_no: 1 }) }),
        schema_name: "DoclingDocument",
        texts
      })
    }),
    status: "success"
  });
}

const englishHeader = Object.freeze([
  "Metric",
  "Date",
  "Actual (mg/L)",
  "Reference (mg/L)",
  "Target (mg/L)",
  "Threshold (mg/L)",
  "Effective from",
  "Effective to",
  "Revision"
]);

const englishRows = Object.freeze([
  englishHeader,
  Object.freeze(["Glucose", "2026-08-20", "5.40", "3.90–6.10", "5.00", "7.00", "2026-01-01", "2026-12-31", "v2"]),
  Object.freeze(["Lactate", "2026-08-20", "2.10", "0.50–2.20", "1.80", "2.50", "2026-01-01", "2026-12-31", "v2"]),
  Object.freeze(["Glucose", "2026-08-21", "5.60", "3.90–6.10", "5.00", "7.00", "2026-01-01", "2026-12-31", "v3"]),
  englishHeader,
  Object.freeze(["Glucose", "2026-08-22", "5.70", "3.90–6.10", "5.00", "7.00", "2026-01-01", "2026-12-31", "v3"])
]);

const russianHeader = Object.freeze([
  "Показатель",
  "Дата",
  "Факт (ммоль/л)",
  "Референс (ммоль/л)",
  "Цель (ммоль/л)",
  "Порог (ммоль/л)",
  "Действует с",
  "Действует до",
  "Версия"
]);

const russianRows = Object.freeze([
  russianHeader,
  Object.freeze(["Глюкоза", "20.08.2026", "5,40", "3,90–6,10", "5,00", "7,00", "01.01.2026", "31.12.2026", "v2"]),
  Object.freeze(["Лактат", "20.08.2026", "2,10", "0,50–2,20", "1,80", "2,50", "01.01.2026", "31.12.2026", "v2"]),
  Object.freeze(["Глюкоза", "21.08.2026", "5,60", "3,90–6,10", "5,00", "7,00", "01.01.2026", "31.12.2026", "v3"])
]);

const explicitEnglishPairs = Object.freeze([
  Object.freeze(["Metric", "Glucose"] as const),
  Object.freeze(["Date", "2026-08-20"] as const),
  Object.freeze(["Unit", "mg/L"] as const),
  Object.freeze(["Actual", "5.40"] as const),
  Object.freeze(["Reference", "3.90–6.10"] as const),
  Object.freeze(["Target", "5.00"] as const),
  Object.freeze(["Threshold", "7.00"] as const),
  Object.freeze(["Effective from", "2026-01-01"] as const),
  Object.freeze(["Effective to", "2026-12-31"] as const),
  Object.freeze(["Version", "v2"] as const)
]);

const oversizedHeader = Object.freeze([
  "Date",
  "Field Alpha",
  "Field Beta",
  "Field Gamma",
  "Field Delta",
  "Field Epsilon",
  "Field Zeta",
  "Field Eta",
  "Field Theta",
  "Field Iota"
]);
const oversizedRow = Object.freeze([
  "2026-08-20",
  ...Array.from({ length: 9 }, (_value, columnIndex) =>
    Array.from({ length: 90 }, (_item, tokenIndex) =>
      `payload_${columnIndex + 2}_${tokenIndex + 1}`).join(" "))
]);

const russianOcrRows = Object.freeze([
  Object.freeze(["Показатель", "Дата", "Факт (ммоль/л)", "Версия"]),
  Object.freeze(["Глюкоза", "20.08.2026", "5,40", "v4"]),
  Object.freeze(["Лактат", "20.08.2026", "2,10", "v4"]),
  Object.freeze(["Показатель", "Дата", "Факт (ммоль/л)", "Версия"]),
  Object.freeze(["Глюкоза", "21.08.2026", "5,60", "v5"])
]);

const lowConfidenceOcrRows = Object.freeze([
  Object.freeze(["Metric OCR", "Actual"]),
  Object.freeze(["Alpha OCR", "1.5"]),
  Object.freeze(["Beta OCR", "2.5"])
]);

export const knowledgeDocumentContextIntegrityFixtures: readonly KnowledgeDocumentContextFixture[] =
  Object.freeze([
    Object.freeze({
      contract: Object.freeze({
        dataRowIndexes: Object.freeze([1, 2, 3, 5]),
        explicitFieldPairCount: explicitEnglishPairs.length,
        oversizedDataRowIndex: null,
        positionedOcr: null,
        repeatedHeaderRowIndex: 4,
        rowCount: englishRows.length
      }),
      doclingResponse: doclingFixture({
        explicitPairs: explicitEnglishPairs,
        rows: englishRows,
        title: "Document context integrity EN"
      }),
      language: "en" as const
    }),
    Object.freeze({
      contract: Object.freeze({
        dataRowIndexes: Object.freeze([1, 2, 3]),
        explicitFieldPairCount: 0,
        oversizedDataRowIndex: null,
        positionedOcr: null,
        repeatedHeaderRowIndex: null,
        rowCount: russianRows.length
      }),
      doclingResponse: doclingFixture({
        rows: russianRows,
        title: "Целостность контекста документа RU"
      }),
      language: "ru" as const
    }),
    Object.freeze({
      contract: Object.freeze({
        dataRowIndexes: Object.freeze([1]),
        explicitFieldPairCount: 0,
        oversizedDataRowIndex: 1,
        positionedOcr: null,
        repeatedHeaderRowIndex: null,
        rowCount: 2
      }),
      doclingResponse: doclingFixture({
        rows: Object.freeze([oversizedHeader, oversizedRow]),
        title: "Oversized recognized row"
      }),
      language: "en" as const
    }),
    Object.freeze({
      contract: Object.freeze({
        dataRowIndexes: Object.freeze([1, 2, 4]),
        explicitFieldPairCount: 0,
        oversizedDataRowIndex: null,
        positionedOcr: Object.freeze({
          confidence: 0.92,
          fragmentCount: russianOcrRows.reduce((total, row) => total + row.length, 0),
          outcome: "reconstructed" as const
        }),
        repeatedHeaderRowIndex: 3,
        rowCount: russianOcrRows.length
      }),
      doclingResponse: positionedOcrDoclingFixture({
        rows: russianOcrRows,
        title: "OCR fragments RU"
      }),
      language: "ru" as const
    }),
    Object.freeze({
      contract: Object.freeze({
        dataRowIndexes: Object.freeze([1, 2]),
        explicitFieldPairCount: 0,
        oversizedDataRowIndex: null,
        positionedOcr: Object.freeze({
          confidence: 0.64,
          fragmentCount: lowConfidenceOcrRows.reduce((total, row) => total + row.length, 0),
          outcome: "abstained" as const
        }),
        repeatedHeaderRowIndex: null,
        rowCount: lowConfidenceOcrRows.length
      }),
      doclingResponse: positionedOcrDoclingFixture({
        rows: lowConfidenceOcrRows,
        title: "Low confidence OCR fragments"
      }),
      language: "en" as const
    })
  ]);

export const knowledgeDocumentContextFixtureContentSentinels = Object.freeze([
  "Glucose",
  "Глюкоза",
  "payload_2_1",
  "Alpha OCR"
]);

export const knowledgeDocumentContextArithmeticCsv =
  "Locale;Left;Right\nEN point;0.1;0.2\nRU comma;0,1;0,2\n";
