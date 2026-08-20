import { createHash } from "node:crypto";
import {
  KNOWLEDGE_EVIDENCE_CITATION_CONTRACT,
  type KnowledgeEvidencePackage,
  type KnowledgeEvidencePackageItem
} from "../../lib/server/knowledge/evidencePackage";
import type {
  KnowledgeSemanticClaimType,
  KnowledgeSemanticGroundingDecision
} from "../../lib/server/knowledge/semanticGrounding";

export const KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION =
  "knowledge-semantic-grounding-corpus-v3";

export const knowledgeSemanticGroundingSlices = Object.freeze([
  "citation_neighborhood",
  "contradiction",
  "coverage_claim",
  "date_consistency",
  "derived_arithmetic",
  "direct_entailment",
  "generic_entailment",
  "general_knowledge",
  "list_segmentation",
  "locator_correctness",
  "markdown_table_segmentation",
  "no_answer",
  "numeric_consistency",
  "reference_context",
  "temporal_non_contradiction",
  "uncertainty",
  "version_attribution"
] as const);

export type KnowledgeSemanticGroundingSlice =
  typeof knowledgeSemanticGroundingSlices[number];
/** Evaluation split names are part of the frozen corpus contract. */
export type KnowledgeSemanticGroundingSplit =
  | "development"
  | "calibration"
  | "held_out"
  | "blinded_review";
export type KnowledgeSemanticGroundingLanguage = "en" | "ru";

export type KnowledgeSemanticGroundingLabel = Readonly<{
  attributableHandles: readonly string[];
  claimOrdinal: number;
  decision: KnowledgeSemanticGroundingDecision;
  slices: readonly KnowledgeSemanticGroundingSlice[];
  type: KnowledgeSemanticClaimType;
}>;

export type KnowledgeSemanticGroundingArithmeticPlan = Readonly<{
  assertedOutput: string;
  citationHandle: string;
  claimOrdinal: number;
  operands: readonly string[];
  operation: "add" | "subtract";
  outputUnit: string | null;
}>;

export type KnowledgeSemanticGroundingFixture = Readonly<{
  answer: string;
  arithmeticPlans: readonly KnowledgeSemanticGroundingArithmeticPlan[];
  documentFamily: string;
  evidence: KnowledgeEvidencePackage;
  id: string;
  labels: readonly KnowledgeSemanticGroundingLabel[];
  language: KnowledgeSemanticGroundingLanguage;
  split: KnowledgeSemanticGroundingSplit;
}>;

function item(
  fixtureId: string,
  ordinal: number,
  excerpt: string,
  overrides: Partial<KnowledgeEvidencePackageItem> = {}
): KnowledgeEvidencePackageItem {
  return Object.freeze({
    baseName: "Generated semantic benchmark",
    contentHash: createHash("sha256").update(excerpt, "utf8").digest("hex"),
    contextBoundaries: Object.freeze({
      expanded: false,
      excerptBytes: Buffer.byteLength(excerpt),
      sourceTextBytes: Buffer.byteLength(excerpt)
    }),
    documentId: `${fixtureId}-document-${ordinal}`,
    documentVersionId: `${fixtureId}-document-version-${ordinal}`,
    excerpt,
    fileName: `${fixtureId}-${ordinal}.md`,
    handle: `K${ordinal}`,
    headingPath: Object.freeze(["Generated benchmark section"]),
    id: `${fixtureId}-evidence-${ordinal}`,
    knowledgeBaseId: `${fixtureId}-base`,
    locator: Object.freeze({ page: ordinal }),
    ordinal,
    passageId: `${fixtureId}-passage-${ordinal}`,
    provenance: Object.freeze([]),
    sectionId: `${fixtureId}-section-${ordinal}`,
    sourceArtifactId: `${fixtureId}-artifact-${ordinal}`,
    sourceId: `${fixtureId}-source-${ordinal}`,
    sourceName: `Generated source ${ordinal}`,
    sourceVersionId: `${fixtureId}-source-version-${ordinal}`,
    sourceVersionNumber: ordinal,
    state: "available",
    textTruncated: false,
    ...overrides
  });
}

function evidence(input: Readonly<{
  fixtureId: string;
  items?: readonly KnowledgeEvidencePackageItem[];
  query: string;
}>): KnowledgeEvidencePackage {
  const items = input.items ?? [];
  return Object.freeze({
    citationContract: KNOWLEDGE_EVIDENCE_CITATION_CONTRACT,
    coverage: Object.freeze({
      expectedPassageCount: null,
      mode: "partial" as const,
      namedTargets: Object.freeze([]),
      verified: false
    }),
    degradedFlags: Object.freeze([]),
    items: Object.freeze([...items]),
    originalIntent: Object.freeze({ intent: "fact_lookup" as const, query: input.query }),
    readiness: Object.freeze({
      excludedResources: 0,
      readyBases: items.length > 0 ? 1 : 0,
      readySources: items.length
    }),
    runId: `${input.fixtureId}-run`,
    scopeSnapshot: Object.freeze({ selection: "generated_semantic_benchmark" }),
    sessionId: `${input.fixtureId}-session`,
    strategy: "focused" as const,
    version: 2 as const
  });
}

function label(
  claimOrdinal: number,
  decision: KnowledgeSemanticGroundingDecision,
  type: KnowledgeSemanticClaimType,
  attributableHandles: readonly string[],
  slices: readonly KnowledgeSemanticGroundingSlice[]
): KnowledgeSemanticGroundingLabel {
  return Object.freeze({
    attributableHandles: Object.freeze([...attributableHandles]),
    claimOrdinal,
    decision,
    slices: Object.freeze([...slices]),
    type
  });
}

function fixture(input: Omit<KnowledgeSemanticGroundingFixture, "evidence" | "arithmeticPlans"> & Readonly<{
  arithmeticPlans?: readonly KnowledgeSemanticGroundingArithmeticPlan[];
  items?: readonly KnowledgeEvidencePackageItem[];
  query: string;
}>): KnowledgeSemanticGroundingFixture {
  return Object.freeze({
    answer: input.answer,
    arithmeticPlans: Object.freeze([...(input.arithmeticPlans ?? [])]),
    documentFamily: input.documentFamily,
    evidence: evidence({ fixtureId: input.id, items: input.items, query: input.query }),
    id: input.id,
    labels: Object.freeze([...input.labels]),
    language: input.language,
    split: input.split
  });
}

type GeneratedReleaseClaim = Readonly<{
  ambiguous?: boolean;
  answer: string;
  arithmetic?: Omit<KnowledgeSemanticGroundingArithmeticPlan,
    "citationHandle" | "claimOrdinal">;
  citeEvidence?: boolean;
  decision: KnowledgeSemanticGroundingDecision;
  evidence: readonly string[];
  slices: readonly KnowledgeSemanticGroundingSlice[];
  type: KnowledgeSemanticClaimType;
}>;

type GeneratedReleaseScenario = Readonly<{
  category: string;
  claims: readonly [GeneratedReleaseClaim, GeneratedReleaseClaim];
  familyKey: string;
  language: KnowledgeSemanticGroundingLanguage;
  query: string;
  split: KnowledgeSemanticGroundingSplit;
  table?: Readonly<{ firstColumn: string; rows: readonly [string, string] }>;
}>;

function generatedReleaseFixture(
  input: GeneratedReleaseScenario
): KnowledgeSemanticGroundingFixture {
  const splitPrefix = input.split === "blinded_review"
    ? "blind"
    : input.split === "held_out"
      ? "held"
      : input.split === "calibration"
        ? "cal"
        : "dev";
  const fixtureId = `${splitPrefix}-release-${input.language}-${input.category}-${input.familyKey}`;
  let evidenceOrdinal = 0;
  const claimEvidence = input.claims.map((claim) => {
    const entries = claim.evidence.map((excerpt) => {
      evidenceOrdinal += 1;
      const excerptBytes = Buffer.byteLength(excerpt);
      return item(fixtureId, evidenceOrdinal, excerpt, claim.ambiguous
        ? {
            contextBoundaries: {
              expanded: false,
              excerptBytes,
              layoutKind: "field_ambiguous",
              sourceTextBytes: excerptBytes
            }
          }
        : {});
    });
    const citeEvidence = claim.citeEvidence ?? entries.length > 0;
    return Object.freeze({
      entries: Object.freeze(entries),
      handles: Object.freeze(citeEvidence ? entries.map((entry) => entry.handle) : [])
    });
  });
  const withCitations = (claimIndex: number): string => {
    const citations = claimEvidence[claimIndex]!.handles.map((handle) => `[${handle}]`).join(" ");
    return `${input.claims[claimIndex]!.answer}${citations ? ` ${citations}` : ""}`;
  };
  const answer = input.table
    ? [
        `| ${input.table.firstColumn} | ${input.language === "en" ? "Finding" : "Результат"} |`,
        "| --- | --- |",
        `| ${input.table.rows[0]} | ${withCitations(0)} |`,
        `| ${input.table.rows[1]} | ${withCitations(1)} |`
      ].join("\n")
    : input.claims.map((_claim, index) => `- ${withCitations(index)}`).join("\n");

  return fixture({
    answer,
    arithmeticPlans: input.claims.flatMap((claim, index) => claim.arithmetic
      ? [Object.freeze({
          ...claim.arithmetic,
          citationHandle: claimEvidence[index]!.handles[0]!,
          claimOrdinal: index + 1
        })]
      : []),
    documentFamily: `${splitPrefix}-release-${input.language}-${input.category}-${input.familyKey}`,
    id: fixtureId,
    items: claimEvidence.flatMap((entry) => entry.entries),
    labels: input.claims.map((claim, index) => label(
      index + 1,
      claim.decision,
      claim.type,
      claimEvidence[index]!.handles,
      claim.slices
    )),
    language: input.language,
    query: input.query,
    split: input.split
  });
}

const calibrationFixtures: readonly KnowledgeSemanticGroundingFixture[] = Object.freeze([
  fixture({
    answer: "Atlas exports remain available for 37 days [K1].",
    documentFamily: "cal-atlas-retention",
    id: "cal-en-direct",
    items: [item("cal-en-direct", 1, "Atlas exports remain available for 37 days.")],
    labels: [label(1, "supported", "source_fact", ["K1"], [
      "direct_entailment", "numeric_consistency", "locator_correctness"
    ])],
    language: "en",
    query: "How long are Atlas exports available?",
    split: "calibration"
  }),
  fixture({
    answer: "Employees are permitted to work remotely on Fridays [K1].",
    documentFamily: "cal-remote-work",
    id: "cal-en-paraphrase",
    items: [item("cal-en-paraphrase", 1, "Staff members may work from home each Friday.")],
    labels: [label(1, "supported", "source_fact", ["K1"], [
      "generic_entailment", "locator_correctness"
    ])],
    language: "en",
    query: "May employees work remotely on Fridays?",
    split: "calibration"
  }),
  fixture({
    answer: "Remote work on Fridays is prohibited [K1].",
    documentFamily: "cal-access-modality",
    id: "cal-en-contradiction",
    items: [item("cal-en-contradiction", 1, "Staff members are permitted to work remotely on Fridays.")],
    labels: [label(1, "contradicted", "source_fact", ["K1"], [
      "contradiction", "generic_entailment"
    ])],
    language: "en",
    query: "Is Friday remote work permitted?",
    split: "calibration"
  }),
  fixture({
    answer: "The notice period is 60 days [K1].",
    documentFamily: "cal-notice-period",
    id: "cal-en-number",
    items: [item("cal-en-number", 1, "The notice period is 30 days.")],
    labels: [label(1, "contradicted", "source_fact", ["K1"], [
      "contradiction", "numeric_consistency", "reference_context"
    ])],
    language: "en",
    query: "What is the notice period?",
    split: "calibration"
  }),
  fixture({
    answer: "I couldn't find the commissioning permit in the selected sources.",
    documentFamily: "cal-missing-commissioning-permit",
    id: "cal-en-no-answer",
    labels: [label(1, "supported", "source_summary", [], ["no_answer"])],
    language: "en",
    query: "Where is the commissioning permit?",
    split: "calibration"
  }),
  fixture({
    answer: "Материалы проекта Береста хранятся 45 дней [K1].",
    documentFamily: "cal-beresta-retention",
    id: "cal-ru-direct",
    items: [item("cal-ru-direct", 1, "Архив проекта Береста сохраняет материалы в течение 45 дней.")],
    labels: [label(1, "supported", "source_fact", ["K1"], [
      "generic_entailment", "numeric_consistency", "locator_correctness"
    ])],
    language: "ru",
    query: "Сколько хранятся материалы Береста?",
    split: "calibration"
  }),
  fixture({
    answer: "Удалённый доступ для подрядчиков запрещён [K1].",
    documentFamily: "cal-ru-contractor-access",
    id: "cal-ru-contradiction",
    items: [item("cal-ru-contradiction", 1, "Удалённый доступ для подрядчиков разрешён.")],
    labels: [label(1, "contradicted", "source_fact", ["K1"], [
      "contradiction", "generic_entailment"
    ])],
    language: "ru",
    query: "Разрешён ли подрядчикам удалённый доступ?",
    split: "calibration"
  }),
  fixture({
    answer: "03.01.2030 показатель Альфа равен 41,2 ед/л [K1].",
    documentFamily: "cal-alpha-observation",
    id: "cal-ru-date",
    items: [item("cal-ru-date", 1, "03.01.2030: показатель Альфа 41.2 ед/л.")],
    labels: [label(1, "supported", "temporal_observation", ["K1"], [
      "date_consistency", "numeric_consistency", "temporal_non_contradiction"
    ])],
    language: "ru",
    query: "Каково значение Альфа 03.01.2030?",
    split: "calibration"
  }),
  fixture({
    answer: [
      "- Team Cedar uses the Indigo tier [K1].",
      "- Indigo approval is required within 4 hours [K2]."
    ].join("\n"),
    documentFamily: "cal-cedar-indigo",
    id: "cal-en-list",
    items: [
      item("cal-en-list", 1, "Team Cedar uses the Indigo tier."),
      item("cal-en-list", 2, "The Indigo tier requires approval within 4 hours.")
    ],
    labels: [
      label(1, "supported", "source_fact", ["K1"], ["direct_entailment", "list_segmentation"]),
      label(2, "supported", "source_fact", ["K2"], [
        "direct_entailment", "list_segmentation", "numeric_consistency"
      ])
    ],
    language: "en",
    query: "Describe Cedar's approval requirement.",
    split: "calibration"
  }),
  fixture({
    answer: [
      "| Версия | Срок |",
      "| --- | --- |",
      "| 2025 | 30 дней [K1] |",
      "| 2026 | 14 дней [K2] |"
    ].join("\n"),
    documentFamily: "cal-ru-version-table",
    id: "cal-ru-table",
    items: [
      item("cal-ru-table", 1, "Версия 2025 требует уведомление за 30 дней.", {
        sourceVersionNumber: 1
      }),
      item("cal-ru-table", 2, "Версия 2026 требует уведомление за 14 дней.", {
        sourceVersionNumber: 2
      })
    ],
    labels: [
      label(1, "supported", "versioned_fact", ["K1"], [
        "markdown_table_segmentation", "numeric_consistency", "version_attribution"
      ]),
      label(2, "supported", "versioned_fact", ["K2"], [
        "markdown_table_segmentation", "numeric_consistency", "version_attribution"
      ])
    ],
    language: "ru",
    query: "Сравни сроки в версиях 2025 и 2026.",
    split: "calibration"
  })
]);

