import { KNOWLEDGE_CHUNKING_PROFILE_VERSION } from "../../lib/server/knowledge/indexProfile";
import {
  chunkKnowledgeDocument,
  KNOWLEDGE_CHUNK_MAX_TOKENS,
  type KnowledgeChunkPlanEntry
} from "../../lib/server/knowledge/chunking";
import {
  decodeKnowledgeDocumentContext,
  normalizeKnowledgeObservationValue,
  type KnowledgeDocumentContextV1,
  type KnowledgeDocumentObservationV1
} from "../../lib/server/knowledge/documentContext";
import {
  decodeKnowledgeNormalizedDocument,
  encodeKnowledgeNormalizedDocument,
  type StoredKnowledgeNormalizedDocument
} from "../../lib/server/knowledge/normalizedDocument";
import {
  executeStructuredPlan,
  STRUCTURED_PLAN_VERSION,
  verifyStructuredAnalysisResult,
  type StructuredArithmeticPlan
} from "../../lib/server/knowledge/structuredData";
import { parseSpreadsheetDocument } from "../../lib/server/parsing";
import { finalizeParsedDocument } from "../../lib/server/parsing/assessment";
import { normalizeDoclingResponse } from "../../lib/server/parsing/normalization";
import {
  KNOWLEDGE_DOCUMENT_CONTEXT_INTEGRITY_CORPUS_VERSION,
  knowledgeDocumentContextArithmeticCsv,
  knowledgeDocumentContextIntegrityFixtures,
  type KnowledgeDocumentContextFixture,
  type KnowledgeDocumentContextFixtureLanguage
} from "./documentContextIntegrityFixtures";

export const KNOWLEDGE_DOCUMENT_CONTEXT_INTEGRITY_REPORT_VERSION = 2 as const;

export const knowledgeDocumentContextIntegrityGates = Object.freeze({
  ambiguityDisclosureMinimum: 1,
  ambiguousFieldFalsePairMaximum: 0,
  arithmeticTamperAcceptanceMaximum: 0,
  arithmeticVerificationMinimum: 1,
  decimalNormalizationMinimum: 1,
  effectiveIntervalRetentionMinimum: 1,
  explicitFieldPairRetentionMinimum: 1,
  headerLineageIntegrityMinimum: 1,
  metricUnitDateIsolationMinimum: 1,
  lowConfidenceOcrAbstentionMinimum: 1,
  normalizedRoundTripMinimum: 1,
  ocrFragmentContextIntegrityMinimum: 1,
  ocrRepeatedHeaderIntegrityMinimum: 1,
  oversizedRowCoverageMinimum: 1,
  repeatedHeaderIntegrityMinimum: 1,
  roleBindingMinimum: 1,
  rowLocatorIntegrityMinimum: 1,
  versionMetadataRetentionMinimum: 1
});

type UnavailableMetric = Readonly<{
  field: "durable_retrieval_context_round_trip" | "structured_document_version_field";
  reason:
    | "document_context_v1_retains_version_as_metadata_only"
    | "requires_disposable_postgres_repository_lane";
}>;

export type KnowledgeDocumentContextIntegrityReport = Readonly<{
  aggregateOnly: true;
  corpus: Readonly<{
    fixtureCount: number;
    languages: Readonly<Record<KnowledgeDocumentContextFixtureLanguage, number>>;
    provenance: "repository_generated_synthetic";
    version: typeof KNOWLEDGE_DOCUMENT_CONTEXT_INTEGRITY_CORPUS_VERSION;
  }>;
  counts: Readonly<{
    documentContextCount: number;
    fieldGroupCount: number;
    positionedOcrFixtureCount: number;
    positionedOcrFragmentCount: number;
    tableRowCount: number;
  }>;
  gates: typeof knowledgeDocumentContextIntegrityGates;
  independentHumanLabelsUsed: false;
  metrics: Readonly<{
    ambiguityDisclosure: number;
    ambiguousFieldFalsePairs: number;
    arithmeticTamperAcceptances: number;
    arithmeticVerification: number;
    decimalNormalization: number;
    effectiveIntervalRetention: number;
    explicitFieldPairRetention: number;
    headerLineageIntegrity: number;
    lowConfidenceOcrAbstention: number;
    metricUnitDateIsolation: number;
    normalizedRoundTrip: number;
    ocrFragmentContextIntegrity: number;
    ocrRepeatedHeaderIntegrity: number;
    oversizedRowCoverage: number;
    repeatedHeaderIntegrity: number;
    roleBinding: number;
    rowLocatorIntegrity: number;
    versionMetadataRetention: number;
  }>;
  passed: boolean;
  retrievalQualityGateEligible: false;
  scope: "deterministic_document_structure_contract";
  unavailable: readonly UnavailableMetric[];
  version: typeof KNOWLEDGE_DOCUMENT_CONTEXT_INTEGRITY_REPORT_VERSION;
}>;

