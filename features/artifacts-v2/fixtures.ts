import type {
  GeneratedArtifactLifecycleEvent,
  GeneratedArtifactProjection,
  GeneratedArtifactVersion
} from "./contracts";

export type ArtifactsFixtureState =
  | "cancelled"
  | "default"
  | "drawer"
  | "failed"
  | "generating"
  | "preview-unavailable"
  | "stack";

const readyEvents: readonly GeneratedArtifactLifecycleEvent[] = [
  { kind: "generated_file_detected", state: "complete" },
  { kind: "generated_file_validating", state: "complete" },
  { kind: "generated_file_rendering", state: "complete" },
  { kind: "generated_file_ready", state: "complete" }
];

const reportV1: GeneratedArtifactVersion = {
  branchLabel: "Original answer",
  byteSize: 188_416,
  createdAtLabel: "Aug 13, 14:02",
  downloadAvailable: true,
  format: "xlsx",
  id: "artifact-version-private-report-v1",
  number: 1,
  parentVersionNumber: null,
  preview: {
    content: {
      activeTab: "Сводная",
      kind: "table",
      tabs: [{
        columns: ["Период", "Выручка", "Маржа", "Δ"],
        label: "Сводная",
        rows: [
          ["Q1", "₽12.4M", "31%", "+4%"],
          ["Q2", "₽13.1M", "30%", "+6%"],
          ["Q3", "₽14.8M", "33%", "+13%"]
        ]
      }, {
        columns: ["Канал", "Q3", "Доля"],
        label: "Продажи",
        rows: [["Прямые", "₽8.9M", "60%"], ["Партнёры", "₽5.9M", "40%"]]
      }, {
        columns: ["Категория", "Q3"],
        label: "Расходы",
        rows: [["Операционные", "₽4.1M"], ["Маркетинг", "₽1.2M"]]
      }]
    },
    status: "ready"
  },
  sourceMessageId: "message-private-report-v1",
  sourceMessageLabel: "Answer “Соберу квартальную книгу”",
  structuralSummary: "3 sheets",
  useInNextMessageAvailable: true
};

const reportV2: GeneratedArtifactVersion = {
  branchLabel: "Edited question",
  byteSize: 219_136,
  createdAtLabel: "Aug 13, 14:32",
  downloadAvailable: true,
  format: "xlsx",
  id: "artifact-version-private-report-v2",
  number: 2,
  parentVersionNumber: 1,
  preview: {
    content: {
      activeTab: "Сводная",
      kind: "table",
      tabs: [{
        columns: ["Период", "Выручка", "Маржа", "Δ"],
        label: "Сводная",
        rows: [
          ["Q1", "₽12.4M", "31%", "+4%"],
          ["Q2", "₽13.1M", "30%", "+6%"],
          ["Q3", "₽15.2M", "34%", "+16%"],
          ["Прогноз Q4", "₽16.0M", "35%", "+5%"]
        ]
      }, {
        columns: ["Канал", "Q3", "Доля"],
        label: "Продажи",
        rows: [["Прямые", "₽9.3M", "61%"], ["Партнёры", "₽5.9M", "39%"]]
      }, {
        columns: ["Категория", "Q3"],
        label: "Расходы",
        rows: [["Операционные", "₽4.0M"], ["Маркетинг", "₽1.1M"]]
      }]
    },
    status: "ready"
  },
  sourceMessageId: "message-private-report-v2",
  sourceMessageLabel: "Answer “Добавил прогноз и проверку формул”",
  structuralSummary: "3 sheets · formulas verified",
  useInNextMessageAvailable: true
};

const deckV1: GeneratedArtifactVersion = {
  branchLabel: "Active branch",
  byteSize: 1_887_437,
  createdAtLabel: "Aug 13, 14:35",
  downloadAvailable: true,
  format: "pptx",
  id: "artifact-version-private-deck-v1",
  number: 1,
  parentVersionNumber: null,
  preview: {
    content: {
      activePage: 1,
      kind: "slides",
      lines: ["Рост выручки", "Ключевые драйверы Q3", "Прогноз Q4"],
      pageCount: 10,
      title: "Итоги третьего квартала"
    },
    status: "ready"
  },
  sourceMessageId: "message-private-deck-v1",
  sourceMessageLabel: "Answer “Подготовил презентацию”",
  structuralSummary: "10 slides",
  useInNextMessageAvailable: true
};