const heldOutFixtures: readonly KnowledgeSemanticGroundingFixture[] = Object.freeze([
  fixture({
    answer: "Operators can pause the queue after midnight [K1].",
    documentFamily: "held-queue-controls",
    id: "held-en-paraphrase",
    items: [item("held-en-paraphrase", 1, "After 00:00, queue suspension is available to operators.")],
    labels: [label(1, "supported", "source_fact", ["K1"], ["generic_entailment"])],
    language: "en",
    query: "Can operators pause the queue after midnight?",
    split: "held_out"
  }),
  fixture({
    answer: "Сотрудники вправе работать из дома по пятницам [K1].",
    documentFamily: "held-ru-homework",
    id: "held-ru-paraphrase",
    items: [item("held-ru-paraphrase", 1, "Персоналу разрешена удалённая работа каждую пятницу.")],
    labels: [label(1, "supported", "source_fact", ["K1"], ["generic_entailment"])],
    language: "ru",
    query: "Можно ли сотрудникам работать из дома по пятницам?",
    split: "held_out"
  }),
  fixture({
    answer: "Vega uses the Cobalt approval tier [K1].",
    documentFamily: "held-vega-tier",
    id: "held-en-unsupported",
    items: [item("held-en-unsupported", 1, "Vega uses the Amber approval tier.")],
    labels: [label(1, "unsupported", "source_fact", ["K1"], ["generic_entailment"])],
    language: "en",
    query: "Which approval tier does Vega use?",
    split: "held_out"
  }),
  fixture({
    answer: "Шлюз Север использует протокол Орион [K1].",
    documentFamily: "held-ru-gateway-protocol",
    id: "held-ru-unsupported",
    items: [item("held-ru-unsupported", 1, "Шлюз Север использует протокол Вега.")],
    labels: [label(1, "unsupported", "source_fact", ["K1"], ["generic_entailment"])],
    language: "ru",
    query: "Какой протокол использует шлюз Север?",
    split: "held_out"
  }),
  fixture({
    answer: "Guest export is enabled [K1].",
    documentFamily: "held-guest-export",
    id: "held-en-negation",
    items: [item("held-en-negation", 1, "Guest export is disabled.")],
    labels: [label(1, "contradicted", "source_fact", ["K1"], [
      "contradiction", "generic_entailment"
    ])],
    language: "en",
    query: "Is guest export enabled?",
    split: "held_out"
  }),
  fixture({
    answer: "Анонимная публикация включена [K1].",
    documentFamily: "held-ru-anonymous-sharing",
    id: "held-ru-negation",
    items: [item("held-ru-negation", 1, "Анонимная публикация отключена.")],
    labels: [label(1, "contradicted", "source_fact", ["K1"], [
      "contradiction", "generic_entailment"
    ])],
    language: "ru",
    query: "Включена ли анонимная публикация?",
    split: "held_out"
  }),
  fixture({
    answer: [
      "- The 2025 version requires 30 days of notice [K1].",
      "- The 2026 version requires 14 days of notice [K2]."
    ].join("\n"),
    documentFamily: "held-zephyr-version-history",
    id: "held-en-version-history",
    items: [
      item("held-en-version-history", 1, "The 2025 Zephyr contract requires 30 days of notice.", {
        sourceVersionNumber: 1
      }),
      item("held-en-version-history", 2, "The 2026 Zephyr contract requires 14 days of notice.", {
        sourceVersionNumber: 2
      })
    ],
    labels: [
      label(1, "supported", "versioned_fact", ["K1"], [
        "list_segmentation", "numeric_consistency", "version_attribution"
      ]),
      label(2, "supported", "versioned_fact", ["K2"], [
        "list_segmentation", "numeric_consistency", "version_attribution"
      ])
    ],
    language: "en",
    query: "Compare the 2025 and 2026 Zephyr notice periods.",
    split: "held_out"
  }),
  fixture({
    answer: "The 2025 version requires 14 days of notice [K1].",
    documentFamily: "held-nimbus-version-attribution",
    id: "held-en-wrong-version",
    items: [item("held-en-wrong-version", 1, "The 2026 Nimbus version requires 14 days of notice.", {
      sourceVersionNumber: 2
    })],
    labels: [label(1, "contradicted", "versioned_fact", ["K1"], [
      "contradiction", "numeric_consistency", "version_attribution"
    ])],
    language: "en",
    query: "What does the 2025 Nimbus version require?",
    split: "held_out"
  }),
  fixture({
    answer: "Редакция 2027 разрешает гостевой доступ [K1].",
    documentFamily: "held-ru-edition-current",
    id: "held-ru-version-correct",
    items: [item("held-ru-version-correct", 1, "Редакция 2027 разрешает гостевой доступ.", {
      sourceVersionNumber: 3
    })],
    labels: [label(1, "supported", "versioned_fact", ["K1"], ["version_attribution"])],
    language: "ru",
    query: "Что говорит редакция 2027 о гостевом доступе?",
    split: "held_out"
  }),
  fixture({
    answer: "Редакция 2026 запрещает гостевой доступ [K1].",
    documentFamily: "held-ru-edition-mismatch",
    id: "held-ru-version-wrong",
    items: [item("held-ru-version-wrong", 1, "Редакция 2027 запрещает гостевой доступ.", {
      sourceVersionNumber: 3
    })],
    labels: [label(1, "contradicted", "versioned_fact", ["K1"], [
      "contradiction", "version_attribution"
    ])],
    language: "ru",
    query: "Что говорит редакция 2026 о гостевом доступе?",
    split: "held_out"
  }),
  fixture({
    answer: [
      "- On 2026-01-10, the Alpha reading was 41.2 units [K1].",
      "- On 2026-02-10, the Alpha reading was 37.8 units [K2]."
    ].join("\n"),
    documentFamily: "held-alpha-timeline",
    id: "held-en-timeline",
    items: [
      item("held-en-timeline", 1, "2026-01-10: Alpha reading 41.2 units."),
      item("held-en-timeline", 2, "2026-02-10: Alpha reading 37.8 units.")
    ],
    labels: [
      label(1, "supported", "temporal_observation", ["K1"], [
        "date_consistency", "list_segmentation", "numeric_consistency",
        "temporal_non_contradiction"
      ]),
      label(2, "supported", "temporal_observation", ["K2"], [
        "date_consistency", "list_segmentation", "numeric_consistency",
        "temporal_non_contradiction"
      ])
    ],
    language: "en",
    query: "How did Alpha change between January and February?",
    split: "held_out"
  }),
  fixture({
    answer: [
      "- 01.03.2026 показатель Бета равен 18,1 ед/л [K1].",
      "- 01.04.2026 показатель Бета равен 17,4 ед/л [K2]."
    ].join("\n"),
    documentFamily: "held-ru-beta-timeline",
    id: "held-ru-timeline",
    items: [
      item("held-ru-timeline", 1, "01.03.2026: показатель Бета 18.1 ед/л."),
      item("held-ru-timeline", 2, "01.04.2026: показатель Бета 17.4 ед/л.")
    ],
    labels: [
      label(1, "supported", "temporal_observation", ["K1"], [
        "date_consistency", "list_segmentation", "numeric_consistency",
        "temporal_non_contradiction"
      ]),
      label(2, "supported", "temporal_observation", ["K2"], [
        "date_consistency", "list_segmentation", "numeric_consistency",
        "temporal_non_contradiction"
      ])
    ],
    language: "ru",
    query: "Сравни Бета в марте и апреле.",
    split: "held_out"
  }),
  fixture({
    answer: "The observed Glint value is 4.0 mmol/L [K1].",
    documentFamily: "held-glint-reference-range",
    id: "held-en-reference-role",
    items: [item("held-en-reference-role", 1,
      "Observed Glint value: 5.4 mmol/L. Reference range: 4.0–6.0 mmol/L.")],
    labels: [label(1, "contradicted", "source_fact", ["K1"], [
      "contradiction", "numeric_consistency"
    ])],
    language: "en",
    query: "What is the observed Glint value?",
    split: "held_out"
  }),
  fixture({
    answer: "Показатель Бета равен 12 ед/л [K1].",
    documentFamily: "held-ru-metric-association",
    id: "held-ru-metric-swap",
    items: [item("held-ru-metric-swap", 1,
      "Показатель Альфа равен 12 ед/л. Показатель Бета равен 18 ед/л.")],
    labels: [label(1, "contradicted", "source_fact", ["K1"], [
      "contradiction", "numeric_consistency"
    ])],
    language: "ru",
    query: "Каково значение показателя Бета?",
    split: "held_out"
  }),
  fixture({
    answer: "I couldn't find the launch date in the selected sources.",
    documentFamily: "held-missing-launch-date",
    id: "held-en-no-answer-correct",
    labels: [label(1, "supported", "source_summary", [], ["no_answer"])],
    language: "en",
    query: "What is the launch date?",
    split: "held_out"
  }),
  fixture({
    answer: "I couldn't find the support window in the selected sources.",
    documentFamily: "held-support-window",
    id: "held-en-no-answer-wrong",
    items: [item("held-en-no-answer-wrong", 1, "The support window is seventy-two hours.")],
    labels: [label(1, "unsupported", "source_summary", [], ["no_answer"])],
    language: "en",
    query: "What is the support window?",
    split: "held_out"
  }),
  fixture({
    answer: "В выбранных источниках не указан срок хранения.",
    documentFamily: "held-ru-retention-present",
    id: "held-ru-no-answer-wrong",
    items: [item("held-ru-no-answer-wrong", 1, "Срок хранения составляет девяносто дней.")],
    labels: [label(1, "unsupported", "source_summary", [], ["no_answer"])],
    language: "ru",
    query: "Каков срок хранения?",
    split: "held_out"
  }),
  fixture({
    answer: "The exact reference is SAFE-2718 [K1].",
    documentFamily: "held-reference-locator-valid",
    id: "held-en-locator-valid",
    items: [item("held-en-locator-valid", 1, "The exact reference is SAFE-2718.", {
      locator: { page: 7 }
    })],
    labels: [label(1, "supported", "source_fact", ["K1"], [
      "direct_entailment", "locator_correctness"
    ])],
    language: "en",
    query: "What is the exact reference?",
    split: "held_out"
  }),
  fixture({
    answer: "Код допуска — МАЯК-42 [K1].",
    documentFamily: "held-ru-locator-missing",
    id: "held-ru-locator-missing",
    items: [item("held-ru-locator-missing", 1, "Код допуска — МАЯК-42.", {
      locator: null
    })],
    labels: [label(1, "unsupported", "source_fact", ["K1"], ["locator_correctness"])],
    language: "ru",
    query: "Каков код допуска?",
    split: "held_out"
  }),
  fixture({
    answer: "The active policy permits guest access [K1].",
    documentFamily: "held-local-neighborhood",
    id: "held-en-neighborhood",
    items: [
      item("held-en-neighborhood", 1, "The active policy permits guest access."),
      item("held-en-neighborhood", 2, "A separate archived policy prohibits guest access.")
    ],
    labels: [label(1, "supported", "source_fact", ["K1"], [
      "citation_neighborhood", "generic_entailment"
    ])],
    language: "en",
    query: "Does the active policy permit guest access?",
    split: "held_out"
  }),
  fixture({
    answer: "Активная редакция разрешает внешний доступ [K1].",
    documentFamily: "held-ru-local-contradiction",
    id: "held-ru-neighborhood",
    items: [
      item("held-ru-neighborhood", 1, "Активная редакция запрещает внешний доступ."),
      item("held-ru-neighborhood", 2, "Черновая редакция разрешает внешний доступ.")
    ],
    labels: [label(1, "contradicted", "versioned_fact", ["K1"], [
      "citation_neighborhood", "contradiction", "generic_entailment"
    ])],
    language: "ru",
    query: "Разрешает ли активная редакция внешний доступ?",
    split: "held_out"
  }),
  fixture({
    answer: [
      "| Metric | Value |",
      "| --- | --- |",
      "| Alpha | 12.4 units [K1] |",
      "| Beta | 12.4 units [K2] |"
    ].join("\n"),
    documentFamily: "held-metric-table",
    id: "held-en-table",
    items: [
      item("held-en-table", 1, "Alpha is 12.4 units."),
      item("held-en-table", 2, "Beta is 18.2 units.")
    ],
    labels: [
      label(1, "supported", "source_fact", ["K1"], [
        "markdown_table_segmentation", "numeric_consistency"
      ]),
      label(2, "contradicted", "source_fact", ["K2"], [
        "contradiction", "markdown_table_segmentation", "numeric_consistency"
      ])
    ],
    language: "en",
    query: "List Alpha and Beta values.",
    split: "held_out"
  }),
  fixture({
    answer: "Повреждённый фрагмент может указывать на разрешённый допуск [K1].",
    documentFamily: "held-ru-ocr-ambiguity",
    id: "held-ru-uncertain",
    items: [item("held-ru-uncertain", 1, "Допуск ... [неразборчиво] ... разрешен?", {
      contextBoundaries: {
        expanded: false,
        excerptBytes: 65,
        layoutKind: "table_ambiguous",
        sourceTextBytes: 65
      }
    })],
    labels: [label(1, "uncertain", "source_fact", ["K1"], [
      "generic_entailment", "uncertainty"
    ])],
    language: "ru",
    query: "Разрешён ли допуск?",
    split: "held_out"
  }),
  fixture({
    answer: "The sources conflict: access is permitted [K1], while it is prohibited [K2].",
    documentFamily: "held-access-conflict",
    id: "held-en-conflict-disclosure",
    items: [
      item("held-en-conflict-disclosure", 1, "Access is permitted."),
      item("held-en-conflict-disclosure", 2, "Access is prohibited.")
    ],
    labels: [label(1, "supported", "comparison", ["K1", "K2"], [
      "citation_neighborhood", "contradiction", "generic_entailment"
    ])],
    language: "en",
    query: "Do the sources agree about access?",
    split: "held_out"
  }),
  fixture({
    answer: "Источники расходятся: экспорт включён [K1], тогда как экспорт отключён [K2].",
    documentFamily: "held-ru-export-conflict",
    id: "held-ru-conflict-disclosure",
    items: [
      item("held-ru-conflict-disclosure", 1, "Экспорт включён."),
      item("held-ru-conflict-disclosure", 2, "Экспорт отключён.")
    ],
    labels: [label(1, "supported", "comparison", ["K1", "K2"], [
      "citation_neighborhood", "contradiction", "generic_entailment"
    ])],
    language: "ru",
    query: "Согласны ли источники о состоянии экспорта?",
    split: "held_out"
  }),
  fixture({
    answer: "The total for the three regions is 300 [K1].",
    arithmeticPlans: [{
      assertedOutput: "300",
      citationHandle: "K1",
      claimOrdinal: 1,
      operands: ["120", "80", "100"],
      operation: "add",
      outputUnit: null
    }],
    documentFamily: "held-region-total",
    id: "held-en-arithmetic",
    items: [item("held-en-arithmetic", 1, [
      "Operation: sum regional values.",
      "Inputs: North 120, South 80, West 100.",
      "Result: 300."
    ].join(" "), {
      locator: {
        page: 1,
        ranges: [{ range: "B2:B4", role: "value", sheet: "Regions", sheetIndex: 0 }]
      }
    })],
    labels: [label(1, "supported", "derived_arithmetic", ["K1"], [
      "derived_arithmetic", "numeric_consistency"
    ])],
    language: "en",
    query: "What is the sum for all regions?",
    split: "held_out"
  }),
  fixture({
    answer: "Итог по трём регионам равен 280 [K1].",
    arithmeticPlans: [{
      assertedOutput: "280",
      citationHandle: "K1",
      claimOrdinal: 1,
      operands: ["120", "80", "100"],
      operation: "add",
      outputUnit: null
    }],
    documentFamily: "held-ru-region-total",
    id: "held-ru-arithmetic-wrong",
    items: [item("held-ru-arithmetic-wrong", 1,
      "Сумма значений Север 120, Юг 80 и Запад 100 равна 300.")],
    labels: [label(1, "contradicted", "derived_arithmetic", ["K1"], [
      "contradiction", "derived_arithmetic", "numeric_consistency"
    ])],
    language: "ru",
    query: "Каков итог по трём регионам?",
    split: "held_out"
  }),
  fixture({
    answer: "The launch date is 2026-09-11 [K1].",
    documentFamily: "held-launch-date-mismatch",
    id: "held-en-date-wrong",
    items: [item("held-en-date-wrong", 1, "The launch date is 2026-09-10.")],
    labels: [label(1, "contradicted", "temporal_observation", ["K1"], [
      "contradiction", "date_consistency"
    ])],
    language: "en",
    query: "What is the launch date?",
    split: "held_out"
  }),
  fixture({
    answer: "Показатель Гамма равен 7,25 мг/л [K1].",
    documentFamily: "held-ru-decimal-comma",
    id: "held-ru-decimal",
    items: [item("held-ru-decimal", 1, "Показатель Гамма равен 7.25 мг/л.")],
    labels: [label(1, "supported", "source_fact", ["K1"], ["numeric_consistency"])],
    language: "ru",
    query: "Каково значение Гамма?",
    split: "held_out"
  }),
  fixture({
    answer: "The service window is active [K1].",
    documentFamily: "held-invalid-page-locator",
    id: "held-en-locator-invalid",
    items: [item("held-en-locator-invalid", 1, "The service window is active.", {
      locator: { page: 0 }
    })],
    labels: [label(1, "unsupported", "source_fact", ["K1"], ["locator_correctness"])],
    language: "en",
    query: "Is the service window active?",
    split: "held_out"
  })
]);