type EvaluatedFixture = Readonly<{
  chunks: readonly KnowledgeChunkPlanEntry[];
  document: StoredKnowledgeNormalizedDocument;
  fixture: KnowledgeDocumentContextFixture;
  normalizedRoundTrip: boolean;
  tableBlockId: string | null;
}>;

type KnowledgeTableDocumentContext = Omit<KnowledgeDocumentContextV1, "locator"> & Readonly<{
  locator: Extract<KnowledgeDocumentContextV1["locator"], {
    kind: "table_row" | "table_row_projection";
  }>;
}>;

const extractionConfig = Object.freeze({
  maxChunksPerDocument: 1_000,
  maxFileBytes: 2_000_000,
  maxNormalizedChars: 2_000_000,
  maxNormalizedObjectBytes: 8_000_000,
  maxPages: 100
});

function rate(checks: readonly boolean[]): number {
  return checks.length === 0 ? 0 : checks.filter(Boolean).length / checks.length;
}

function tableContext(
  chunk: KnowledgeChunkPlanEntry,
  blockId: string | null
): KnowledgeTableDocumentContext | null {
  if (blockId === null) return null;
  const context = chunk.documentContext ?? null;
  if (!context || (context.locator.kind !== "table_row" &&
    context.locator.kind !== "table_row_projection") || context.locator.blockId !== blockId) {
    return null;
  }
  return context as KnowledgeTableDocumentContext;
}

function evaluatedFixture(fixture: KnowledgeDocumentContextFixture): EvaluatedFixture {
  const normalized = normalizeDoclingResponse(fixture.doclingResponse, "application/pdf");
  const positionedOcr = fixture.contract.positionedOcr;
  const parsed = positionedOcr === null ? normalized : finalizeParsedDocument({
    assets: normalized.assets,
    attempts: normalized.attempts,
    blocks: normalized.blocks,
    engine: normalized.engine,
    fieldGroups: normalized.fieldGroups,
    languages: normalized.languages,
    mediaType: normalized.mediaType,
    ocrConfidence: positionedOcr.confidence,
    pageCount: normalized.pageCount,
    status: normalized.status,
    warnings: normalized.warnings,
    workbook: normalized.workbook
  });
  const encoded = encodeKnowledgeNormalizedDocument(parsed, extractionConfig, {
    layoutAwareTables: positionedOcr !== null,
    sourceDisplayName: "synthetic-document-context-fixture"
  });
  const document = decodeKnowledgeNormalizedDocument(encoded.body, extractionConfig);
  const table = document.blocks.find((block) => block.table !== null);
  if (!table && positionedOcr?.outcome !== "abstained") {
    throw new Error("knowledge_document_context_fixture_table_missing");
  }
  const chunks = chunkKnowledgeDocument({
    document,
    maxChunks: extractionConfig.maxChunksPerDocument,
    profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION
  });
  const normalizedRoundTrip = encoded.document.schemaVersion === 4 &&
    document.contentHash === encoded.document.contentHash &&
    document.fieldGroups.length === parsed.fieldGroups.length &&
    document.fieldGroups.every((group, index) => {
      const source = parsed.fieldGroups[index];
      return source !== undefined && group.sourceRef === source.sourceRef &&
        group.cells.length === source.cells.length && group.links.length === source.links.length;
    });
  return Object.freeze({
    chunks: Object.freeze(chunks),
    document,
    fixture,
    normalizedRoundTrip,
    tableBlockId: table?.id ?? null
  });
}

function contextsForFixture(value: EvaluatedFixture): readonly KnowledgeDocumentContextV1[] {
  return Object.freeze(value.chunks.flatMap((chunk) => {
    const context = chunk.documentContext ?? null;
    return context ? [context] : [];
  }));
}

