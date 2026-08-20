import { describe, expect, it } from "vitest";
import {
  createKnowledgeFieldContextSegments,
  createKnowledgeTableDocumentContext,
  type KnowledgeDocumentContextV1
} from "./documentContext";
import {
  assessKnowledgeObservationGroundingV1,
  createKnowledgeObservationGroundingVocabularyV1
} from "./observationGrounding";

function tableContext(overrides: Readonly<{
  actual?: string;
  date?: string;
  metric?: string;
  reference?: string;
  unit?: string;
}> = {}): KnowledgeDocumentContextV1 {
  return createKnowledgeTableDocumentContext({
    blockId: `block-${overrides.metric ?? "Glucose"}-${overrides.date ?? "2026-08-20"}`,
    cells: [
      { columnEnd: 0, columnStart: 0, text: overrides.metric ?? "Glucose" },
      { columnEnd: 1, columnStart: 1, text: overrides.date ?? "2026-08-20" },
      { columnEnd: 2, columnStart: 2, text: overrides.actual ?? "10" },
      { columnEnd: 3, columnStart: 3, text: overrides.reference ?? "20" },
      { columnEnd: 4, columnStart: 4, text: overrides.unit ?? "mmol/L" }
    ],
    headerLineage: [
      { columnEnd: 0, columnStart: 0, rowIndex: 0, text: "Metric" },
      { columnEnd: 1, columnStart: 1, rowIndex: 0, text: "Date" },
      { columnEnd: 2, columnStart: 2, rowIndex: 0, text: "Actual" },
      { columnEnd: 3, columnStart: 3, rowIndex: 0, text: "Reference" },
      { columnEnd: 4, columnStart: 4, rowIndex: 0, text: "Unit" }
    ],
    rowIndex: 1
  });
}

function subjectContext(subject = "Alice"): KnowledgeDocumentContextV1 {
  return createKnowledgeTableDocumentContext({
    blockId: `block-subject-${subject}`,
    cells: [
      { columnEnd: 0, columnStart: 0, text: subject },
      { columnEnd: 1, columnStart: 1, text: "Glucose" },
      { columnEnd: 2, columnStart: 2, text: "10" },
      { columnEnd: 3, columnStart: 3, text: "mmol/L" }
    ],
    headerLineage: [
      { columnEnd: 0, columnStart: 0, rowIndex: 0, text: "Subject" },
      { columnEnd: 1, columnStart: 1, rowIndex: 0, text: "Metric" },
      { columnEnd: 2, columnStart: 2, rowIndex: 0, text: "Actual" },
      { columnEnd: 3, columnStart: 3, rowIndex: 0, text: "Unit" }
    ],
    rowIndex: 1
  });
}

function withObservationPeriod(
  context: KnowledgeDocumentContextV1,
  effectiveFrom: string,
  effectiveTo: string
): KnowledgeDocumentContextV1 {
  return Object.freeze({
    ...context,
    observations: Object.freeze(context.observations.map((observation) =>
      observation.role === "observation"
        ? Object.freeze({ ...observation, effectiveFrom, effectiveTo })
        : observation))
  });
}