/**
 * Substantive bilingual review expansion. Its checked-in labels are generated
 * contract fixtures only: candidate inputs and blind review packets exclude the
 * decisions, and release scoring accepts only independently imported labels.
 */
const heldOutReviewExpansionFixtures: readonly KnowledgeSemanticGroundingFixture[] =
  Object.freeze(((["en", "ru"] as const).flatMap((language) =>
    Array.from({ length: 36 }, (_, offset): KnowledgeSemanticGroundingFixture => {
      const ordinal = offset + 1;
      const suffix = `${language}-${String(ordinal).padStart(2, "0")}`;
      const fixtureId = `held-review-${suffix}`;
      const variant = offset % 6;
      if (language === "en") {
        if (variant === 0) {
          return fixture({
            answer: `Node ${ordinal} uses the Amber tier [K1].`,
            documentFamily: `held-review-en-tier-${ordinal}`,
            id: fixtureId,
            items: [item(fixtureId, 1, `Node ${ordinal} uses the Amber tier.`)],
            labels: [label(1, "supported", "source_fact", ["K1"], [
              "direct_entailment", "locator_correctness"
            ])],
            language,
            query: `Which tier does node ${ordinal} use?`,
            split: "held_out"
          });
        }
        if (variant === 1) {
          return fixture({
            answer: `Gateway ${ordinal} permits guest export [K1].`,
            documentFamily: `held-review-en-export-${ordinal}`,
            id: fixtureId,
            items: [item(fixtureId, 1, `Gateway ${ordinal} prohibits guest export.`)],
            labels: [label(1, "contradicted", "source_fact", ["K1"], [
              "contradiction", "generic_entailment"
            ])],
            language,
            query: `Does gateway ${ordinal} permit guest export?`,
            split: "held_out"
          });
        }
        if (variant === 2) {
          return fixture({
            answer: `Service ${ordinal} uses the Cobalt protocol [K1].`,
            documentFamily: `held-review-en-protocol-${ordinal}`,
            id: fixtureId,
            items: [item(fixtureId, 1, `Service ${ordinal} uses the Indigo protocol.`)],
            labels: [label(1, "unsupported", "source_fact", ["K1"], [
              "generic_entailment"
            ])],
            language,
            query: `Which protocol does service ${ordinal} use?`,
            split: "held_out"
          });
        }
        if (variant === 3) {
          const day = String(ordinal % 28 + 1).padStart(2, "0");
          return fixture({
            answer: `On 2027-04-${day}, sensor ${ordinal} measured ${100 + ordinal} kPa [K1].`,
            documentFamily: `held-review-en-observation-${ordinal}`,
            id: fixtureId,
            items: [item(fixtureId, 1,
              `2027-04-${day}: sensor ${ordinal} measured ${100 + ordinal} kPa.`)],
            labels: [label(1, "supported", "temporal_observation", ["K1"], [
              "date_consistency", "numeric_consistency", "temporal_non_contradiction"
            ])],
            language,
            query: `What did sensor ${ordinal} measure on 2027-04-${day}?`,
            split: "held_out"
          });
        }
        if (variant === 4) {
          return fixture({
            answer: `Version 2026 requires ${ordinal} days of notice [K1].`,
            documentFamily: `held-review-en-version-${ordinal}`,
            id: fixtureId,
            items: [item(fixtureId, 1,
              `Version 2027 requires ${ordinal} days of notice.`, { sourceVersionNumber: 7 })],
            labels: [label(1, "contradicted", "versioned_fact", ["K1"], [
              "contradiction", "numeric_consistency", "version_attribution"
            ])],
            language,
            query: `What notice does version 2026 require for case ${ordinal}?`,
            split: "held_out"
          });
        }
        return fixture({
          answer: `The sources conflict: queue ${ordinal} is active [K1], while it is paused [K2].`,
          documentFamily: `held-review-en-conflict-${ordinal}`,
          id: fixtureId,
          items: [
            item(fixtureId, 1, `Queue ${ordinal} is active.`),
            item(fixtureId, 2, `Queue ${ordinal} is paused.`)
          ],
          labels: [label(1, "supported", "comparison", ["K1", "K2"], [
            "citation_neighborhood", "contradiction", "generic_entailment"
          ])],
          language,
          query: `Do the sources agree about queue ${ordinal}?`,
          split: "held_out"
        });
      }

      if (variant === 0) {
        return fixture({
          answer: `Узел ${ordinal} использует уровень Янтарь [K1].`,
          documentFamily: `held-review-ru-tier-${ordinal}`,
          id: fixtureId,
          items: [item(fixtureId, 1, `Узел ${ordinal} использует уровень Янтарь.`)],
          labels: [label(1, "supported", "source_fact", ["K1"], [
            "direct_entailment", "locator_correctness"
          ])],
          language,
          query: `Какой уровень использует узел ${ordinal}?`,
          split: "held_out"
        });
      }
      if (variant === 1) {
        return fixture({
          answer: `Шлюз ${ordinal} разрешает гостевой экспорт [K1].`,
          documentFamily: `held-review-ru-export-${ordinal}`,
          id: fixtureId,
          items: [item(fixtureId, 1, `Шлюз ${ordinal} запрещает гостевой экспорт.`)],
          labels: [label(1, "contradicted", "source_fact", ["K1"], [
            "contradiction", "generic_entailment"
          ])],
          language,
          query: `Разрешает ли шлюз ${ordinal} гостевой экспорт?`,
          split: "held_out"
        });
      }
      if (variant === 2) {
        return fixture({
          answer: `Сервис ${ordinal} использует протокол Кобальт [K1].`,
          documentFamily: `held-review-ru-protocol-${ordinal}`,
          id: fixtureId,
          items: [item(fixtureId, 1, `Сервис ${ordinal} использует протокол Индиго.`)],
          labels: [label(1, "unsupported", "source_fact", ["K1"], [
            "generic_entailment"
          ])],
          language,
          query: `Какой протокол использует сервис ${ordinal}?`,
          split: "held_out"
        });
      }
      if (variant === 3) {
        const day = String(ordinal % 28 + 1).padStart(2, "0");
        return fixture({
          answer: `${day}.04.2027 датчик ${ordinal} показал ${100 + ordinal} кПа [K1].`,
          documentFamily: `held-review-ru-observation-${ordinal}`,
          id: fixtureId,
          items: [item(fixtureId, 1,
            `${day}.04.2027: датчик ${ordinal} показал ${100 + ordinal} кПа.`)],
          labels: [label(1, "supported", "temporal_observation", ["K1"], [
            "date_consistency", "numeric_consistency", "temporal_non_contradiction"
          ])],
          language,
          query: `Что показал датчик ${ordinal} ${day}.04.2027?`,
          split: "held_out"
        });
      }
      if (variant === 4) {
        return fixture({
          answer: `Версия 2026 требует уведомление за ${ordinal} дней [K1].`,
          documentFamily: `held-review-ru-version-${ordinal}`,
          id: fixtureId,
          items: [item(fixtureId, 1,
            `Версия 2027 требует уведомление за ${ordinal} дней.`, { sourceVersionNumber: 7 })],
          labels: [label(1, "contradicted", "versioned_fact", ["K1"], [
            "contradiction", "numeric_consistency", "version_attribution"
          ])],
          language,
          query: `Какой срок указан в версии 2026 для случая ${ordinal}?`,
          split: "held_out"
        });
      }
      return fixture({
        answer: `Источники расходятся: очередь ${ordinal} активна [K1], тогда как она приостановлена [K2].`,
        documentFamily: `held-review-ru-conflict-${ordinal}`,
        id: fixtureId,
        items: [
          item(fixtureId, 1, `Очередь ${ordinal} активна.`),
          item(fixtureId, 2, `Очередь ${ordinal} приостановлена.`)
        ],
        labels: [label(1, "supported", "comparison", ["K1", "K2"], [
          "citation_neighborhood", "contradiction", "generic_entailment"
        ])],
        language,
        query: `Согласны ли источники об очереди ${ordinal}?`,
        split: "held_out"
      });
    }))));

/**
 * Close the two sparse held-out language/slice cells without changing any
 * existing fixture's split or label. These are generated structural oracles,
 * not independent semantic-review decisions.
 */
const heldOutCoverageFixtures: readonly KnowledgeSemanticGroundingFixture[] = Object.freeze([
  fixture({
    answer: "The damaged field may indicate that the valve is open [K1].",
    documentFamily: "held-en-damaged-valve-field",
    id: "held-en-uncertain",
    items: [item("held-en-uncertain", 1, "Valve state: op[illegible]", {
      contextBoundaries: {
        expanded: false,
        excerptBytes: 27,
        layoutKind: "field_ambiguous",
        sourceTextBytes: 27
      }
    })],
    labels: [label(1, "uncertain", "source_fact", ["K1"], [
      "generic_entailment", "locator_correctness", "uncertainty"
    ])],
    language: "en",
    query: "Is the valve open?",
    split: "held_out"
  }),
  fixture({
    answer: [
      "| Показатель | Значение |",
      "| --- | --- |",
      "| Север | 18,4 ед. [K1] |",
      "| Юг | 21,7 ед. [K2] |"
    ].join("\n"),
    documentFamily: "held-ru-regional-reading-table",
    id: "held-ru-table",
    items: [
      item("held-ru-table", 1, "Показатель Север равен 18.4 ед."),
      item("held-ru-table", 2, "Показатель Юг равен 21.7 ед.")
    ],
    labels: [
      label(1, "supported", "source_fact", ["K1"], [
        "direct_entailment", "markdown_table_segmentation", "numeric_consistency"
      ]),
      label(2, "supported", "source_fact", ["K2"], [
        "direct_entailment", "markdown_table_segmentation", "numeric_consistency"
      ])
    ],
    language: "ru",
    query: "Каковы региональные показатели?",
    split: "held_out"
  }),
  fixture({
    answer: "All selected sources state that the audit is complete [K1] [K2].",
    documentFamily: "held-en-audit-coverage",
    id: "held-en-coverage",
    items: [
      item("held-en-coverage", 1, "The audit is complete."),
      item("held-en-coverage", 2, "The audit remains pending.")
    ],
    labels: [label(1, "contradicted", "coverage_claim", ["K1", "K2"], [
      "citation_neighborhood", "contradiction", "coverage_claim", "generic_entailment"
    ])],
    language: "en",
    query: "Do all sources report the audit complete?",
    split: "held_out"
  }),
  fixture({
    answer: "Все выбранные источники подтверждают завершение аудита [K1] [K2].",
    documentFamily: "held-ru-audit-coverage",
    id: "held-ru-coverage",
    items: [
      item("held-ru-coverage", 1, "Аудит завершён."),
      item("held-ru-coverage", 2, "Аудит ещё не завершён.")
    ],
    labels: [label(1, "contradicted", "coverage_claim", ["K1", "K2"], [
      "citation_neighborhood", "contradiction", "coverage_claim", "generic_entailment"
    ])],
    language: "ru",
    query: "Все ли источники подтверждают завершение аудита?",
    split: "held_out"
  }),
  fixture({
    answer: "General knowledge: liquid water freezes near zero degrees Celsius at standard pressure.",
    documentFamily: "held-en-water-general-knowledge",
    id: "held-en-general-knowledge",
    labels: [label(1, "supported", "general_knowledge", [], ["general_knowledge"])],
    language: "en",
    query: "At what temperature does water generally freeze?",
    split: "held_out"
  }),
  fixture({
    answer: "Общие сведения: вода замерзает примерно при нуле градусов Цельсия при нормальном давлении.",
    documentFamily: "held-ru-water-general-knowledge",
    id: "held-ru-general-knowledge",
    labels: [label(1, "supported", "general_knowledge", [], ["general_knowledge"])],
    language: "ru",
    query: "При какой температуре обычно замерзает вода?",
    split: "held_out"
  })
]);

type SemanticMatrixRow = Readonly<{
  arithmetic: readonly [number, number, number, number];
  dates: Readonly<{
    en: readonly [string, string];
    ru: readonly [string, string];
  }>;
  directSubjects: Readonly<{
    en: readonly [string, string];
    ru: readonly [string, string];
  }>;
  generalKnowledge: Readonly<{ en: string; ru: string }>;
  key: string;
  noticeDays: readonly [number, number];
  readings: readonly [number, number];
  subjects: Readonly<{
    en: readonly [string, string, string, string, string, string, string];
    ru: readonly [string, string, string, string, string, string, string];
  }>;
  years: readonly [number, number];
}>;

/*
 * Every row is a separately authored synthetic document family. Values and
 * subjects are deliberately varied rather than produced by ordinal-only
 * substitution, while the fixed scenario columns make coverage auditable.
 */
const developmentMatrixRows: readonly SemanticMatrixRow[] = Object.freeze([
  Object.freeze({
    arithmetic: Object.freeze([17, 26, 44, 19] as const),
    dates: Object.freeze({
      en: Object.freeze(["2028-02-14", "2028-05-09"] as const),
      ru: Object.freeze(["14.02.2028", "09.05.2028"] as const)
    }),
    directSubjects: Object.freeze({
      en: Object.freeze(["Lark registry", "Juniper gateway"] as const),
      ru: Object.freeze(["реестр Ладога", "шлюз Можжевельник"] as const)
    }),
    generalKnowledge: Object.freeze({
      en: "a common calendar year has 365 days.",
      ru: "обычный календарный год содержит 365 дней."
    }),
    key: "lark",
    noticeDays: Object.freeze([27, 11] as const),
    readings: Object.freeze([34.6, 31.2] as const),
    subjects: Object.freeze({
      en: Object.freeze([
        "Northwind console", "Quarry relay", "Meridian sensor", "Lark policy",
        "harbor gate", "orchard lock", "archive field"
      ] as const),
      ru: Object.freeze([
        "консоль Север", "реле Карьер", "датчик Меридиан", "политика Ладога",
        "портовый шлюз", "замок Сад", "поле архива"
      ] as const)
    }),
    years: Object.freeze([2028, 2029] as const)
  })
]);