function contextsForRow(
  value: EvaluatedFixture,
  rowIndex: number
): readonly KnowledgeTableDocumentContext[] {
  return Object.freeze(value.chunks.flatMap((chunk) => {
    const context = tableContext(chunk, value.tableBlockId);
    return context?.locator.rowIndex === rowIndex ? [context] : [];
  }));
}

function tableObservation(
  context: KnowledgeDocumentContextV1,
  columnStart: number
): KnowledgeDocumentObservationV1 | null {
  return context.observations.find((observation) =>
    observation.origin.kind === "table_cell" && observation.origin.columnStart === columnStart
  ) ?? null;
}

function rowLocatorChecks(value: EvaluatedFixture): readonly boolean[] {
  if (value.fixture.contract.positionedOcr?.outcome === "abstained") return Object.freeze([]);
  const oversized = value.fixture.contract.oversizedDataRowIndex;
  return Object.freeze(Array.from({ length: value.fixture.contract.rowCount }, (_item, rowIndex) => {
    const contexts = contextsForRow(value, rowIndex);
    if (rowIndex === oversized) return contexts.length > 1 && contexts.every((context) =>
      context.locator.kind === "table_row_projection");
    return contexts.length === 1 && contexts[0]?.locator.kind === "table_row";
  }));
}

function headerLineageChecks(value: EvaluatedFixture): readonly boolean[] {
  if (value.fixture.contract.positionedOcr?.outcome === "abstained") return Object.freeze([]);
  const repeatedHeader = value.fixture.contract.repeatedHeaderRowIndex;
  return Object.freeze(value.fixture.contract.dataRowIndexes.flatMap((rowIndex) =>
    contextsForRow(value, rowIndex).map((context) => {
      const lineage = context.locator.kind === "table_row" ||
        context.locator.kind === "table_row_projection"
        ? context.locator.headerLineage
        : [];
      const expectedHeaderRow = repeatedHeader !== null && rowIndex > repeatedHeader
        ? repeatedHeader
        : 0;
      return lineage.length > 0 && lineage.every((header) => header.rowIndex === expectedHeaderRow);
    })));
}

function repeatedHeaderCheck(value: EvaluatedFixture): boolean {
  const repeatedHeader = value.fixture.contract.repeatedHeaderRowIndex;
  if (repeatedHeader === null) return true;
  const headers = contextsForRow(value, repeatedHeader);
  const followingRow = value.fixture.contract.dataRowIndexes.find((rowIndex) =>
    rowIndex > repeatedHeader);
  const following = followingRow === undefined ? [] : contextsForRow(value, followingRow);
  return headers.length === 1 && headers[0]?.locator.rowKind === "header" &&
    following.length === 1 && following[0]?.locator.headerLineage.every((header) =>
      header.rowIndex === repeatedHeader) === true;
}

function oversizedRowCheck(value: EvaluatedFixture): boolean {
  const rowIndex = value.fixture.contract.oversizedDataRowIndex;
  if (rowIndex === null) return true;
  const contexts = contextsForRow(value, rowIndex);
  const projections = contexts.flatMap((context) =>
    context.locator.kind === "table_row_projection" ? [context.locator] : []);
  if (projections.length < 2) return false;
  const projectionCount = projections[0]?.projectionCount;
  const rowId = projections[0]?.rowId;
  const columns = new Set<number>();
  for (const projection of projections) {
    if (projection.projectionCount !== projectionCount || projection.rowId !== rowId) return false;
    for (let column = projection.columnStart; column <= projection.columnEnd; column += 1) {
      columns.add(column);
    }
  }
  const table = value.document.blocks.find((block) => block.id === value.tableBlockId)?.table;
  return projectionCount === projections.length &&
    projections.map((projection) => projection.projectionIndex).sort((left, right) => left - right)
      .every((projectionIndex, index) => projectionIndex === index) &&
    table !== null && table !== undefined && columns.size === table.columnCount &&
    Array.from({ length: table.columnCount }, (_item, column) => columns.has(column)).every(Boolean) &&
    value.chunks.filter((chunk) => tableContext(chunk, value.tableBlockId)?.locator.rowIndex === rowIndex)
      .every((chunk) => chunk.tokenCount <= KNOWLEDGE_CHUNK_MAX_TOKENS);
}