const previewUnavailableV1: GeneratedArtifactVersion = {
  branchLabel: "Active branch",
  byteSize: 98_304,
  createdAtLabel: "Aug 13, 14:40",
  downloadAvailable: true,
  format: "xlsx",
  id: "artifact-version-private-preview-unavailable-v1",
  number: 1,
  parentVersionNumber: null,
  preview: {
    reason: "The renderer does not support displaying this file.",
    status: "failed"
  },
  sourceMessageId: "message-private-preview-unavailable-v1",
  sourceMessageLabel: "Answer “Проверил исходную книгу”",
  structuralSummary: "File ready",
  useInNextMessageAvailable: true
};

export const readyReportArtifact = {
  boundVersionId: reportV2.id,
  events: readyEvents,
  format: "xlsx",
  id: "artifact-private-report",
  logicalFileId: "logical-file-private-report",
  name: "report_q3.xlsx",
  status: "ready",
  versions: [reportV1, reportV2]
} satisfies GeneratedArtifactProjection;

export const readyDeckArtifact = {
  boundVersionId: deckV1.id,
  events: readyEvents,
  format: "pptx",
  id: "artifact-private-deck",
  logicalFileId: "logical-file-private-deck",
  name: "deck_q3.pptx",
  status: "ready",
  versions: [deckV1]
} satisfies GeneratedArtifactProjection;

const generatingArtifact: GeneratedArtifactProjection = {
  boundVersionId: null,
  events: [
    { kind: "generated_file_detected", state: "complete" },
    { kind: "generated_file_validating", state: "active" },
    { kind: "generated_file_rendering", state: "pending" }
  ],
  format: "xlsx",
  id: "artifact-private-generating",
  logicalFileId: "logical-file-private-generating",
  name: "report_q3.xlsx",
  status: "generating",
  versions: []
};

const failedArtifact: GeneratedArtifactProjection = {
  boundVersionId: null,
  events: [
    { kind: "generated_file_detected", state: "complete" },
    { kind: "generated_file_validating", state: "failed" },
    { kind: "generated_file_failed", state: "complete" }
  ],
  format: "xlsx",
  id: "artifact-private-failed",
  logicalFileId: "logical-file-private-failed",
  name: "report_q3.xlsx",
  status: "failed",
  validationFailure: "Validation failed: broken reference to sheet “Сводная”.",
  versions: []
};

const cancelledArtifact: GeneratedArtifactProjection = {
  boundVersionId: null,
  events: [
    { kind: "generated_file_detected", state: "complete" },
    { kind: "generated_file_validating", state: "pending" }
  ],
  format: "docx",
  id: "artifact-private-cancelled",
  logicalFileId: "logical-file-private-cancelled",
  name: "memo_q3.docx",
  status: "cancelled",
  versions: []
};

const previewUnavailableArtifact: GeneratedArtifactProjection = {
  boundVersionId: previewUnavailableV1.id,
  events: readyEvents,
  format: "xlsx",
  id: "artifact-private-preview-unavailable",
  logicalFileId: "logical-file-private-preview-unavailable",
  name: "unsupported-preview.xlsx",
  status: "ready",
  versions: [previewUnavailableV1]
};

export function artifactFixturesForState(
  state: ArtifactsFixtureState
): readonly GeneratedArtifactProjection[] {
  if (state === "generating") return [generatingArtifact];
  if (state === "failed") return [failedArtifact];
  if (state === "cancelled") return [cancelledArtifact];
  if (state === "preview-unavailable") return [previewUnavailableArtifact];
  if (state === "stack") return [readyReportArtifact, readyDeckArtifact];
  return [readyReportArtifact];
}