const blindedReviewMatrixRows: readonly SemanticMatrixRow[] = Object.freeze([
  Object.freeze({
    arithmetic: Object.freeze([23, 31, 58, 21] as const),
    dates: Object.freeze({
      en: Object.freeze(["2030-01-12", "2030-03-18"] as const),
      ru: Object.freeze(["12.01.2030", "18.03.2030"] as const)
    }),
    directSubjects: Object.freeze({
      en: Object.freeze(["Harbor registry", "Copper gateway"] as const),
      ru: Object.freeze(["реестр Гавань", "шлюз Медь"] as const)
    }),
    generalKnowledge: Object.freeze({
      en: "Earth's atmosphere consists mostly of nitrogen.",
      ru: "атмосфера Земли состоит преимущественно из азота."
    }),
    key: "harbor",
    noticeDays: Object.freeze([35, 16] as const),
    readings: Object.freeze([46.8, 42.3] as const),
    subjects: Object.freeze({
      en: Object.freeze([
        "Harbor console", "Copper relay", "Delta sensor", "Harbor policy",
        "east floodgate", "west floodgate", "cargo manifest field"
      ] as const),
      ru: Object.freeze([
        "консоль Гавань", "реле Медь", "датчик Дельта", "политика Гавань",
        "восточный затвор", "западный затвор", "поле грузового реестра"
      ] as const)
    }),
    years: Object.freeze([2030, 2031] as const)
  }),
  Object.freeze({
    arithmetic: Object.freeze([14, 39, 67, 25] as const),
    dates: Object.freeze({
      en: Object.freeze(["2032-04-07", "2032-07-21"] as const),
      ru: Object.freeze(["07.04.2032", "21.07.2032"] as const)
    }),
    directSubjects: Object.freeze({
      en: Object.freeze(["Willow ledger", "Granite router"] as const),
      ru: Object.freeze(["журнал Ива", "маршрутизатор Гранит"] as const)
    }),
    generalKnowledge: Object.freeze({
      en: "a week has seven days.",
      ru: "неделя состоит из семи дней."
    }),
    key: "willow",
    noticeDays: Object.freeze([42, 19] as const),
    readings: Object.freeze([18.75, 20.4] as const),
    subjects: Object.freeze({
      en: Object.freeze([
        "Willow dashboard", "Granite bridge", "Orion probe", "Willow charter",
        "canal barrier", "station barrier", "inspection note field"
      ] as const),
      ru: Object.freeze([
        "панель Ива", "мост Гранит", "зонд Орион", "регламент Ива",
        "барьер канала", "барьер станции", "поле акта осмотра"
      ] as const)
    }),
    years: Object.freeze([2032, 2033] as const)
  }),
  Object.freeze({
    arithmetic: Object.freeze([28, 47, 81, 36] as const),
    dates: Object.freeze({
      en: Object.freeze(["2034-06-03", "2034-10-26"] as const),
      ru: Object.freeze(["03.06.2034", "26.10.2034"] as const)
    }),
    directSubjects: Object.freeze({
      en: Object.freeze(["Summit register", "Indigo proxy"] as const),
      ru: Object.freeze(["реестр Вершина", "прокси Индиго"] as const)
    }),
    generalKnowledge: Object.freeze({
      en: "an hour contains sixty minutes.",
      ru: "один час содержит шестьдесят минут."
    }),
    key: "summit",
    noticeDays: Object.freeze([29, 13] as const),
    readings: Object.freeze([73.1, 69.85] as const),
    subjects: Object.freeze({
      en: Object.freeze([
        "Summit terminal", "Indigo switch", "Aster monitor", "Summit protocol",
        "upper hatch", "lower hatch", "maintenance form field"
      ] as const),
      ru: Object.freeze([
        "терминал Вершина", "коммутатор Индиго", "монитор Астра", "протокол Вершина",
        "верхний люк", "нижний люк", "поле ремонтной формы"
      ] as const)
    }),
    years: Object.freeze([2034, 2035] as const)
  }),
  Object.freeze({
    arithmetic: Object.freeze([36, 52, 94, 41] as const),
    dates: Object.freeze({
      en: Object.freeze(["2036-08-15", "2036-11-02"] as const),
      ru: Object.freeze(["15.08.2036", "02.11.2036"] as const)
    }),
    directSubjects: Object.freeze({
      en: Object.freeze(["Meadow catalogue", "Quartz broker"] as const),
      ru: Object.freeze(["каталог Луг", "брокер Кварц"] as const)
    }),
    generalKnowledge: Object.freeze({
      en: "a right angle measures ninety degrees.",
      ru: "прямой угол равен девяноста градусам."
    }),
    key: "meadow",
    noticeDays: Object.freeze([51, 22] as const),
    readings: Object.freeze([9.6, 12.45] as const),
    subjects: Object.freeze({
      en: Object.freeze([
        "Meadow workstation", "Quartz repeater", "Pine gauge", "Meadow directive",
        "north sluice", "south sluice", "shipping label field"
      ] as const),
      ru: Object.freeze([
        "станция Луг", "повторитель Кварц", "датчик Сосна", "директива Луг",
        "северный шлюз", "южный шлюз", "поле транспортной этикетки"
      ] as const)
    }),
    years: Object.freeze([2036, 2037] as const)
  })
]);

function matrixFixtureId(
  split: "development" | "blinded_review",
  row: SemanticMatrixRow,
  language: KnowledgeSemanticGroundingLanguage,
  scenario: string
): string {
  return `${split === "development" ? "dev" : "blind"}-${row.key}-${language}-${scenario}`;
}

function ambiguousMatrixItem(
  fixtureId: string,
  ordinal: number,
  excerpt: string
): KnowledgeEvidencePackageItem {
  const excerptBytes = Buffer.byteLength(excerpt);
  return item(fixtureId, ordinal, excerpt, {
    contextBoundaries: {
      expanded: false,
      excerptBytes,
      layoutKind: "field_ambiguous",
      sourceTextBytes: excerptBytes
    }
  });
}

function englishMatrixFixtures(
  split: "development" | "blinded_review",
  row: SemanticMatrixRow
): readonly KnowledgeSemanticGroundingFixture[] {
  const id = (scenario: string): string => matrixFixtureId(split, row, "en", scenario);
  const family = (scenario: string): string => `matrix-${id(scenario)}`;
  const [directOne, directTwo] = row.directSubjects.en;
  const [accessOne, accessTwo, metric, policy, conflictOne, conflictTwo, uncertain] =
    row.subjects.en;
  const [oldYear, newYear] = row.years;
  const [oldNotice, newNotice] = row.noticeDays;
  const [firstDate, secondDate] = row.dates.en;
  const [firstReading, secondReading] = row.readings;
  const [sumLeft, sumRight, differenceLeft, differenceRight] = row.arithmetic;
  const sum = sumLeft + sumRight;
  const difference = differenceLeft - differenceRight;
  const wrongNewNotice = newNotice + 3;

  return Object.freeze([
    fixture({
      answer: [
        `- The ${directOne} uses the Amber tier [K1].`,
        `- The ${directTwo} uses the Cobalt tier [K2].`
      ].join("\n"),
      documentFamily: family("direct-list"),
      id: id("direct-list"),
      items: [
        item(id("direct-list"), 1, `The ${directOne} uses the Amber tier.`),
        item(id("direct-list"), 2, `The ${directTwo} uses the Cobalt tier.`)
      ],
      labels: [
        label(1, "supported", "source_fact", ["K1"], [
          "direct_entailment", "list_segmentation", "locator_correctness"
        ]),
        label(2, "supported", "source_fact", ["K2"], [
          "direct_entailment", "list_segmentation", "locator_correctness"
        ])
      ],
      language: "en",
      query: "Which tiers do the two components use?",
      split
    }),
    fixture({
      answer: `The ${directTwo} uses the Jade protocol [K1].`,
      documentFamily: family("unsupported"),
      id: id("unsupported"),
      items: [item(id("unsupported"), 1, `The ${directTwo} uses the Slate protocol.`)],
      labels: [label(1, "unsupported", "source_fact", ["K1"], [
        "generic_entailment", "locator_correctness"
      ])],
      language: "en",
      query: `Which protocol does the ${directTwo} use?`,
      split
    }),
    fixture({
      answer: [
        `- The ${accessOne} permits guest export [K1].`,
        `- The ${accessTwo} is enabled for contractors [K2].`
      ].join("\n"),
      documentFamily: family("contradiction"),
      id: id("contradiction"),
      items: [
        item(id("contradiction"), 1, `The ${accessOne} prohibits guest export.`),
        item(id("contradiction"), 2, `The ${accessTwo} is disabled for contractors.`)
      ],
      labels: [
        label(1, "contradicted", "source_fact", ["K1"], [
          "contradiction", "generic_entailment", "list_segmentation"
        ]),
        label(2, "contradicted", "source_fact", ["K2"], [
          "contradiction", "generic_entailment", "list_segmentation"
        ])
      ],
      language: "en",
      query: "What access is allowed?",
      split
    }),
    fixture({
      answer: [
        `- On ${firstDate}, the ${metric} reading was ${firstReading} units [K1].`,
        `- On ${secondDate}, the ${metric} reading was ${secondReading} units [K2].`
      ].join("\n"),
      documentFamily: family("timeline"),
      id: id("timeline"),
      items: [
        item(id("timeline"), 1, `${firstDate}: ${metric} reading ${firstReading} units.`),
        item(id("timeline"), 2, `${secondDate}: ${metric} reading ${secondReading} units.`)
      ],
      labels: [
        label(1, "supported", "temporal_observation", ["K1"], [
          "date_consistency", "list_segmentation", "numeric_consistency",
          "temporal_non_contradiction"
        ]),
        label(2, "supported", "temporal_observation", ["K2"], [
          "date_consistency", "list_segmentation", "numeric_consistency",
          "temporal_non_contradiction"
        ])
      ],
      language: "en",
      query: `How did the ${metric} reading change?`,
      split
    }),
    fixture({
      answer: [
        "| Edition | Notice |",
        "| --- | --- |",
        `| ${oldYear} | ${oldNotice} days [K1] |`,
        `| ${newYear} | ${newNotice} days [K2] |`
      ].join("\n"),
      documentFamily: family("version-table"),
      id: id("version-table"),
      items: [
        item(id("version-table"), 1,
          `The ${oldYear} edition of the ${policy} requires ${oldNotice} days of notice.`),
        item(id("version-table"), 2,
          `The ${newYear} edition of the ${policy} requires ${wrongNewNotice} days of notice.`)
      ],
      labels: [
        label(1, "supported", "versioned_fact", ["K1"], [
          "markdown_table_segmentation", "numeric_consistency", "version_attribution"
        ]),
        label(2, "contradicted", "versioned_fact", ["K2"], [
          "contradiction", "markdown_table_segmentation", "numeric_consistency",
          "version_attribution"
        ])
      ],
      language: "en",
      query: `Compare the ${policy} notice periods.`,
      split
    }),
    fixture({
      answer: [
        `- The total of ${sumLeft} and ${sumRight} is ${sum} [K1].`,
        `- The difference between ${differenceLeft} and ${differenceRight} is ${difference} [K2].`
      ].join("\n"),
      arithmeticPlans: [
        {
          assertedOutput: String(sum),
          citationHandle: "K1",
          claimOrdinal: 1,
          operands: [String(sumLeft), String(sumRight)],
          operation: "add",
          outputUnit: null
        },
        {
          assertedOutput: String(difference),
          citationHandle: "K2",
          claimOrdinal: 2,
          operands: [String(differenceLeft), String(differenceRight)],
          operation: "subtract",
          outputUnit: null
        }
      ],
      documentFamily: family("arithmetic"),
      id: id("arithmetic"),
      items: [
        item(id("arithmetic"), 1,
          `Operation: sum. Inputs: ${sumLeft}, ${sumRight}. Result: ${sum}.`),
        item(id("arithmetic"), 2,
          `Operation: difference. Inputs: ${differenceLeft}, ${differenceRight}. Result: ${difference}.`)
      ],
      labels: [
        label(1, "supported", "derived_arithmetic", ["K1"], [
          "derived_arithmetic", "list_segmentation", "numeric_consistency"
        ]),
        label(2, "supported", "derived_arithmetic", ["K2"], [
          "derived_arithmetic", "list_segmentation", "numeric_consistency"
        ])
      ],
      language: "en",
      query: "Recompute the two results.",
      split
    }),
    fixture({
      answer: [
        `The sources conflict: the ${conflictOne} is open [K1], while it is closed [K2].`,
        `Records conflict: the ${conflictTwo} is locked [K3], while it is unlocked [K4].`
      ].join("\n"),
      documentFamily: family("local-conflict"),
      id: id("local-conflict"),
      items: [
        item(id("local-conflict"), 1, `The ${conflictOne} is open.`),
        item(id("local-conflict"), 2, `The ${conflictOne} is closed.`),
        item(id("local-conflict"), 3, `The ${conflictTwo} is locked.`),
        item(id("local-conflict"), 4, `The ${conflictTwo} is unlocked.`)
      ],
      labels: [
        label(1, "supported", "comparison", ["K1", "K2"], [
          "citation_neighborhood", "contradiction", "generic_entailment"
        ]),
        label(2, "supported", "comparison", ["K3", "K4"], [
          "citation_neighborhood", "contradiction", "generic_entailment"
        ])
      ],
      language: "en",
      query: "Where do the local records conflict?",
      split
    }),
    fixture({
      answer: [
        `- The damaged ${uncertain} may indicate approval [K1].`,
        `- The faded ${uncertain} may indicate rejection [K2].`
      ].join("\n"),
      documentFamily: family("uncertainty"),
      id: id("uncertainty"),
      items: [
        ambiguousMatrixItem(id("uncertainty"), 1, "Approval field: appr[illegible]"),
        ambiguousMatrixItem(id("uncertainty"), 2, "Decision field: rej[illegible]")
      ],
      labels: [
        label(1, "uncertain", "source_fact", ["K1"], [
          "generic_entailment", "list_segmentation", "locator_correctness", "uncertainty"
        ]),
        label(2, "uncertain", "source_fact", ["K2"], [
          "generic_entailment", "list_segmentation", "locator_correctness", "uncertainty"
        ])
      ],
      language: "en",
      query: "What do the damaged fields say?",
      split
    }),
    fixture({
      answer: `I couldn't find the commissioning date for ${row.key} in the selected sources.`,
      documentFamily: family("no-answer"),
      id: id("no-answer"),
      labels: [label(1, "supported", "source_summary", [], ["no_answer"])],
      language: "en",
      query: `What is the commissioning date for ${row.key}?`,
      split
    }),
    fixture({
      answer: `All selected sources state that the ${row.key} inspection is complete [K1] [K2].`,
      documentFamily: family("coverage"),
      id: id("coverage"),
      items: [
        item(id("coverage"), 1, `The ${row.key} inspection is complete.`),
        item(id("coverage"), 2, `The ${row.key} inspection remains pending.`)
      ],
      labels: [label(1, "contradicted", "coverage_claim", ["K1", "K2"], [
        "citation_neighborhood", "contradiction", "coverage_claim", "generic_entailment"
      ])],
      language: "en",
      query: `Do all selected sources report the ${row.key} inspection complete?`,
      split
    }),
    fixture({
      answer: `General knowledge: ${row.generalKnowledge.en}`,
      documentFamily: family("general-knowledge"),
      id: id("general-knowledge"),
      labels: [label(1, "supported", "general_knowledge", [], ["general_knowledge"])],
      language: "en",
      query: "What general fact is relevant?",
      split
    })
  ]);
}