function observationContractChecks(
  evaluated: readonly EvaluatedFixture[]
): Readonly<{
  effectiveIntervals: readonly boolean[];
  metricUnitDates: readonly boolean[];
  roles: readonly boolean[];
  versions: readonly boolean[];
}> {
  const effectiveIntervals: boolean[] = [];
  const metricUnitDates: boolean[] = [];
  const roles: boolean[] = [];
  const versions: boolean[] = [];
  for (const value of evaluated.filter((entry) =>
    entry.fixture.contract.oversizedDataRowIndex === null &&
    entry.fixture.contract.positionedOcr === null)) {
    for (const rowIndex of value.fixture.contract.dataRowIndexes) {
      const [context] = contextsForRow(value, rowIndex);
      if (!context) {
        effectiveIntervals.push(false);
        metricUnitDates.push(false);
        roles.push(false);
        versions.push(false);
        continue;
      }
      const actual = tableObservation(context, 2);
      const reference = tableObservation(context, 3);
      const target = tableObservation(context, 4);
      const threshold = tableObservation(context, 5);
      const version = tableObservation(context, 8);
      roles.push(actual?.role === "observation", reference?.role === "reference",
        target?.role === "target", threshold?.role === "threshold");
      effectiveIntervals.push(actual?.effectiveFrom === "2026-01-01" &&
        actual.effectiveTo === "2026-12-31");
      versions.push(version?.role === "metadata" && /^v[23]$/u.test(version.rawValue));
    }
    const rows = value.fixture.contract.dataRowIndexes.slice(0, 3).map((rowIndex) =>
      contextsForRow(value, rowIndex)[0] ?? null);
    const actuals = rows.map((context) => context ? tableObservation(context, 2) : null);
    const expectedUnit = value.fixture.language === "en" ? "mg/L" : "ммоль/л";
    const expectedMetrics = value.fixture.language === "en"
      ? ["Glucose", "Lactate", "Glucose"]
      : ["Глюкоза", "Лактат", "Глюкоза"];
    metricUnitDates.push(actuals.every((observation, index) => observation?.metric ===
      expectedMetrics[index] && observation.unit === expectedUnit));
    metricUnitDates.push(actuals[0]?.date === "2026-08-20" &&
      actuals[2]?.date === "2026-08-21" && actuals[0]?.metric === actuals[2]?.metric);
  }
  return Object.freeze({
    effectiveIntervals: Object.freeze(effectiveIntervals),
    metricUnitDates: Object.freeze(metricUnitDates),
    roles: Object.freeze(roles),
    versions: Object.freeze(versions)
  });
}