describe("Knowledge observation grounding v1", () => {
  it("binds actual and reference values to their explicit roles", () => {
    const context = tableContext();
    const vocabulary = createKnowledgeObservationGroundingVocabularyV1([context]);

    expect(assessKnowledgeObservationGroundingV1({
      claim: "Glucose actual is 10 mmol/L on 2026-08-20.",
      context,
      vocabulary
    })).toMatchObject({ reasonCodes: [], supported: true });
    expect(assessKnowledgeObservationGroundingV1({
      claim: "Glucose reference is 20 mmol/L on 2026-08-20.",
      context,
      vocabulary
    })).toMatchObject({ reasonCodes: [], supported: true });
    expect(assessKnowledgeObservationGroundingV1({
      claim: "Glucose actual is 20 mmol/L on 2026-08-20.",
      context,
      vocabulary
    })).toMatchObject({ reasonCodes: ["observation_context_mismatch"], supported: false });
    expect(assessKnowledgeObservationGroundingV1({
      claim: "Glucose reference is 10 mmol/L on 2026-08-20.",
      context,
      vocabulary
    })).toMatchObject({ reasonCodes: ["observation_context_mismatch"], supported: false });
  });

  it.each([
    "Glucose normal is 10 mmol/L.",
    "Glucose normal value is 10 mmol/L.",
    "Glucose expected is 10 mmol/L.",
    "Glucose baseline is 10 mmol/L.",
    "Показатель Glucose: норматив 10 mmol/L.",
    "Показатель Glucose: плановый 10 mmol/L."
  ])("does not collapse a reference or target role cue into actual: %s", (claim) => {
    expect(assessKnowledgeObservationGroundingV1({ claim, context: tableContext() })).toMatchObject({
      reasonCodes: ["observation_context_mismatch"],
      supported: false
    });
  });

  it("does not reinterpret source-attribution prose as an unknown metric", () => {
    const context = tableContext();

    expect(assessKnowledgeObservationGroundingV1({
      claim: "According to the selected evidence, Glucose actual is 10 mmol/L.",
      context
    })).toMatchObject({ reasonCodes: [], supported: true });
  });

  it("distinguishes metrics that share the same unit and value", () => {
    const alpha = tableContext({ metric: "Alpha" });
    const beta = tableContext({ metric: "Beta" });
    const vocabulary = createKnowledgeObservationGroundingVocabularyV1([alpha, beta]);

    expect(assessKnowledgeObservationGroundingV1({
      claim: "The Alpha metric actual is 10 mmol/L.",
      context: beta,
      vocabulary
    })).toMatchObject({ reasonCodes: ["observation_context_mismatch"], supported: false });
    expect(assessKnowledgeObservationGroundingV1({
      claim: "The Beta metric actual is 10 mmol/L.",
      context: beta,
      vocabulary
    })).toMatchObject({ reasonCodes: [], supported: true });
  });

  it.each([
    "Temperature actual is 10 mmol/L.",
    "Sodium actual is 10 mmol/L.",
    "Blood pressure actual is 10 mmol/L.",
    "Hemoglobin actual is 10 mmol/L.",
    "XYZ actual is 10 mmol/L."
  ])("does not ignore an explicit metric absent from typed evidence: %s", (claim) => {
    const context = tableContext({ metric: "Glucose" });
    const vocabulary = createKnowledgeObservationGroundingVocabularyV1([context]);

    expect(assessKnowledgeObservationGroundingV1({ claim, context, vocabulary })).toMatchObject({
      reasonCodes: ["observation_context_mismatch"],
      supported: false
    });
  });

  it.each([
    "Bob Glucose actual is 10 mmol/L.",
    "Боб Glucose: факт 10 mmol/L.",
    "Alice Temperature actual is 10 mmol/L.",
    "Bob Temperature actual is 10 mmol/L.",
    "Боб Температура: факт 10 mmol/L."
  ])("does not ignore an explicit subject absent from typed evidence: %s", (claim) => {
    const context = subjectContext();
    const vocabulary = createKnowledgeObservationGroundingVocabularyV1([context]);

    expect(assessKnowledgeObservationGroundingV1({
      claim: "Alice Glucose actual is 10 mmol/L.",
      context,
      vocabulary
    })).toMatchObject({ reasonCodes: [], supported: true });
    expect(assessKnowledgeObservationGroundingV1({ claim, context, vocabulary })).toMatchObject({
      reasonCodes: ["observation_context_mismatch"],
      supported: false
    });
  });

  it("binds the same metric and value to the exact observation date", () => {
    const context = tableContext({ date: "2026-08-20" });

    expect(assessKnowledgeObservationGroundingV1({
      claim: "Glucose actual is 10 on date 2026-08-20.",
      context
    })).toMatchObject({ reasonCodes: [], supported: true });
    expect(assessKnowledgeObservationGroundingV1({
      claim: "Glucose actual is 10 on date 2026-08-21.",
      context
    })).toMatchObject({ reasonCodes: ["observation_context_mismatch"], supported: false });
  });

  it.each([
    ["Revenue actual is 100 in 2024.", "Revenue actual is 100 in 2025."],
    ["Показатель Revenue: факт 100 в 2024 году.", "Показатель Revenue: факт 100 в 2025 году."]
  ])("binds a bare EN/RU year to an exact observation period: %s", (accepted, rejected) => {
    const context = withObservationPeriod(
      tableContext({ actual: "100", metric: "Revenue", unit: "USD" }),
      "2024-01-01",
      "2024-12-31"
    );

    expect(assessKnowledgeObservationGroundingV1({ claim: accepted, context }))
      .toMatchObject({ reasonCodes: [], supported: true });
    expect(assessKnowledgeObservationGroundingV1({ claim: rejected, context })).toMatchObject({
      reasonCodes: ["observation_context_mismatch"],
      supported: false
    });
  });

  it("binds a quarter cue to its exact observation period", () => {
    const context = withObservationPeriod(
      tableContext({ actual: "100", metric: "Revenue", unit: "USD" }),
      "2026-01-01",
      "2026-03-31"
    );

    expect(assessKnowledgeObservationGroundingV1({
      claim: "Revenue actual is 100 in Q1 2026.",
      context
    })).toMatchObject({ reasonCodes: [], supported: true });
    expect(assessKnowledgeObservationGroundingV1({
      claim: "Revenue actual is 100 in Q2 2026.",
      context
    })).toMatchObject({ reasonCodes: ["observation_context_mismatch"], supported: false });
    expect(assessKnowledgeObservationGroundingV1({
      claim: "In Q1 2026, Revenue actual is 100.",
      context
    })).toMatchObject({ reasonCodes: [], supported: true });
    expect(assessKnowledgeObservationGroundingV1({
      claim: "In 2026 Q1, Revenue actual is 100.",
      context
    })).toMatchObject({ reasonCodes: [], supported: true });
  });

  it("does not reinterpret comma or point thousands ambiguity as a decimal", () => {
    const context = tableContext({ actual: "1234" });

    for (const claim of ["Actual is 1,234.", "Actual is 1.234."]) {
      expect(assessKnowledgeObservationGroundingV1({ claim, context })).toMatchObject({
        reasonCodes: ["ambiguous_claim"],
        supported: false
      });
    }
  });

  it("normalizes an unambiguous Russian decimal comma without losing role, unit, or date", () => {
    const context = tableContext({ actual: "5,4", metric: "Глюкоза", unit: "ммоль/л" });

    expect(assessKnowledgeObservationGroundingV1({
      claim: "Показатель Глюкоза: факт 5,4 ммоль/л, дата 20.08.2026.",
      context
    })).toMatchObject({ reasonCodes: [], supported: true });
  });

  it.each([
    {
      actual: "5.4",
      accepted: "Glucose actual is 5.4mmol/L.",
      metric: "Glucose",
      rejectedUnit: "Glucose actual is 5.4mg/L.",
      rejectedValue: "Glucose actual is 5.5mmol/L.",
      unit: "mmol/L"
    },
    {
      actual: "142",
      accepted: "Hemoglobin actual is 142g/L.",
      metric: "Hemoglobin",
      rejectedUnit: "Hemoglobin actual is 142mg/L.",
      rejectedValue: "Hemoglobin actual is 143g/L.",
      unit: "g/L"
    },
    {
      actual: "37",
      accepted: "Temperature actual is 37°C.",
      metric: "Temperature",
      rejectedUnit: "Temperature actual is 37°F.",
      rejectedValue: "Temperature actual is 38°C.",
      unit: "°C"
    },
    {
      actual: "99",
      accepted: "Показатель Доза: факт 99мг.",
      metric: "Доза",
      rejectedUnit: "Показатель Доза: факт 99мкг.",
      rejectedValue: "Показатель Доза: факт 98мг.",
      unit: "мг"
    }
  ])("binds an attached EN/RU unit to its exact typed value: $accepted", ({
    accepted,
    actual,
    metric,
    rejectedUnit,
    rejectedValue,
    unit
  }) => {
    const context = tableContext({ actual, metric, unit });

    expect(assessKnowledgeObservationGroundingV1({ claim: accepted, context }))
      .toMatchObject({ reasonCodes: [], supported: true });
    for (const claim of [rejectedUnit, rejectedValue]) {
      expect(assessKnowledgeObservationGroundingV1({ claim, context })).toMatchObject({
        reasonCodes: ["observation_context_mismatch"],
        supported: false
      });
    }
  });

  it("normalizes scientific claim notation without allowing a numeric bypass", () => {
    const context = tableContext({ actual: "1000", metric: "Count", unit: "mg" });

    expect(assessKnowledgeObservationGroundingV1({
      claim: "Count actual is 1e3mg.",
      context
    })).toMatchObject({ reasonCodes: [], supported: true });
    expect(assessKnowledgeObservationGroundingV1({
      claim: "Count actual is 1e4mg.",
      context
    })).toMatchObject({ reasonCodes: ["observation_context_mismatch"], supported: false });
    expect(assessKnowledgeObservationGroundingV1({
      claim: "Count actual is 1e3g.",
      context
    })).toMatchObject({ reasonCodes: ["observation_context_mismatch"], supported: false });
  });

  it("preserves a Unicode minus as the scalar sign", () => {
    const negative = tableContext({ actual: "-5", metric: "Temperature", unit: "°C" });
    const positive = tableContext({ actual: "5", metric: "Temperature", unit: "°C" });
    const claim = "Temperature actual is −5°C.";

    expect(assessKnowledgeObservationGroundingV1({ claim, context: negative }))
      .toMatchObject({ reasonCodes: [], supported: true });
    expect(assessKnowledgeObservationGroundingV1({ claim, context: positive })).toMatchObject({
      reasonCodes: ["observation_context_mismatch"],
      supported: false
    });
  });

  it("binds attached and spaced superscript units without collapsing m² and m³", () => {
    const context = tableContext({ actual: "5", metric: "Area", unit: "m²" });

    for (const claim of ["Area actual is 5m².", "Area actual is 5 m²."]) {
      expect(assessKnowledgeObservationGroundingV1({ claim, context }))
        .toMatchObject({ reasonCodes: [], supported: true });
    }
    for (const claim of ["Area actual is 5m³.", "Area actual is 5 m³."]) {
      expect(assessKnowledgeObservationGroundingV1({ claim, context })).toMatchObject({
        reasonCodes: ["observation_context_mismatch"],
        supported: false
      });
    }
  });

  it("fails closed for numeric comparison semantics absent from typed observations", () => {
    const context = tableContext({ actual: "5", metric: "Count", unit: "mg" });

    expect(assessKnowledgeObservationGroundingV1({
      claim: "Count actual is 5mg.",
      context
    })).toMatchObject({ reasonCodes: [], supported: true });
    for (const claim of [
      "Count actual is <5mg.",
      "Count actual is >5mg.",
      "Count actual is <=5mg.",
      "Count actual is >=5mg.",
      "Count actual is ≤5mg.",
      "Count actual is ≥5mg.",
      "Count actual is at least 5mg.",
      "Count actual is below 5mg.",
      "Count actual is above 5mg.",
      "Count actual is under 5mg.",
      "Count actual is over 5mg.",
      "Count actual is maximum 5mg.",
      "Count actual is minimum 5mg.",
      "Count actual is at or below 5mg.",
      "Count actual is at or above 5mg.",
      "Показатель Count: факт не менее 5mg.",
      "Показатель Count: факт выше 5mg."
    ]) {
      expect(assessKnowledgeObservationGroundingV1({ claim, context })).toMatchObject({
        reasonCodes: ["ambiguous_claim"],
        supported: false
      });
    }
  });

  it.each([
    "Glucose actual ranges from 10 to 20 mmol/L.",
    "Glucose actual is between 10 and 20 mmol/L.",
    "Показатель Glucose: факт от 10 до 20 mmol/L.",
    "Показатель Glucose: факт между 10 и 20 mmol/L."
  ])("requires one typed range instead of joining values across roles: %s", (claim) => {
    const splitRoles = tableContext({ actual: "10", reference: "20" });
    const range = tableContext({ actual: "10–20", reference: "30" });

    expect(assessKnowledgeObservationGroundingV1({ claim, context: splitRoles })).toMatchObject({
      reasonCodes: ["observation_context_mismatch"],
      supported: false
    });
    expect(assessKnowledgeObservationGroundingV1({ claim, context: range }))
      .toMatchObject({ reasonCodes: [], supported: true });
  });

  it("binds optional v-prefixed EN/RU Source-version cues", () => {
    const context = tableContext();

    for (const claim of [
      "In source version v3, Glucose actual is 10 mmol/L.",
      "В версии v3 показатель Glucose: факт 10 mmol/L.",
      "In v3, Glucose actual is 10 mmol/L.",
      "(v3) Glucose actual is 10 mmol/L."
    ]) {
      expect(assessKnowledgeObservationGroundingV1({
        claim,
        context,
        sourceVersionNumber: 3
      })).toMatchObject({ reasonCodes: [], supported: true });
      expect(assessKnowledgeObservationGroundingV1({
        claim,
        context,
        sourceVersionNumber: 2
      })).toMatchObject({ reasonCodes: ["observation_context_mismatch"], supported: false });
    }
  });

  it("checks effective interval endpoints on the same observation", () => {
    const segments = createKnowledgeFieldContextSegments({
      cells: [
        { confidence: 0.99, id: 1, label: "key", order: 0, text: "Metric" },
        { confidence: 0.99, id: 2, label: "value", order: 1, text: "Glucose" },
        { confidence: 0.99, id: 3, label: "key", order: 2, text: "Actual" },
        { confidence: 0.99, id: 4, label: "value", order: 3, text: "10" },
        { confidence: 0.99, id: 5, label: "key", order: 4, text: "Effective from" },
        { confidence: 0.99, id: 6, label: "value", order: 5, text: "2026-08-01" },
        { confidence: 0.99, id: 7, label: "key", order: 6, text: "Effective to" },
        { confidence: 0.99, id: 8, label: "value", order: 7, text: "2026-08-31" }
      ],
      confidence: 0.99,
      id: "field-effective",
      links: [1, 3, 5, 7].flatMap((labelCellId) => [{
        confidence: 0.99,
        label: "to_value" as const,
        sourceCellId: labelCellId,
        targetCellId: labelCellId + 1
      }])
    });
    const context = segments.find((segment) => segment.text === "Actual\t10")!.context;

    expect(assessKnowledgeObservationGroundingV1({
      claim: "Glucose actual is 10, effective from 2026-08-01, effective until 2026-08-31.",
      context
    })).toMatchObject({ reasonCodes: [], supported: true });
    expect(assessKnowledgeObservationGroundingV1({
      claim: "Glucose actual is 10, effective from 2026-08-02, effective until 2026-08-31.",
      context
    })).toMatchObject({ reasonCodes: ["observation_context_mismatch"], supported: false });
  });

  it("binds explicit English and Russian Source version claims to evidence metadata", () => {
    const context = tableContext();

    expect(assessKnowledgeObservationGroundingV1({
      claim: "In source version 2, Glucose actual is 10.",
      context,
      sourceVersionNumber: 2
    })).toMatchObject({ reasonCodes: [], supported: true });
    expect(assessKnowledgeObservationGroundingV1({
      claim: "In source version 2, Glucose actual is 10.",
      context,
      sourceVersionNumber: 3
    })).toMatchObject({ reasonCodes: ["observation_context_mismatch"], supported: false });
    expect(assessKnowledgeObservationGroundingV1({
      claim: "В версии 2 факт равен 10.",
      context,
      sourceVersionNumber: 2
    })).toMatchObject({ reasonCodes: [], supported: true });
  });

  it("abstains for ambiguous document context even when the raw text contains the value", () => {
    const context = createKnowledgeTableDocumentContext({
      blockId: "block-ambiguous",
      cells: [{ columnEnd: 0, columnStart: 0, text: "10" }],
      headerLineage: [],
      rowIndex: 1
    });

    expect(assessKnowledgeObservationGroundingV1({ claim: "Actual is 10.", context })).toMatchObject({
      reasonCodes: ["ambiguous_context"],
      supported: false
    });
  });
});