function russianMatrixFixtures(
  split: "development" | "blinded_review",
  row: SemanticMatrixRow
): readonly KnowledgeSemanticGroundingFixture[] {
  const id = (scenario: string): string => matrixFixtureId(split, row, "ru", scenario);
  const family = (scenario: string): string => `matrix-${id(scenario)}`;
  const [directOne, directTwo] = row.directSubjects.ru;
  const [accessOne, accessTwo, metric, policy, conflictOne, conflictTwo, uncertain] =
    row.subjects.ru;
  const [oldYear, newYear] = row.years;
  const [oldNotice, newNotice] = row.noticeDays;
  const [firstDate, secondDate] = row.dates.ru;
  const [firstReading, secondReading] = row.readings;
  const [sumLeft, sumRight, differenceLeft, differenceRight] = row.arithmetic;
  const sum = sumLeft + sumRight;
  const difference = differenceLeft - differenceRight;
  const wrongNewNotice = newNotice + 3;

  return Object.freeze([
    fixture({
      answer: [
        `- ${directOne} использует уровень Янтарь [K1].`,
        `- ${directTwo} использует уровень Кобальт [K2].`
      ].join("\n"),
      documentFamily: family("direct-list"),
      id: id("direct-list"),
      items: [
        item(id("direct-list"), 1, `${directOne} использует уровень Янтарь.`),
        item(id("direct-list"), 2, `${directTwo} использует уровень Кобальт.`)
      ],
      labels: [
        label(1, "supported", "source_fact", ["K1"], [
          "direct_entailment", "list_segmentation", "locator_correctness"
        ]),
        label(2, "supported", "source_fact", ["K2"], [
          "direct_entailment", "list_segmentation", "locator_correctness"
        ])
      ],
      language: "ru",
      query: "Какие уровни используют два компонента?",
      split
    }),
    fixture({
      answer: `${directTwo} использует протокол Нефрит [K1].`,
      documentFamily: family("unsupported"),
      id: id("unsupported"),
      items: [item(id("unsupported"), 1, `${directTwo} использует протокол Сланец.`)],
      labels: [label(1, "unsupported", "source_fact", ["K1"], [
        "generic_entailment", "locator_correctness"
      ])],
      language: "ru",
      query: `Какой протокол использует ${directTwo}?`,
      split
    }),
    fixture({
      answer: [
        `- ${accessOne} разрешает гостевой экспорт [K1].`,
        `- ${accessTwo} включено для подрядчиков [K2].`
      ].join("\n"),
      documentFamily: family("contradiction"),
      id: id("contradiction"),
      items: [
        item(id("contradiction"), 1, `${accessOne} запрещает гостевой экспорт.`),
        item(id("contradiction"), 2, `${accessTwo} отключено для подрядчиков.`)
      ],
      labels: [
        label(1, "contradicted", "source_fact", ["K1"], [
          "contradiction", "generic_entailment", "list_segmentation"
        ]),
        label(2, "contradicted", "source_fact", ["K2"], [
          "contradiction", "generic_entailment", "list_segmentation"
        ])
      ],
      language: "ru",
      query: "Какой доступ разрешён?",
      split
    }),
    fixture({
      answer: [
        `- ${firstDate} показатель ${metric} равен ${firstReading} ед. [K1].`,
        `- ${secondDate} показатель ${metric} равен ${secondReading} ед. [K2].`
      ].join("\n"),
      documentFamily: family("timeline"),
      id: id("timeline"),
      items: [
        item(id("timeline"), 1, `${firstDate}: показатель ${metric} ${firstReading} ед.`),
        item(id("timeline"), 2, `${secondDate}: показатель ${metric} ${secondReading} ед.`)
      ],
      labels: [
        label(1, "supported", "temporal_observation", ["K1"], [
          "date_consistency", "list_segmentation", "numeric_consistency",
          "temporal_non_contradiction"
        ]),
        label(2, "supported", "temporal_observation", ["K2"], [
          "date_consistency", "list_segmentation", "numeric_consistency",
          "temporal_non_contradiction"
        ])
      ],
      language: "ru",
      query: `Как изменился показатель ${metric}?`,
      split
    }),
    fixture({
      answer: [
        "| Редакция | Уведомление |",
        "| --- | --- |",
        `| ${oldYear} | ${oldNotice} дней [K1] |`,
        `| ${newYear} | ${newNotice} дней [K2] |`
      ].join("\n"),
      documentFamily: family("version-table"),
      id: id("version-table"),
      items: [
        item(id("version-table"), 1,
          `Редакция ${oldYear} документа ${policy} требует уведомление за ${oldNotice} дней.`),
        item(id("version-table"), 2,
          `Редакция ${newYear} документа ${policy} требует уведомление за ${wrongNewNotice} дней.`)
      ],
      labels: [
        label(1, "supported", "versioned_fact", ["K1"], [
          "markdown_table_segmentation", "numeric_consistency", "version_attribution"
        ]),
        label(2, "contradicted", "versioned_fact", ["K2"], [
          "contradiction", "markdown_table_segmentation", "numeric_consistency",
          "version_attribution"
        ])
      ],
      language: "ru",
      query: `Сравни сроки уведомления документа ${policy}.`,
      split
    }),
    fixture({
      answer: [
        `- Сумма ${sumLeft} и ${sumRight} равна ${sum} [K1].`,
        `- Разница между ${differenceLeft} и ${differenceRight} равна ${difference} [K2].`
      ].join("\n"),
      arithmeticPlans: [
        {
          assertedOutput: String(sum),
          citationHandle: "K1",
          claimOrdinal: 1,
          operands: [String(sumLeft), String(sumRight)],
          operation: "add",
          outputUnit: null
        },
        {
          assertedOutput: String(difference),
          citationHandle: "K2",
          claimOrdinal: 2,
          operands: [String(differenceLeft), String(differenceRight)],
          operation: "subtract",
          outputUnit: null
        }
      ],
      documentFamily: family("arithmetic"),
      id: id("arithmetic"),
      items: [
        item(id("arithmetic"), 1,
          `Операция: сумма. Входы: ${sumLeft}, ${sumRight}. Результат: ${sum}.`),
        item(id("arithmetic"), 2,
          `Операция: разница. Входы: ${differenceLeft}, ${differenceRight}. Результат: ${difference}.`)
      ],
      labels: [
        label(1, "supported", "derived_arithmetic", ["K1"], [
          "derived_arithmetic", "list_segmentation", "numeric_consistency"
        ]),
        label(2, "supported", "derived_arithmetic", ["K2"], [
          "derived_arithmetic", "list_segmentation", "numeric_consistency"
        ])
      ],
      language: "ru",
      query: "Пересчитай два результата.",
      split
    }),
    fixture({
      answer: [
        `Источники расходятся: ${conflictOne} открыт [K1], тогда как он закрыт [K2].`,
        `Записи конфликтуют: ${conflictTwo} заблокирован [K3], тогда как он разблокирован [K4].`
      ].join("\n"),
      documentFamily: family("local-conflict"),
      id: id("local-conflict"),
      items: [
        item(id("local-conflict"), 1, `${conflictOne} открыт.`),
        item(id("local-conflict"), 2, `${conflictOne} закрыт.`),
        item(id("local-conflict"), 3, `${conflictTwo} заблокирован.`),
        item(id("local-conflict"), 4, `${conflictTwo} разблокирован.`)
      ],
      labels: [
        label(1, "supported", "comparison", ["K1", "K2"], [
          "citation_neighborhood", "contradiction", "generic_entailment"
        ]),
        label(2, "supported", "comparison", ["K3", "K4"], [
          "citation_neighborhood", "contradiction", "generic_entailment"
        ])
      ],
      language: "ru",
      query: "В чём расходятся локальные записи?",
      split
    }),
    fixture({
      answer: [
        `- Повреждённое ${uncertain} может указывать на согласование [K1].`,
        `- Выцветшее ${uncertain} может указывать на отказ [K2].`
      ].join("\n"),
      documentFamily: family("uncertainty"),
      id: id("uncertainty"),
      items: [
        ambiguousMatrixItem(id("uncertainty"), 1, "Согласование: согл[неразборчиво]"),
        ambiguousMatrixItem(id("uncertainty"), 2, "Решение: отк[неразборчиво]")
      ],
      labels: [
        label(1, "uncertain", "source_fact", ["K1"], [
          "generic_entailment", "list_segmentation", "locator_correctness", "uncertainty"
        ]),
        label(2, "uncertain", "source_fact", ["K2"], [
          "generic_entailment", "list_segmentation", "locator_correctness", "uncertainty"
        ])
      ],
      language: "ru",
      query: "Что указано в повреждённых полях?",
      split
    }),
    fixture({
      answer: `В выбранных источниках не указана дата ввода объекта ${row.key}.`,
      documentFamily: family("no-answer"),
      id: id("no-answer"),
      labels: [label(1, "supported", "source_summary", [], ["no_answer"])],
      language: "ru",
      query: `Когда введён объект ${row.key}?`,
      split
    }),
    fixture({
      answer: `Все выбранные источники подтверждают завершение проверки объекта ${row.key} [K1] [K2].`,
      documentFamily: family("coverage"),
      id: id("coverage"),
      items: [
        item(id("coverage"), 1, `Проверка объекта ${row.key} завершена.`),
        item(id("coverage"), 2, `Проверка объекта ${row.key} ещё не завершена.`)
      ],
      labels: [label(1, "contradicted", "coverage_claim", ["K1", "K2"], [
        "citation_neighborhood", "contradiction", "coverage_claim", "generic_entailment"
      ])],
      language: "ru",
      query: `Все ли источники подтверждают завершение проверки ${row.key}?`,
      split
    }),
    fixture({
      answer: `Общие сведения: ${row.generalKnowledge.ru}`,
      documentFamily: family("general-knowledge"),
      id: id("general-knowledge"),
      labels: [label(1, "supported", "general_knowledge", [], ["general_knowledge"])],
      language: "ru",
      query: "Какое общее сведение уместно?",
      split
    })
  ]);
}

function semanticMatrixFixtures(
  split: "development" | "blinded_review",
  rows: readonly SemanticMatrixRow[]
): readonly KnowledgeSemanticGroundingFixture[] {
  return Object.freeze(rows.flatMap((row) => [
    ...englishMatrixFixtures(split, row),
    ...russianMatrixFixtures(split, row)
  ]));
}

/**
 * Checked-in decisions below remain generated structural oracles. Candidate
 * inputs and blinded packets exclude them; only two separately imported human
 * submissions plus adjudication may satisfy independent semantic acceptance.
 */
const developmentFixtures = semanticMatrixFixtures("development", developmentMatrixRows);
const blindedReviewFixtures = semanticMatrixFixtures(
  "blinded_review",
  blindedReviewMatrixRows
);

type LocalizedReleaseText = Readonly<{ en: string; ru: string }>;
type ReleaseDomainTheme = Readonly<{
  arithmetic: Readonly<{
    difference: readonly [number, number];
    labels: readonly [LocalizedReleaseText, LocalizedReleaseText];
    sum: readonly [number, number];
  }>;
  coverage: readonly [LocalizedReleaseText, LocalizedReleaseText];
  directFacts: readonly [LocalizedReleaseText, LocalizedReleaseText];
  domain: LocalizedReleaseText;
  generalFacts: readonly [LocalizedReleaseText, LocalizedReleaseText];
  key: string;
  noAnswer: Readonly<{
    missing: LocalizedReleaseText;
    present: LocalizedReleaseText;
    presentEvidence: LocalizedReleaseText;
  }>;
  reference: Readonly<{
    actual: string;
    metric: LocalizedReleaseText;
    range: string;
    version: number;
  }>;
  temporal: Readonly<{
    dates: Readonly<{
      en: readonly [string, string];
      ru: readonly [string, string];
    }>;
    metric: LocalizedReleaseText;
    readings: readonly [string, string];
  }>;
  uncertainty: readonly [LocalizedReleaseText, LocalizedReleaseText];
}>;

function releaseText(en: string, ru: string): LocalizedReleaseText {
  return Object.freeze({ en, ru });
}

function localized(
  value: LocalizedReleaseText,
  language: KnowledgeSemanticGroundingLanguage
): string {
  return value[language];
}