function positionedOcrChecks(evaluated: readonly EvaluatedFixture[]): Readonly<{
  fragmentContextIntegrity: readonly boolean[];
  lowConfidenceAbstention: readonly boolean[];
  repeatedHeaderIntegrity: readonly boolean[];
}> {
  const fragmentContextIntegrity: boolean[] = [];
  const lowConfidenceAbstention: boolean[] = [];
  const repeatedHeaderIntegrity: boolean[] = [];
  for (const value of evaluated) {
    const contract = value.fixture.contract.positionedOcr;
    if (contract === null) continue;
    const structuredTables = value.document.blocks.filter((block) => block.table !== null);
    const ambiguousBlocks = value.document.blocks.filter((block) =>
      block.type === "table" && block.table === null);
    if (contract.outcome === "abstained") {
      const ambiguousChunks = value.chunks.filter((chunk) =>
        chunk.contextPrefix.startsWith("Evidence layout: table_ambiguous_v1"));
      lowConfidenceAbstention.push(
        value.document.quality.ocrConfidence === contract.confidence &&
        structuredTables.length === 0 &&
        ambiguousBlocks.length === contract.fragmentCount &&
        ambiguousChunks.length === contract.fragmentCount &&
        ambiguousChunks.every((chunk) => chunk.documentContext === null &&
          chunk.sourceBlockIds.length === 1) &&
        value.document.warnings.includes("low_ocr_confidence") &&
        value.document.warnings.includes("table_extraction_degraded")
      );
      continue;
    }

    const [tableBlock] = structuredTables;
    const table = tableBlock?.table ?? null;
    const firstDataRow = value.fixture.contract.dataRowIndexes[0];
    const firstContext = firstDataRow === undefined
      ? null
      : contextsForRow(value, firstDataRow)[0] ?? null;
    const actual = firstContext ? tableObservation(firstContext, 2) : null;
    const version = firstContext ? tableObservation(firstContext, 3) : null;
    fragmentContextIntegrity.push(
      value.document.quality.ocrConfidence === contract.confidence &&
      structuredTables.length === 1 &&
      ambiguousBlocks.length === 0 &&
      table?.rowCount === value.fixture.contract.rowCount &&
      table.cells.length === contract.fragmentCount &&
      rowLocatorChecks(value).every(Boolean) &&
      actual?.date === "2026-08-20" &&
      actual.metric === "Глюкоза" &&
      actual.normalizedValue === "5.4" &&
      actual.role === "observation" &&
      actual.unit === "ммоль/л" &&
      version?.rawValue === "v4" &&
      version.role === "metadata" &&
      !value.document.warnings.includes("low_ocr_confidence") &&
      !value.document.warnings.includes("table_extraction_degraded")
    );
    if (value.fixture.contract.repeatedHeaderRowIndex !== null) {
      repeatedHeaderIntegrity.push(repeatedHeaderCheck(value));
    }
  }
  return Object.freeze({
    fragmentContextIntegrity: Object.freeze(fragmentContextIntegrity),
    lowConfidenceAbstention: Object.freeze(lowConfidenceAbstention),
    repeatedHeaderIntegrity: Object.freeze(repeatedHeaderIntegrity)
  });
}

function fieldGraphChecks(evaluated: readonly EvaluatedFixture[]): Readonly<{
  ambiguityDisclosure: readonly boolean[];
  falsePairs: number;
  pairRetention: readonly boolean[];
  versionRetention: readonly boolean[];
}> {
  const ambiguityDisclosure: boolean[] = [];
  const pairRetention: boolean[] = [];
  const versionRetention: boolean[] = [];
  let falsePairs = 0;
  for (const value of evaluated.filter((entry) => entry.fixture.contract.explicitFieldPairCount > 0)) {
    const explicitGroup = value.document.fieldGroups.find((group) => group.kind === "key_value");
    const ambiguousGroup = value.document.fieldGroups.find((group) => group.kind === "form");
    if (!explicitGroup || !ambiguousGroup) {
      pairRetention.push(false);
      ambiguityDisclosure.push(false);
      versionRetention.push(false);
      continue;
    }
    const explicitContexts = contextsForFixture(value).filter((context) =>
      context.locator.kind === "field_pair" && context.locator.fieldGroupId === explicitGroup.id);
    const ambiguousContexts = contextsForFixture(value).filter((context) =>
      context.locator.kind === "field_ambiguous" && context.locator.fieldGroupId === ambiguousGroup.id);
    falsePairs += contextsForFixture(value).filter((context) =>
      context.locator.kind === "field_pair" && context.locator.fieldGroupId === ambiguousGroup.id).length;
    pairRetention.push(explicitContexts.length === value.fixture.contract.explicitFieldPairCount);
    ambiguityDisclosure.push(ambiguousContexts.length === ambiguousGroup.cells.length &&
      ambiguousContexts.every((context) => context.ambiguityReasons.includes("competing_pair")));
    const versionKey = explicitGroup.cells.find((cell) => cell.label === "key" &&
      cell.text === "Version");
    const versionLink = explicitGroup.links.find((link) => link.sourceCellId === versionKey?.id &&
      link.label === "to_value");
    versionRetention.push(versionLink !== undefined && explicitContexts.some((context) =>
      context.locator.kind === "field_pair" && context.locator.labelCellId === versionKey?.id &&
      context.locator.valueCellId === versionLink.targetCellId &&
      context.observations[0]?.rawValue === "v2"));
  }
  return Object.freeze({
    ambiguityDisclosure: Object.freeze(ambiguityDisclosure),
    falsePairs,
    pairRetention: Object.freeze(pairRetention),
    versionRetention: Object.freeze(versionRetention)
  });
}