function releaseDomainFixtures(
  split: "held_out" | "blinded_review",
  themes: readonly ReleaseDomainTheme[]
): readonly KnowledgeSemanticGroundingFixture[] {
  return Object.freeze(themes.flatMap((theme) => (["en", "ru"] as const).flatMap((language) => {
    const domain = localized(theme.domain, language);
    const [firstDirect, secondDirect] = theme.directFacts.map((fact) => localized(fact, language));
    const dates = theme.temporal.dates[language];
    const metric = localized(theme.temporal.metric, language);
    const [firstReading, secondReading] = theme.temporal.readings;
    const referenceMetric = localized(theme.reference.metric, language);
    const referenceEvidence = language === "en"
      ? `Version ${theme.reference.version} records the actual ${referenceMetric} as ${theme.reference.actual}; the reference interval is ${theme.reference.range}.`
      : `Редакция ${theme.reference.version} фиксирует фактический показатель ${referenceMetric}: ${theme.reference.actual}; референсный интервал: ${theme.reference.range}.`;
    const [sumLeft, sumRight] = theme.arithmetic.sum;
    const [differenceLeft, differenceRight] = theme.arithmetic.difference;
    const [sumLabel, differenceLabel] = theme.arithmetic.labels.map((entry) =>
      localized(entry, language));
    const [firstUncertain, secondUncertain] = theme.uncertainty.map((entry) =>
      localized(entry, language));
    const [firstCoverage, secondCoverage] = theme.coverage.map((entry) =>
      localized(entry, language));
    const [firstGeneral, secondGeneral] = theme.generalFacts.map((entry) =>
      localized(entry, language));
    const commonQuery = language === "en"
      ? `Verify the generated ${domain} record.`
      : `Проверь сгенерированную запись: ${domain}.`;

    return [
      generatedReleaseFixture({
        category: "direct-list",
        claims: [
          {
            answer: firstDirect,
            decision: "supported",
            evidence: [firstDirect],
            slices: ["direct_entailment", "list_segmentation", "locator_correctness"],
            type: "source_fact"
          },
          {
            answer: secondDirect,
            decision: "supported",
            evidence: [secondDirect],
            slices: ["direct_entailment", "list_segmentation", "locator_correctness"],
            type: "source_fact"
          }
        ],
        familyKey: `${theme.key}-records`,
        language,
        query: commonQuery,
        split
      }),
      generatedReleaseFixture({
        category: "dated-table",
        claims: [
          {
            answer: language === "en"
              ? `${dates[0]}: ${metric} was ${firstReading}.`
              : `${dates[0]}: показатель ${metric} составил ${firstReading}.`,
            decision: "supported",
            evidence: [language === "en"
              ? `On ${dates[0]}, ${domain} measured ${metric} at ${firstReading}.`
              : `${dates[0]} объект ${domain} зафиксировал показатель ${metric}: ${firstReading}.`],
            slices: [
              "date_consistency", "markdown_table_segmentation", "numeric_consistency",
              "temporal_non_contradiction"
            ],
            type: "temporal_observation"
          },
          {
            answer: language === "en"
              ? `${dates[1]}: ${metric} was ${secondReading}.`
              : `${dates[1]}: показатель ${metric} составил ${secondReading}.`,
            decision: "supported",
            evidence: [language === "en"
              ? `On ${dates[1]}, ${domain} measured ${metric} at ${secondReading}.`
              : `${dates[1]} объект ${domain} зафиксировал показатель ${metric}: ${secondReading}.`],
            slices: [
              "date_consistency", "markdown_table_segmentation", "numeric_consistency",
              "temporal_non_contradiction"
            ],
            type: "temporal_observation"
          }
        ],
        familyKey: `${theme.key}-observations`,
        language,
        query: language === "en"
          ? `Compare the two dated ${metric} readings for ${domain}.`
          : `Сравни два датированных значения ${metric} для ${domain}.`,
        split,
        table: {
          firstColumn: language === "en" ? "Observation" : "Наблюдение",
          rows: language === "en"
            ? ["Earlier record", "Later record"]
            : ["Ранняя запись", "Поздняя запись"]
        }
      }),
      generatedReleaseFixture({
        category: "version-reference",
        claims: [
          {
            answer: language === "en"
              ? `Version ${theme.reference.version} reports the actual ${referenceMetric} as ${theme.reference.range}.`
              : `Редакция ${theme.reference.version} указывает фактический показатель ${referenceMetric}: ${theme.reference.range}.`,
            decision: "contradicted",
            evidence: [referenceEvidence],
            slices: [
              "contradiction", "numeric_consistency", "reference_context", "version_attribution"
            ],
            type: "versioned_fact"
          },
          {
            answer: language === "en"
              ? `Version ${theme.reference.version} identifies ${theme.reference.range} as the reference interval for ${referenceMetric}.`
              : `Редакция ${theme.reference.version} определяет ${theme.reference.range} как референсный интервал для ${referenceMetric}.`,
            decision: "supported",
            evidence: [referenceEvidence],
            slices: ["numeric_consistency", "reference_context", "version_attribution"],
            type: "versioned_fact"
          }
        ],
        familyKey: `${theme.key}-actual-reference`,
        language,
        query: language === "en"
          ? `Separate actual and reference roles for ${referenceMetric}.`
          : `Раздели фактическую и референсную роли для ${referenceMetric}.`,
        split
      }),
      generatedReleaseFixture({
        category: "arithmetic-list",
        claims: [
          {
            answer: language === "en"
              ? `The ${sumLabel} total is ${sumLeft + sumRight}.`
              : `Итог ${sumLabel} равен ${sumLeft + sumRight}.`,
            arithmetic: {
              assertedOutput: String(sumLeft + sumRight),
              operands: [String(sumLeft), String(sumRight)],
              operation: "add",
              outputUnit: null
            },
            decision: "supported",
            evidence: [language === "en"
              ? `Sum inputs for ${sumLabel}: ${sumLeft} and ${sumRight}; result ${sumLeft + sumRight}.`
              : `Входы суммы ${sumLabel}: ${sumLeft} и ${sumRight}; результат ${sumLeft + sumRight}.`],
            slices: ["derived_arithmetic", "list_segmentation", "numeric_consistency"],
            type: "derived_arithmetic"
          },
          {
            answer: language === "en"
              ? `The ${differenceLabel} difference is ${differenceLeft - differenceRight + 1}.`
              : `Разница ${differenceLabel} равна ${differenceLeft - differenceRight + 1}.`,
            arithmetic: {
              assertedOutput: String(differenceLeft - differenceRight + 1),
              operands: [String(differenceLeft), String(differenceRight)],
              operation: "subtract",
              outputUnit: null
            },
            decision: "contradicted",
            evidence: [language === "en"
              ? `Difference inputs for ${differenceLabel}: ${differenceLeft} minus ${differenceRight}; result ${differenceLeft - differenceRight}.`
              : `Входы разницы ${differenceLabel}: ${differenceLeft} минус ${differenceRight}; результат ${differenceLeft - differenceRight}.`],
            slices: [
              "contradiction", "derived_arithmetic", "list_segmentation", "numeric_consistency"
            ],
            type: "derived_arithmetic"
          }
        ],
        familyKey: `${theme.key}-calculations`,
        language,
        query: language === "en"
          ? `Recompute the ${domain} totals.`
          : `Пересчитай итоги для ${domain}.`,
        split
      }),
      generatedReleaseFixture({
        category: "ambiguous-fields",
        claims: [
          {
            ambiguous: true,
            answer: language === "en"
              ? `The damaged ${firstUncertain} may indicate approval.`
              : `Повреждённое поле ${firstUncertain} может означать согласование.`,
            decision: "uncertain",
            evidence: [language === "en"
              ? `${domain}; ${firstUncertain}: appr[illegible]`
              : `${domain}; ${firstUncertain}: согл[неразборчиво]`],
            slices: [
              "generic_entailment", "list_segmentation", "locator_correctness", "uncertainty"
            ],
            type: "source_fact"
          },
          {
            ambiguous: true,
            answer: language === "en"
              ? `The faded ${secondUncertain} may indicate rejection.`
              : `Выцветшее поле ${secondUncertain} может означать отказ.`,
            decision: "uncertain",
            evidence: [language === "en"
              ? `${domain}; ${secondUncertain}: rej[illegible]`
              : `${domain}; ${secondUncertain}: отк[неразборчиво]`],
            slices: [
              "generic_entailment", "list_segmentation", "locator_correctness", "uncertainty"
            ],
            type: "source_fact"
          }
        ],
        familyKey: `${theme.key}-damaged-fields`,
        language,
        query: language === "en"
          ? `Read the damaged fields for ${domain}.`
          : `Прочитай повреждённые поля для ${domain}.`,
        split
      }),
      generatedReleaseFixture({
        category: "coverage-conflict",
        claims: [
          {
            answer: language === "en"
              ? `All selected sources state that ${firstCoverage} is complete.`
              : `Все выбранные источники подтверждают завершение проверки «${firstCoverage}».`,
            decision: "contradicted",
            evidence: language === "en"
              ? [`${firstCoverage} is complete.`, `${firstCoverage} remains pending.`]
              : [`${firstCoverage} завершён.`, `${firstCoverage} ещё выполняется.`],
            slices: [
              "citation_neighborhood", "contradiction", "coverage_claim", "generic_entailment"
            ],
            type: "coverage_claim"
          },
          {
            answer: language === "en"
              ? `Every document confirms that ${secondCoverage} passed inspection.`
              : `Каждый документ подтверждает, что ${secondCoverage} прошёл проверку.`,
            decision: "unsupported",
            evidence: language === "en"
              ? [`${secondCoverage} has an assigned owner.`, `${secondCoverage} has an archived schedule.`]
              : [`Для ${secondCoverage} назначен владелец.`, `График ${secondCoverage} помещён в архив.`],
            slices: ["citation_neighborhood", "coverage_claim", "generic_entailment"],
            type: "coverage_claim"
          }
        ],
        familyKey: `${theme.key}-coverage`,
        language,
        query: language === "en"
          ? `Do the ${domain} sources support exhaustive status claims?`
          : `Поддерживают ли источники ${domain} исчерпывающие утверждения?`,
        split
      }),
      generatedReleaseFixture({
        category: "general-knowledge",
        claims: [
          {
            answer: language === "en" ? `General knowledge: ${firstGeneral}` : `Общие сведения: ${firstGeneral}`,
            decision: "supported",
            evidence: [],
            slices: ["general_knowledge"],
            type: "general_knowledge"
          },
          {
            answer: language === "en" ? `In general: ${secondGeneral}` : `В общем случае: ${secondGeneral}`,
            decision: "supported",
            evidence: [],
            slices: ["general_knowledge"],
            type: "general_knowledge"
          }
        ],
        familyKey: `${theme.key}-general-facts`,
        language,
        query: language === "en"
          ? `State two general facts relevant to ${domain}.`
          : `Назови два общих факта, относящихся к ${domain}.`,
        split
      }),
      generatedReleaseFixture({
        category: "no-answer",
        claims: [
          {
            answer: language === "en"
              ? `I couldn't find ${localized(theme.noAnswer.missing, language)} in the selected sources.`
              : `В выбранных источниках не указано: ${localized(theme.noAnswer.missing, language)}.`,
            decision: "supported",
            evidence: [],
            slices: ["no_answer"],
            type: "source_summary"
          },
          {
            answer: language === "en"
              ? `I couldn't find ${localized(theme.noAnswer.present, language)} in the selected sources.`
              : `В выбранных источниках не указано: ${localized(theme.noAnswer.present, language)}.`,
            citeEvidence: false,
            decision: "unsupported",
            evidence: [localized(theme.noAnswer.presentEvidence, language)],
            slices: ["no_answer"],
            type: "source_summary"
          }
        ],
        familyKey: `${theme.key}-missing-records`,
        language,
        query: language === "en"
          ? `Which requested ${domain} details are absent?`
          : `Какие запрошенные сведения ${domain} отсутствуют?`,
        split
      })
    ];
  })));
}

const heldOutReleaseThemes = Object.freeze([
  {
    arithmetic: {
      difference: [91, 37],
      labels: [releaseText("manifest batch", "партии манифеста"), releaseText("container balance", "баланса контейнеров")],
      sum: [46, 29]
    },
    coverage: [releaseText("the manifest audit", "аудит манифеста"), releaseText("the quay-crane inspection", "проверка портального крана")],
    directFacts: [
      releaseText("The harbor manifest router accepts signed cargo bundles.", "Маршрутизатор портовых манифестов принимает подписанные грузовые пакеты."),
      releaseText("The cold-store index exposes the seal status for each container.", "Индекс холодильного склада показывает состояние пломбы каждого контейнера.")
    ],
    domain: releaseText("harbor logistics ledger", "журнал портовой логистики"),
    generalFacts: [
      releaseText("seawater is usually denser than fresh water.", "морская вода обычно плотнее пресной."),
      releaseText("tides are influenced strongly by the Moon's gravity.", "на приливы существенно влияет гравитация Луны.")
    ],
    key: "harbor-logistics",
    noAnswer: {
      missing: releaseText("the original quay commissioning hour", "исходный час ввода причала в эксплуатацию"),
      present: releaseText("the emergency radio channel", "аварийный радиоканал"),
      presentEvidence: releaseText("The emergency radio channel is VHF 12.", "Аварийный радиоканал — УКВ 12.")
    },
    reference: {
      actual: "3.8 mg/L",
      metric: releaseText("ballast chloride", "хлорид в балластной воде"),
      range: "2.0–4.0 mg/L",
      version: 2031
    },
    temporal: {
      dates: { en: ["2031-03-04", "2031-06-19"], ru: ["04.03.2031", "19.06.2031"] },
      metric: releaseText("berth wind speed", "скорость ветра у причала"),
      readings: ["8.4 m/s", "11.2 m/s"]
    },
    uncertainty: [releaseText("customs-release stamp", "штамп таможенного выпуска"), releaseText("hazard-class box", "поле класса опасности")]
  },
  {
    arithmetic: {
      difference: [78, 23],
      labels: [releaseText("assay tray", "кассеты анализов"), releaseText("reagent reserve", "остатка реагента")],
      sum: [34, 27]
    },
    coverage: [releaseText("the instrument calibration", "калибровка прибора"), releaseText("the freezer alarm review", "проверка тревог морозильника")],
    directFacts: [
      releaseText("The hematology bench routes urgent samples through the red rack.", "Гематологический пост направляет срочные образцы через красную стойку."),
      releaseText("The biobank register records consent separately from tube location.", "Реестр биобанка хранит согласие отдельно от местоположения пробирки.")
    ],
    domain: releaseText("clinical laboratory worksheet", "рабочий лист клинической лаборатории"),
    generalFacts: [
      releaseText("human red blood cells transport oxygen using hemoglobin.", "эритроциты человека переносят кислород с помощью гемоглобина."),
      releaseText("water expands when it freezes.", "вода расширяется при замерзании.")
    ],
    key: "clinical-laboratory",
    noAnswer: {
      missing: releaseText("the architect of the original specimen room", "архитектора первоначальной комнаты образцов"),
      present: releaseText("the serum storage temperature", "температуру хранения сыворотки"),
      presentEvidence: releaseText("Serum is stored at minus 20 degrees Celsius.", "Сыворотка хранится при минус 20 градусах Цельсия.")
    },
    reference: {
      actual: "5.6 mmol/L",
      metric: releaseText("fasting glucose", "глюкоза натощак"),
      range: "3.9–6.1 mmol/L",
      version: 2032
    },
    temporal: {
      dates: { en: ["2032-01-17", "2032-02-28"], ru: ["17.01.2032", "28.02.2032"] },
      metric: releaseText("freezer temperature", "температура морозильника"),
      readings: ["-19.6 °C", "-20.3 °C"]
    },
    uncertainty: [releaseText("specimen-acceptance mark", "отметка приёмки образца"), releaseText("centrifuge-cycle field", "поле цикла центрифуги")]
  },
  {
    arithmetic: {
      difference: [143, 58],
      labels: [releaseText("reservoir inflow", "притока в резервуар"), releaseText("hydrant inventory", "остатка гидрантов")],
      sum: [72, 41]
    },
    coverage: [releaseText("the valve survey", "обследование клапанов"), releaseText("the sampling-route review", "проверка маршрута отбора проб")],
    directFacts: [
      releaseText("The north reservoir feeds the pressure zone through two gravity mains.", "Северный резервуар питает зону давления по двум самотечным магистралям."),
      releaseText("The chlorine cabinet requires a paired-entry safety check.", "Хлорная камера требует парной проверки перед входом.")
    ],
    domain: releaseText("municipal water operations book", "оперативный журнал городского водоканала"),
    generalFacts: [
      releaseText("liquid water flows downhill under gravity when unpressurized.", "без давления жидкая вода течёт вниз под действием силы тяжести."),
      releaseText("one cubic metre equals one thousand litres.", "один кубический метр равен одной тысяче литров.")
    ],
    key: "municipal-water",
    noAnswer: {
      missing: releaseText("the mason who built the first pump house", "каменщика, построившего первую насосную"),
      present: releaseText("the overnight pressure target", "ночную целевую величину давления"),
      presentEvidence: releaseText("The overnight pressure target is 310 kPa.", "Ночная целевая величина давления — 310 кПа.")
    },
    reference: {
      actual: "0.42 mg/L",
      metric: releaseText("outlet free chlorine", "свободный хлор на выходе"),
      range: "0.20–0.50 mg/L",
      version: 2033
    },
    temporal: {
      dates: { en: ["2033-04-08", "2033-07-22"], ru: ["08.04.2033", "22.07.2033"] },
      metric: releaseText("reservoir level", "уровень резервуара"),
      readings: ["6.18 m", "5.74 m"]
    },
    uncertainty: [releaseText("backflow-test result", "результат проверки обратного потока"), releaseText("valve-direction arrow", "стрелка направления клапана")]
  },
  {
    arithmetic: {
      difference: [119, 44],
      labels: [releaseText("inspection-hour", "часов инспекции"), releaseText("spare-fastener stock", "остатка крепежа")],
      sum: [38, 52]
    },
    coverage: [releaseText("the wing-panel inspection", "проверка панели крыла"), releaseText("the torque-tool certification", "сертификация динамометрического ключа")],
    directFacts: [
      releaseText("The composite shop quarantines panels after an ultrasonic anomaly.", "Композитный цех помещает панели в карантин после ультразвуковой аномалии."),
      releaseText("The tool crib issues calibrated wrenches against a signed job card.", "Инструментальная выдаёт калиброванные ключи по подписанной карте работ.")
    ],
    domain: releaseText("airframe maintenance dossier", "досье технического обслуживания планера"),
    generalFacts: [
      releaseText("aluminium is less dense than steel.", "алюминий менее плотный, чем сталь."),
      releaseText("air pressure generally decreases with altitude.", "атмосферное давление обычно уменьшается с высотой.")
    ],
    key: "airframe-maintenance",
    noAnswer: {
      missing: releaseText("the painter of the prototype tail emblem", "художника эмблемы хвоста прототипа"),
      present: releaseText("the torque-tool recall code", "код отзыва динамометрического инструмента"),
      presentEvidence: releaseText("The torque-tool recall code is TW-83A.", "Код отзыва динамометрического инструмента — TW-83A.")
    },
    reference: {
      actual: "0.31 mm",
      metric: releaseText("panel edge gap", "зазор кромки панели"),
      range: "0.20–0.45 mm",
      version: 2034
    },
    temporal: {
      dates: { en: ["2034-02-11", "2034-09-03"], ru: ["11.02.2034", "03.09.2034"] },
      metric: releaseText("hydraulic test pressure", "давление гидравлического испытания"),
      readings: ["20.4 MPa", "20.1 MPa"]
    },
    uncertainty: [releaseText("nonconformance disposition", "решение по несоответствию"), releaseText("inspector initials", "инициалы инспектора")]
  },
  {
    arithmetic: {
      difference: [204, 79],
      labels: [releaseText("cataloguing queue", "очереди каталогизации"), releaseText("archive-box balance", "остатка архивных коробов")],
      sum: [63, 58]
    },
    coverage: [releaseText("the provenance review", "проверка происхождения"), releaseText("the humidity-log inspection", "проверка журнала влажности")],
    directFacts: [
      releaseText("The rare-books desk photographs bindings before conservation work.", "Отдел редких книг фотографирует переплёты до реставрации."),
      releaseText("The accession register links every donation to its deed record.", "Инвентарный реестр связывает каждое пожертвование с актом передачи.")
    ],
    domain: releaseText("library preservation register", "реестр сохранности библиотеки"),
    generalFacts: [
      releaseText("paper can become brittle under acidic conditions.", "бумага может стать хрупкой в кислой среде."),
      releaseText("ultraviolet light can fade many pigments.", "ультрафиолетовый свет может выцветать многие пигменты.")
    ],
    key: "library-preservation",
    noAnswer: {
      missing: releaseText("the bindery's nineteenth-century street address", "адрес переплётной мастерской девятнадцатого века"),
      present: releaseText("the reading-room humidity limit", "предел влажности читального зала"),
      presentEvidence: releaseText("The reading-room humidity limit is 55 percent.", "Предел влажности читального зала — 55 процентов.")
    },
    reference: {
      actual: "49 %RH",
      metric: releaseText("vault humidity", "влажность хранилища"),
      range: "45–55 %RH",
      version: 2035
    },
    temporal: {
      dates: { en: ["2035-05-13", "2035-08-27"], ru: ["13.05.2035", "27.08.2035"] },
      metric: releaseText("reading-room illuminance", "освещённость читального зала"),
      readings: ["185 lx", "172 lx"]
    },
    uncertainty: [releaseText("donor restriction note", "отметка об ограничении дарителя"), releaseText("shelf-location suffix", "суффикс полочного шифра")]
  },
  {
    arithmetic: {
      difference: [167, 62],
      labels: [releaseText("irrigation batch", "партии полива"), releaseText("seedling balance", "остатка саженцев")],
      sum: [54, 36]
    },
    coverage: [releaseText("the pest-monitoring round", "обход контроля вредителей"), releaseText("the nutrient-tank inspection", "проверка питательного бака")],
    directFacts: [
      releaseText("The east greenhouse opens ridge vents before activating mist cooling.", "Восточная теплица открывает коньковые форточки до включения туманообразования."),
      releaseText("The seedling bench logs each cultivar in a separate propagation lane.", "Рассадный стол регистрирует каждый сорт в отдельной линии размножения.")
    ],
    domain: releaseText("greenhouse cultivation log", "журнал выращивания в теплице"),
    generalFacts: [
      releaseText("plants use light energy during photosynthesis.", "растения используют энергию света в процессе фотосинтеза."),
      releaseText("evaporation can cool a wet surface.", "испарение может охлаждать влажную поверхность.")
    ],
    key: "greenhouse-cultivation",
    noAnswer: {
      missing: releaseText("the surname of the first orchard keeper", "фамилию первого смотрителя сада"),
      present: releaseText("the night ventilation threshold", "ночной порог вентиляции"),
      presentEvidence: releaseText("Night ventilation starts at 24 degrees Celsius.", "Ночная вентиляция включается при 24 градусах Цельсия.")
    },
    reference: {
      actual: "6.3 pH",
      metric: releaseText("nutrient-solution acidity", "кислотность питательного раствора"),
      range: "5.8–6.5 pH",
      version: 2036
    },
    temporal: {
      dates: { en: ["2036-03-16", "2036-04-29"], ru: ["16.03.2036", "29.04.2036"] },
      metric: releaseText("canopy temperature", "температура полога"),
      readings: ["22.7 °C", "24.1 °C"]
    },
    uncertainty: [releaseText("pollination-complete box", "поле завершения опыления"), releaseText("disease-scouting code", "код фитосанитарного осмотра")]
  },
  {
    arithmetic: {
      difference: [188, 71],
      labels: [releaseText("wagon count", "состава вагонов"), releaseText("signal-lamp reserve", "остатка сигнальных ламп")],
      sum: [67, 45]
    },
    coverage: [releaseText("the route-lock test", "проверка замыкания маршрута"), releaseText("the platform-edge survey", "обследование края платформы")],
    directFacts: [
      releaseText("The west interlocking blocks a route when the flank point is unsecured.", "Западная централизация блокирует маршрут при незапертом охранном остряке."),
      releaseText("The dispatch board marks engineering possessions with violet bands.", "Диспетчерское табло отмечает технологические окна фиолетовыми полосами.")
    ],
    domain: releaseText("rail dispatch movement sheet", "лист движения железнодорожного диспетчера"),
    generalFacts: [
      releaseText("steel rails expand when their temperature rises.", "стальные рельсы расширяются при повышении температуры."),
      releaseText("a moving vehicle has kinetic energy.", "движущееся транспортное средство обладает кинетической энергией.")
    ],
    key: "rail-dispatch",
    noAnswer: {
      missing: releaseText("the designer of the original station clock", "конструктора первоначальных станционных часов"),
      present: releaseText("the overnight possession identifier", "идентификатор ночного технологического окна"),
      presentEvidence: releaseText("The overnight possession identifier is RP-440.", "Идентификатор ночного технологического окна — RP-440.")
    },
    reference: {
      actual: "4.7 mm",
      metric: releaseText("switch detection gap", "зазор контроля стрелки"),
      range: "3.5–5.0 mm",
      version: 2037
    },
    temporal: {
      dates: { en: ["2037-06-02", "2037-11-14"], ru: ["02.06.2037", "14.11.2037"] },
      metric: releaseText("axle-counter reset time", "время сброса счётчика осей"),
      readings: ["42 s", "39 s"]
    },
    uncertainty: [releaseText("route-release signature", "подпись освобождения маршрута"), releaseText("temporary-speed digit", "цифра временного ограничения скорости")]
  },
  {
    arithmetic: {
      difference: [132, 49],
      labels: [releaseText("battery string", "цепочки аккумуляторов"), releaseText("inverter-module balance", "остатка модулей инвертора")],
      sum: [48, 57]
    },
    coverage: [releaseText("the islanding drill", "испытание островного режима"), releaseText("the feeder-protection review", "проверка защиты фидера")],
    directFacts: [
      releaseText("The campus microgrid sheds the workshop feeder before the clinic feeder.", "Кампусная микросеть отключает фидер мастерской раньше фидера клиники."),
      releaseText("The battery controller reserves a separate block for black-start service.", "Контроллер батареи резервирует отдельный блок для автономного запуска.")
    ],
    domain: releaseText("microgrid operating schedule", "оперативный график микросети"),
    generalFacts: [
      releaseText("electrical power is the rate at which electrical energy is transferred.", "электрическая мощность — это скорость передачи электрической энергии."),
      releaseText("solar panels produce direct current.", "солнечные панели вырабатывают постоянный ток.")
    ],
    key: "microgrid-operations",
    noAnswer: {
      missing: releaseText("the colour of the first inverter enclosure", "цвет корпуса первого инвертора"),
      present: releaseText("the black-start battery floor", "минимальный заряд батареи для автономного запуска"),
      presentEvidence: releaseText("Black start requires at least 38 percent battery charge.", "Для автономного запуска требуется не менее 38 процентов заряда батареи.")
    },
    reference: {
      actual: "49.96 Hz",
      metric: releaseText("island frequency", "частота островного режима"),
      range: "49.80–50.20 Hz",
      version: 2038
    },
    temporal: {
      dates: { en: ["2038-01-09", "2038-07-31"], ru: ["09.01.2038", "31.07.2038"] },
      metric: releaseText("battery state of charge", "уровень заряда батареи"),
      readings: ["64 %", "71 %"]
    },
    uncertainty: [releaseText("breaker-ready indicator", "индикатор готовности выключателя"), releaseText("dispatch-approval cell", "поле согласования диспетчера")]
  }
] satisfies readonly ReleaseDomainTheme[]);

const blindedReviewReleaseThemes = Object.freeze([
  {
    arithmetic: {
      difference: [154, 63],
      labels: [releaseText("ice-core crate", "ящиков ледяных кернов"), releaseText("sensor-buoy balance", "остатка буёв-датчиков")],
      sum: [39, 44]
    },
    coverage: [releaseText("the crevasse-route survey", "обследование маршрута через трещины"), releaseText("the cold-room alarm test", "проверка тревоги холодильной камеры")],
    directFacts: [
      releaseText("The polar field station pairs every ice core with a depth manifest.", "Полярная станция связывает каждый ледяной керн с ведомостью глубины."),
      releaseText("The weather mast buffers observations during satellite outages.", "Метеомачта буферизует наблюдения во время сбоев спутниковой связи.")
    ],
    domain: releaseText("polar research field log", "полевой журнал полярных исследований"),
    generalFacts: [
      releaseText("fresh snow usually reflects much of the visible light that reaches it.", "свежий снег обычно отражает значительную часть падающего видимого света."),
      releaseText("sea ice forms from frozen ocean water.", "морской лёд образуется из замёрзшей океанской воды.")
    ],
    key: "polar-fieldwork",
    noAnswer: {
      missing: releaseText("the carpenter who built the first instrument hut", "плотника, построившего первый приборный домик"),
      present: releaseText("the emergency cache bearing", "азимут аварийного склада"),
      presentEvidence: releaseText("The emergency cache bearing is 074 degrees true.", "Истинный азимут аварийного склада — 074 градуса.")
    },
    reference: {
      actual: "-31.4 °C",
      metric: releaseText("core-storage temperature", "температура хранения кернов"),
      range: "-35.0–-28.0 °C",
      version: 2041
    },
    temporal: {
      dates: { en: ["2041-02-06", "2041-05-24"], ru: ["06.02.2041", "24.05.2041"] },
      metric: releaseText("snow accumulation", "накопление снега"),
      readings: ["18.6 cm", "27.9 cm"]
    },
    uncertainty: [releaseText("sample-orientation arrow", "стрелка ориентации образца"), releaseText("fuel-cache seal", "пломба топливного склада")]
  },
  {
    arithmetic: {
      difference: [211, 86],
      labels: [releaseText("woven roll", "рулонов ткани"), releaseText("dye-bath reserve", "остатка красильной ванны")],
      sum: [74, 53]
    },
    coverage: [releaseText("the loom-guard audit", "аудит ограждений станков"), releaseText("the shade-card inspection", "проверка карты оттенков")],
    directFacts: [
      releaseText("The jacquard line stores the pattern checksum before each production run.", "Жаккардовая линия сохраняет хэш узора перед каждым запуском."),
      releaseText("The finishing room separates flame-retardant lots from ordinary fabric.", "Отделочная зона отделяет огнестойкие партии от обычной ткани.")
    ],
    domain: releaseText("textile mill production card", "производственная карта текстильной фабрики"),
    generalFacts: [
      releaseText("woven fabric is made by interlacing warp and weft threads.", "ткань получают переплетением нитей основы и утка."),
      releaseText("cotton is a plant fibre.", "хлопок является растительным волокном.")
    ],
    key: "textile-production",
    noAnswer: {
      missing: releaseText("the inventor of the mill's first shuttle rack", "изобретателя первой стойки челноков фабрики"),
      present: releaseText("the indigo-bath circulation time", "время циркуляции ванны индиго"),
      presentEvidence: releaseText("The indigo bath circulates for 26 minutes.", "Ванна индиго циркулирует 26 минут.")
    },
    reference: {
      actual: "4.2 %",
      metric: releaseText("finished-cloth moisture", "влажность готовой ткани"),
      range: "3.5–5.0 %",
      version: 2042
    },
    temporal: {
      dates: { en: ["2042-03-12", "2042-08-30"], ru: ["12.03.2042", "30.08.2042"] },
      metric: releaseText("loom vibration", "вибрация ткацкого станка"),
      readings: ["2.7 mm/s", "3.1 mm/s"]
    },
    uncertainty: [releaseText("shade-approval mark", "отметка согласования оттенка"), releaseText("selvedge-defect code", "код дефекта кромки")]
  },
  {
    arithmetic: {
      difference: [96, 28],
      labels: [releaseText("condition-report", "отчётов о состоянии"), releaseText("archival-sleeve balance", "остатка архивных конвертов")],
      sum: [31, 47]
    },
    coverage: [releaseText("the gallery-light survey", "обследование освещения галереи"), releaseText("the loan-crate inspection", "проверка транспортного ящика")],
    directFacts: [
      releaseText("The conservation studio records pigment tests before surface cleaning.", "Реставрационная мастерская фиксирует пробы пигмента до очистки поверхности."),
      releaseText("The loan register keeps courier conditions with the object movement.", "Реестр выдач хранит условия курьера вместе с перемещением предмета." )
    ],
    domain: releaseText("museum conservation file", "реставрационное дело музея"),
    generalFacts: [
      releaseText("relative humidity compares water vapour with the maximum possible at that temperature.", "относительная влажность сравнивает содержание водяного пара с максимумом при данной температуре."),
      releaseText("bronze is primarily an alloy of copper and tin.", "бронза в основном является сплавом меди и олова.")
    ],
    key: "museum-conservation",
    noAnswer: {
      missing: releaseText("the childhood address of the frame maker", "детский адрес изготовителя рамы"),
      present: releaseText("the maximum case illuminance", "максимальную освещённость витрины"),
      presentEvidence: releaseText("Case illuminance must not exceed 80 lux.", "Освещённость витрины не должна превышать 80 люкс.")
    },
    reference: {
      actual: "51 %RH",
      metric: releaseText("display-case humidity", "влажность витрины"),
      range: "47–53 %RH",
      version: 2043
    },
    temporal: {
      dates: { en: ["2043-01-21", "2043-10-05"], ru: ["21.01.2043", "05.10.2043"] },
      metric: releaseText("canvas tension", "натяжение холста"),
      readings: ["14.8 N/cm", "14.2 N/cm"]
    },
    uncertainty: [releaseText("varnish-test note", "отметка пробы лака"), releaseText("object-movement initials", "инициалы перемещения предмета")]
  },
  {
    arithmetic: {
      difference: [173, 59],
      labels: [releaseText("hose bundle", "комплекта рукавов"), releaseText("retardant-tank balance", "остатка антипирена")],
      sum: [62, 48]
    },
    coverage: [releaseText("the evacuation-route check", "проверка маршрута эвакуации"), releaseText("the portable-pump inspection", "проверка переносной мотопомпы")],
    directFacts: [
      releaseText("The wildfire base stages breathing zones upwind of the fuel cache.", "Лесопожарная база размещает зоны дыхания с наветренной стороны от склада топлива."),
      releaseText("The operations board pairs each crew with a fallback radio group.", "Оперативное табло назначает каждой группе резервную радиогруппу." )
    ],
    domain: releaseText("wildfire response action sheet", "оперативный лист реагирования на лесной пожар"),
    generalFacts: [
      releaseText("warm air can rise because it is less dense than cooler surrounding air.", "тёплый воздух может подниматься, поскольку он менее плотный, чем окружающий холодный воздух."),
      releaseText("combustion requires fuel, oxygen, and sufficient heat.", "для горения необходимы топливо, кислород и достаточное тепло." )
    ],
    key: "wildfire-response",
    noAnswer: {
      missing: releaseText("the brand of boots worn on the first patrol", "марку сапог первого патруля"),
      present: releaseText("the fallback command frequency", "резервную командную частоту"),
      presentEvidence: releaseText("The fallback command frequency is 168.625 MHz.", "Резервная командная частота — 168,625 МГц." )
    },
    reference: {
      actual: "17 %",
      metric: releaseText("fine-fuel moisture", "влажность мелкого горючего материала"),
      range: "12–20 %",
      version: 2044
    },
    temporal: {
      dates: { en: ["2044-06-18", "2044-06-26"], ru: ["18.06.2044", "26.06.2044"] },
      metric: releaseText("fireline humidity", "влажность на кромке пожара"),
      readings: ["28 %RH", "22 %RH"]
    },
    uncertainty: [releaseText("crew-accountability tick", "отметка учёта группы"), releaseText("escape-route arrow", "стрелка пути отхода")]
  },
  {
    arithmetic: {
      difference: [226, 88],
      labels: [releaseText("juvenile-fish cohort", "партии молоди"), releaseText("feed-bin balance", "остатка корма")],
      sum: [83, 64]
    },
    coverage: [releaseText("the screen-cleaning round", "цикл очистки решёток"), releaseText("the vaccination-tray inspection", "проверка лотка вакцинации")],
    directFacts: [
      releaseText("The hatchery separates newly fed fry from unfed emergence groups.", "Рыбоводный завод отделяет впервые покормленную молодь от непитавшихся групп."),
      releaseText("The raceway register records dissolved oxygen beside each cohort transfer.", "Журнал бассейнов фиксирует растворённый кислород рядом с каждым переводом партии." )
    ],
    domain: releaseText("fish hatchery cohort ledger", "журнал партий рыбоводного завода"),
    generalFacts: [
      releaseText("fish extract dissolved oxygen from water using gills.", "рыбы извлекают растворённый кислород из воды с помощью жабр."),
      releaseText("water holds less dissolved oxygen when its temperature rises under otherwise equal conditions.", "при прочих равных вода удерживает меньше растворённого кислорода при повышении температуры." )
    ],
    key: "hatchery-cohorts",
    noAnswer: {
      missing: releaseText("the quarry that supplied the original raceway stone", "карьер, поставивший камень для первого бассейна"),
      present: releaseText("the minimum raceway oxygen level", "минимальный уровень кислорода в бассейне"),
      presentEvidence: releaseText("Raceway oxygen must remain above 7.2 mg/L.", "Кислород в бассейне должен оставаться выше 7,2 мг/л." )
    },
    reference: {
      actual: "8.1 mg/L",
      metric: releaseText("raceway dissolved oxygen", "растворённый кислород в бассейне"),
      range: "7.2–9.5 mg/L",
      version: 2045
    },
    temporal: {
      dates: { en: ["2045-04-03", "2045-05-16"], ru: ["03.04.2045", "16.05.2045"] },
      metric: releaseText("raceway flow", "поток воды в бассейне"),
      readings: ["42 L/s", "46 L/s"]
    },
    uncertainty: [releaseText("mortality-cause box", "поле причины отхода"), releaseText("feed-lot suffix", "суффикс партии корма")]
  },
  {
    arithmetic: {
      difference: [147, 52],
      labels: [releaseText("fibre splice", "оптических сварок"), releaseText("battery-module balance", "остатка аккумуляторных модулей")],
      sum: [56, 61]
    },
    coverage: [releaseText("the cabinet-seal audit", "аудит пломб шкафа"), releaseText("the failover-path inspection", "проверка резервного маршрута")],
    directFacts: [
      releaseText("The access ring reroutes voice traffic before bulk data during congestion.", "Кольцо доступа перенаправляет голосовой трафик раньше пакетных данных при перегрузке."),
      releaseText("The street cabinet inventory links every optic tray to a splice drawing.", "Опись уличного шкафа связывает каждый оптический лоток со схемой сварок." )
    ],
    domain: releaseText("telecommunications outage register", "журнал отказов телекоммуникационной сети"),
    generalFacts: [
      releaseText("optical fibres guide light through a transparent core.", "оптические волокна проводят свет через прозрачную сердцевину."),
      releaseText("a decibel is a logarithmic unit used for ratios.", "децибел — логарифмическая единица, используемая для отношений величин." )
    ],
    key: "telecom-outages",
    noAnswer: {
      missing: releaseText("the nickname of the first cable-laying vessel", "прозвище первого кабелеукладочного судна"),
      present: releaseText("the protected voice restoration target", "целевое время восстановления защищённой голосовой связи"),
      presentEvidence: releaseText("Protected voice service must recover within 18 minutes.", "Защищённая голосовая связь должна восстановиться за 18 минут." )
    },
    reference: {
      actual: "0.29 dB",
      metric: releaseText("splice insertion loss", "вносимые потери сварки"),
      range: "0.10–0.35 dB",
      version: 2046
    },
    temporal: {
      dates: { en: ["2046-07-07", "2046-12-19"], ru: ["07.07.2046", "19.12.2046"] },
      metric: releaseText("packet restoration time", "время восстановления пакетной связи"),
      readings: ["11.4 min", "8.9 min"]
    },
    uncertainty: [releaseText("splice-acceptance mark", "отметка приёмки сварки"), releaseText("cabinet-earth code", "код заземления шкафа")]
  },
  {
    arithmetic: {
      difference: [184, 69],
      labels: [releaseText("sealed carton", "герметичных коробов"), releaseText("label-stock balance", "остатка этикеток")],
      sum: [68, 72]
    },
    coverage: [releaseText("the line-clearance review", "проверка освобождения линии"), releaseText("the vision-camera challenge", "испытание камеры технического зрения")],
    directFacts: [
      releaseText("The packaging line rejects cartons whose tamper band lacks continuity.", "Упаковочная линия отбраковывает короба с нарушенной целостностью контрольной ленты."),
      releaseText("The serialisation station reserves numbers before printing the carton label.", "Станция сериализации резервирует идентификаторы до печати этикетки короба." )
    ],
    domain: releaseText("pharmaceutical packaging batch record", "пакетная запись фармацевтической упаковки"),
    generalFacts: [
      releaseText("a barcode encodes data in a machine-readable visual pattern.", "штрихкод кодирует данные в машиночитаемом графическом узоре."),
      releaseText("water vapour can pass through some packaging materials.", "водяной пар может проходить через некоторые упаковочные материалы." )
    ],
    key: "pharma-packaging",
    noAnswer: {
      missing: releaseText("the printer model used for the first engineering trial", "модель принтера первого инженерного испытания"),
      present: releaseText("the carton serialisation prefix", "префикс сериализации короба"),
      presentEvidence: releaseText("The carton serialisation prefix is QL7.", "Префикс сериализации короба — QL7." )
    },
    reference: {
      actual: "1.7 N",
      metric: releaseText("tamper-band peel force", "усилие отрыва контрольной ленты"),
      range: "1.2–2.1 N",
      version: 2047
    },
    temporal: {
      dates: { en: ["2047-02-14", "2047-09-08"], ru: ["14.02.2047", "08.09.2047"] },
      metric: releaseText("carton rejection rate", "доля отбракованных коробов"),
      readings: ["0.8 %", "0.5 %"]
    },
    uncertainty: [releaseText("line-clearance signature", "подпись освобождения линии"), releaseText("camera-challenge result", "результат испытания камеры")]
  },
  {
    arithmetic: {
      difference: [263, 97],
      labels: [releaseText("passenger count", "пассажиропотока"), releaseText("ticket-validator balance", "остатка валидаторов")],
      sum: [92, 81]
    },
    coverage: [releaseText("the platform-door test", "испытание платформенных дверей"), releaseText("the accessibility-ramp survey", "обследование пандуса доступности")],
    directFacts: [
      releaseText("The metro control room holds a train when a platform door remains unproved.", "Диспетчерская метро задерживает поезд, если платформенная дверь не подтверждена."),
      releaseText("The fare system stores concession eligibility separately from journey history.", "Тарифная система хранит право на льготу отдельно от истории поездок." )
    ],
    domain: releaseText("urban transit service bulletin", "служебный бюллетень городского транспорта"),
    generalFacts: [
      releaseText("friction between wheels and rails enables acceleration and braking.", "контакт колёс с рельсами обеспечивает разгон и торможение."),
      releaseText("one kilometre equals one thousand metres.", "один километр равен одной тысяче метров." )
    ],
    key: "urban-transit",
    noAnswer: {
      missing: releaseText("the composer of the original station chime", "композитора первоначального станционного сигнала"),
      present: releaseText("the platform-door isolation code", "код изоляции платформенной двери"),
      presentEvidence: releaseText("The platform-door isolation code is PSD-19.", "Код изоляции платформенной двери — PSD-19." )
    },
    reference: {
      actual: "2.6 mm",
      metric: releaseText("door sill gap", "зазор дверного порога"),
      range: "1.5–3.0 mm",
      version: 2048
    },
    temporal: {
      dates: { en: ["2048-03-25", "2048-11-11"], ru: ["25.03.2048", "11.11.2048"] },
      metric: releaseText("peak dwell time", "время стоянки в час пик"),
      readings: ["41 s", "37 s"]
    },
    uncertainty: [releaseText("door-test acknowledgement", "подтверждение испытания двери"), releaseText("ramp-gradient digit", "цифра уклона пандуса")]
  }
] satisfies readonly ReleaseDomainTheme[]);