function arithmeticChecks(): Readonly<{
  tamperAcceptances: number;
  verification: readonly boolean[];
}> {
  const workbook = parseSpreadsheetDocument({
    bytes: Buffer.from(knowledgeDocumentContextArithmeticCsv),
    fileName: "document-context-decimals.csv",
    mimeType: "text/csv"
  }).workbook;
  if (!workbook) throw new Error("knowledge_document_context_fixture_workbook_missing");
  const plan: StructuredArithmeticPlan = Object.freeze({
    filters: Object.freeze([]),
    includeHidden: false,
    leftColumn: "Left",
    limit: 20,
    operation: "arithmetic",
    operator: "add",
    resultLabel: "Result",
    rightColumn: "Right",
    select: Object.freeze(["Locale"]),
    target: Object.freeze({ range: "A1:C3", sheet: "Sheet1" }),
    version: STRUCTURED_PLAN_VERSION
  });
  const result = executeStructuredPlan(workbook, plan);
  const changedWorkbook = parseSpreadsheetDocument({
    bytes: Buffer.from(knowledgeDocumentContextArithmeticCsv.replace("0.1;0.2", "0.1;0.4")),
    fileName: "document-context-decimals-changed.csv",
    mimeType: "text/csv"
  }).workbook;
  if (!changedWorkbook) throw new Error("knowledge_document_context_fixture_workbook_missing");
  const tampered = [
    Object.freeze({
      ...result,
      rows: Object.freeze(result.rows.map((row, index) =>
        index === 0 ? Object.freeze([row[0]!, 0.31]) : row))
    }),
    Object.freeze({
      ...result,
      receipt: Object.freeze({
        ...result.receipt,
        plan: Object.freeze({ ...result.receipt.plan, operator: "subtract" })
      })
    })
  ];
  const tamperAcceptances = tampered.filter((candidate) =>
    verifyStructuredAnalysisResult(workbook, candidate)).length +
    (verifyStructuredAnalysisResult(changedWorkbook, result) ? 1 : 0);
  return Object.freeze({
    tamperAcceptances,
    verification: Object.freeze([
      result.rows.length === 2 && result.rows.every((row) => row[1] === 0.3),
      verifyStructuredAnalysisResult(workbook, result)
    ])
  });
}

export function runKnowledgeDocumentContextIntegrityEval(): KnowledgeDocumentContextIntegrityReport {
  const evaluated = knowledgeDocumentContextIntegrityFixtures.map(evaluatedFixture);
  const allContexts = evaluated.flatMap(contextsForFixture);
  const observationChecks = observationContractChecks(evaluated);
  const fieldChecks = fieldGraphChecks(evaluated);
  const ocrChecks = positionedOcrChecks(evaluated);
  const arithmetic = arithmeticChecks();
  const contextRoundTrips = allContexts.map((context) =>
    decodeKnowledgeDocumentContext(JSON.parse(JSON.stringify(context)) as unknown) !== null);
  const decimalChecks = [
    normalizeKnowledgeObservationValue("5.40").normalizedValue === "5.4",
    normalizeKnowledgeObservationValue("5,40").normalizedValue === "5.4",
    normalizeKnowledgeObservationValue("1,234").normalizedValue === null
  ];
  const metrics = Object.freeze({
    ambiguityDisclosure: rate(fieldChecks.ambiguityDisclosure),
    ambiguousFieldFalsePairs: fieldChecks.falsePairs,
    arithmeticTamperAcceptances: arithmetic.tamperAcceptances,
    arithmeticVerification: rate(arithmetic.verification),
    decimalNormalization: rate(decimalChecks),
    effectiveIntervalRetention: rate(observationChecks.effectiveIntervals),
    explicitFieldPairRetention: rate(fieldChecks.pairRetention),
    headerLineageIntegrity: rate(evaluated.flatMap(headerLineageChecks)),
    lowConfidenceOcrAbstention: rate(ocrChecks.lowConfidenceAbstention),
    metricUnitDateIsolation: rate(observationChecks.metricUnitDates),
    normalizedRoundTrip: rate(evaluated.map((value) => value.normalizedRoundTrip)),
    ocrFragmentContextIntegrity: rate(ocrChecks.fragmentContextIntegrity),
    ocrRepeatedHeaderIntegrity: rate(ocrChecks.repeatedHeaderIntegrity),
    oversizedRowCoverage: rate(evaluated.map(oversizedRowCheck)),
    repeatedHeaderIntegrity: rate(evaluated.map(repeatedHeaderCheck)),
    roleBinding: rate(observationChecks.roles),
    rowLocatorIntegrity: rate([...evaluated.flatMap(rowLocatorChecks), ...contextRoundTrips]),
    versionMetadataRetention: rate([...observationChecks.versions, ...fieldChecks.versionRetention])
  });
  const gates = knowledgeDocumentContextIntegrityGates;
  const passed = metrics.ambiguityDisclosure === gates.ambiguityDisclosureMinimum &&
    metrics.ambiguousFieldFalsePairs === gates.ambiguousFieldFalsePairMaximum &&
    metrics.arithmeticTamperAcceptances === gates.arithmeticTamperAcceptanceMaximum &&
    metrics.arithmeticVerification === gates.arithmeticVerificationMinimum &&
    metrics.decimalNormalization === gates.decimalNormalizationMinimum &&
    metrics.effectiveIntervalRetention === gates.effectiveIntervalRetentionMinimum &&
    metrics.explicitFieldPairRetention === gates.explicitFieldPairRetentionMinimum &&
    metrics.headerLineageIntegrity === gates.headerLineageIntegrityMinimum &&
    metrics.lowConfidenceOcrAbstention === gates.lowConfidenceOcrAbstentionMinimum &&
    metrics.metricUnitDateIsolation === gates.metricUnitDateIsolationMinimum &&
    metrics.normalizedRoundTrip === gates.normalizedRoundTripMinimum &&
    metrics.ocrFragmentContextIntegrity === gates.ocrFragmentContextIntegrityMinimum &&
    metrics.ocrRepeatedHeaderIntegrity === gates.ocrRepeatedHeaderIntegrityMinimum &&
    metrics.oversizedRowCoverage === gates.oversizedRowCoverageMinimum &&
    metrics.repeatedHeaderIntegrity === gates.repeatedHeaderIntegrityMinimum &&
    metrics.roleBinding === gates.roleBindingMinimum &&
    metrics.rowLocatorIntegrity === gates.rowLocatorIntegrityMinimum &&
    metrics.versionMetadataRetention === gates.versionMetadataRetentionMinimum;
  return Object.freeze({
    aggregateOnly: true,
    corpus: Object.freeze({
      fixtureCount: evaluated.length,
      languages: Object.freeze({
        en: evaluated.filter((value) => value.fixture.language === "en").length,
        ru: evaluated.filter((value) => value.fixture.language === "ru").length
      }),
      provenance: "repository_generated_synthetic",
      version: KNOWLEDGE_DOCUMENT_CONTEXT_INTEGRITY_CORPUS_VERSION
    }),
    counts: Object.freeze({
      documentContextCount: allContexts.length,
      fieldGroupCount: evaluated.reduce((total, value) => total + value.document.fieldGroups.length, 0),
      positionedOcrFixtureCount: evaluated.filter((value) =>
        value.fixture.contract.positionedOcr !== null).length,
      positionedOcrFragmentCount: evaluated.reduce((total, value) => total +
        (value.fixture.contract.positionedOcr?.fragmentCount ?? 0), 0),
      tableRowCount: evaluated.reduce((total, value) => total +
        (value.fixture.contract.positionedOcr?.outcome === "abstained"
          ? 0
          : value.fixture.contract.rowCount), 0)
    }),
    gates,
    independentHumanLabelsUsed: false,
    metrics,
    passed,
    retrievalQualityGateEligible: false,
    scope: "deterministic_document_structure_contract",
    unavailable: Object.freeze([
      Object.freeze({
        field: "durable_retrieval_context_round_trip",
        reason: "requires_disposable_postgres_repository_lane"
      }),
      Object.freeze({
        field: "structured_document_version_field",
        reason: "document_context_v1_retains_version_as_metadata_only"
      })
    ]),
    version: KNOWLEDGE_DOCUMENT_CONTEXT_INTEGRITY_REPORT_VERSION
  });
}

export function assertKnowledgeDocumentContextIntegrityGates(
  report: KnowledgeDocumentContextIntegrityReport
): void {
  if (!report.passed) throw new Error("knowledge_document_context_integrity_gate_failed");
}