type CalibrationReleaseTheme = Readonly<{
  feature: LocalizedReleaseText;
  key: string;
  subject: LocalizedReleaseText;
}>;

const calibrationReleaseThemes = Object.freeze([
  { key: "archive-transfer", subject: releaseText("the municipal archive transfer", "передача городского архива"), feature: releaseText("the custody seal", "пломба хранения") },
  { key: "bakery-proofing", subject: releaseText("the bakery proofing cabinet", "расстоечный шкаф пекарни"), feature: releaseText("the humidity cycle", "цикл влажности") },
  { key: "bridge-drainage", subject: releaseText("the bridge drainage gallery", "дренажная галерея моста"), feature: releaseText("the inspection hatch", "смотровой люк") },
  { key: "campus-access", subject: releaseText("the campus access register", "реестр доступа кампуса"), feature: releaseText("the visitor escort rule", "правило сопровождения посетителей") },
  { key: "ceramic-kiln", subject: releaseText("the ceramic kiln schedule", "график керамической печи"), feature: releaseText("the cooling hold", "выдержка охлаждения") },
  { key: "coastal-beacon", subject: releaseText("the coastal beacon log", "журнал берегового маяка"), feature: releaseText("the reserve lantern", "резервный фонарь") },
  { key: "dairy-intake", subject: releaseText("the dairy intake sheet", "лист приёмки молока"), feature: releaseText("the tanker sample", "образец из цистерны") },
  { key: "district-heating", subject: releaseText("the district heating station", "районная тепловая станция"), feature: releaseText("the bypass valve", "обходной клапан") },
  { key: "elevator-service", subject: releaseText("the elevator service card", "карта обслуживания лифта"), feature: releaseText("the door interlock", "блокировка двери") },
  { key: "film-vault", subject: releaseText("the film vault register", "реестр кинохранилища"), feature: releaseText("the canister vent", "вентиляция контейнера") },
  { key: "forest-nursery", subject: releaseText("the forest nursery plan", "план лесного питомника"), feature: releaseText("the seed stratification", "стратификация семян") },
  { key: "freight-scale", subject: releaseText("the freight scale certificate", "сертификат грузовых весов"), feature: releaseText("the zero check", "проверка нуля") },
  { key: "geology-store", subject: releaseText("the geology sample store", "хранилище геологических образцов"), feature: releaseText("the core orientation", "ориентация керна") },
  { key: "hospital-laundry", subject: releaseText("the hospital laundry route", "маршрут больничной прачечной"), feature: releaseText("the clean-side barrier", "барьер чистой зоны") },
  { key: "orchard-frost", subject: releaseText("the orchard frost protocol", "протокол защиты сада от заморозка"), feature: releaseText("the fan start rule", "правило запуска вентилятора") },
  { key: "printing-press", subject: releaseText("the printing press checklist", "контрольный лист печатной машины"), feature: releaseText("the plate lock", "фиксация печатной формы") },
  { key: "reservoir-dam", subject: releaseText("the reservoir dam notebook", "журнал плотины водохранилища"), feature: releaseText("the seepage weir", "водослив фильтрации") },
  { key: "school-kitchen", subject: releaseText("the school kitchen roster", "график школьной кухни"), feature: releaseText("the allergen station", "зона аллергенов") },
  { key: "theatre-rigging", subject: releaseText("the theatre rigging book", "журнал сценической оснастки"), feature: releaseText("the counterweight lock", "замок противовеса") },
  { key: "warehouse-sprinkler", subject: releaseText("the warehouse sprinkler map", "карта спринклеров склада"), feature: releaseText("the isolation tag", "бирка отключения") }
] satisfies readonly CalibrationReleaseTheme[]);

function calibrationReleaseFixtures(): readonly KnowledgeSemanticGroundingFixture[] {
  const combinations = Object.freeze([
    ["supported", "contradicted"],
    ["supported", "unsupported"],
    ["uncertain", "contradicted"],
    ["uncertain", "unsupported"]
  ] as const satisfies readonly (readonly [
    KnowledgeSemanticGroundingDecision,
    KnowledgeSemanticGroundingDecision
  ])[]);
  return Object.freeze(calibrationReleaseThemes.flatMap((theme, themeIndex) =>
    (["en", "ru"] as const).map((language) => {
      const subject = localized(theme.subject, language);
      const feature = localized(theme.feature, language);
      const decisions = combinations[themeIndex % combinations.length]!;
      const claimForDecision = (
        decision: KnowledgeSemanticGroundingDecision,
        suffix: "primary" | "secondary"
      ): GeneratedReleaseClaim => {
        if (decision === "supported") {
          const statement = language === "en"
            ? `${subject} records ${feature} as verified for the ${suffix} check.`
            : `${subject} отмечает, что ${feature} подтверждён для проверки ${suffix === "primary" ? "основной" : "дополнительной"}.`;
          return {
            answer: statement,
            decision,
            evidence: [statement],
            slices: ["direct_entailment", "list_segmentation", "locator_correctness"],
            type: "source_fact"
          };
        }
        if (decision === "contradicted") {
          return {
            answer: language === "en"
              ? `${subject} permits bypassing ${feature} during the ${suffix} check.`
              : `${subject} разрешает обходить ${feature} при проверке ${suffix === "primary" ? "основной" : "дополнительной"}.`,
            decision,
            evidence: [language === "en"
              ? `${subject} prohibits bypassing ${feature} during the ${suffix} check.`
              : `${subject} запрещает обходить ${feature} при проверке ${suffix === "primary" ? "основной" : "дополнительной"}.`],
            slices: ["contradiction", "generic_entailment", "list_segmentation"],
            type: "source_fact"
          };
        }
        if (decision === "unsupported") {
          return {
            answer: language === "en"
              ? `${subject} assigns ${feature} to the Cobalt response tier for the ${suffix} check.`
              : `${subject} относит ${feature} к уровню реагирования Кобальт для проверки ${suffix === "primary" ? "основной" : "дополнительной"}.`,
            decision,
            evidence: [language === "en"
              ? `${subject} records an owner and review date for ${feature}.`
              : `${subject} фиксирует владельца и дату проверки для ${feature}.`],
            slices: ["generic_entailment", "list_segmentation", "locator_correctness"],
            type: "source_fact"
          };
        }
        return {
          ambiguous: true,
          answer: language === "en"
            ? `The damaged ${feature} field in ${subject} may indicate approval for the ${suffix} check.`
            : `Повреждённое поле ${feature} в записи ${subject} может означать согласование проверки ${suffix === "primary" ? "основной" : "дополнительной"}.`,
          decision,
          evidence: [language === "en"
            ? `${subject}; ${feature}; ${suffix}: appr[illegible]`
            : `${subject}; ${feature}; ${suffix}: согл[неразборчиво]`],
          slices: ["generic_entailment", "list_segmentation", "locator_correctness", "uncertainty"],
          type: "source_fact"
        };
      };
      return generatedReleaseFixture({
        category: "calibration-case",
        claims: [
          claimForDecision(decisions[0], "primary"),
          claimForDecision(decisions[1], "secondary")
        ],
        familyKey: theme.key,
        language,
        query: language === "en"
          ? `Calibrate the two ${feature} claims for ${subject}.`
          : `Откалибруй два утверждения ${feature} для ${subject}.`,
        split: "calibration"
      });
    })));
  }

const releaseCalibrationFixtures = calibrationReleaseFixtures();
const releaseHeldOutFixtures = releaseDomainFixtures("held_out", heldOutReleaseThemes);
const releaseBlindedReviewFixtures = releaseDomainFixtures(
  "blinded_review",
  blindedReviewReleaseThemes
);

export const knowledgeSemanticGroundingFixtures = Object.freeze([
  ...developmentFixtures,
  ...calibrationFixtures,
  ...releaseCalibrationFixtures,
  ...heldOutFixtures,
  ...heldOutCoverageFixtures,
  ...releaseHeldOutFixtures,
  ...releaseBlindedReviewFixtures
]);
