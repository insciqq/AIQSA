import { createHash } from "node:crypto";

export const OPEN_RAG_DATASET_ID = "vectara/open_ragbench";
export const OPEN_RAG_UPSTREAM_REVISION =
  "63f6b052ff83508b08e242db42263ee708815c26";
export const OPEN_RAG_SLICE_SCHEMA_VERSION = 1;
export const OPEN_RAG_SLICE_SEED = "aiqsa-open-rag-pdf-diagnostic-v1";
export const OPEN_RAG_MAX_PDF_BYTES = 50_000_000;

export const OPEN_RAG_METADATA_FILES = Object.freeze({
  "answers.json": Object.freeze({
    bytes: 653_040,
    sha256: "2ab51b9e773ed10259043ad869789aa1621af601591da73d34db3551a2d662bd"
  }),
  "pdf_urls.json": Object.freeze({
    bytes: 54_002,
    sha256: "e67b8246918ef1e92250b9c0b58cd830a58d68f9bc288dda01db53cdbc8d4298"
  }),
  "qrels.json": Object.freeze({
    bytes: 302_689,
    sha256: "c2ad02c5461402e643cb363e7ae562b7bba4a3f5a4e7a5149707365c82848580"
  }),
  "queries.json": Object.freeze({
    bytes: 602_835,
    sha256: "13822fc7efd6889eaf20a6809adfff1cf040699ec2254131a897850b922cac6f"
  })
});

export const OPEN_RAG_STRATUM_POLICY = Object.freeze([
  Object.freeze({
    documentCount: 4,
    questionCount: 7,
    source: "text-table",
    type: "extractive"
  }),
  Object.freeze({
    documentCount: 5,
    questionCount: 11,
    source: "text-table-image",
    type: "extractive"
  }),
  Object.freeze({
    documentCount: 4,
    questionCount: 12,
    source: "text-image",
    type: "extractive"
  }),
  Object.freeze({
    documentCount: 4,
    questionCount: 8,
    source: "text-table",
    type: "abstractive"
  }),
  Object.freeze({
    documentCount: 4,
    questionCount: 9,
    source: "text-table-image",
    type: "abstractive"
  }),
  Object.freeze({
    documentCount: 5,
    questionCount: 13,
    source: "text-image",
    type: "abstractive"
  }),
  Object.freeze({
    documentCount: 7,
    questionCount: 20,
    source: "text",
    type: "extractive"
  }),
  Object.freeze({
    documentCount: 7,
    questionCount: 20,
    source: "text",
    type: "abstractive"
  })
] as const);

export type OpenRagQuestionType = "abstractive" | "extractive";
export type OpenRagQuestionSource =
  | "text"
  | "text-image"
  | "text-table"
  | "text-table-image";

export type OpenRagQuestion = Readonly<{
  answer: string;
  docId: string;
  id: string;
  question: string;
  sectionId: number;
  source: OpenRagQuestionSource;
  type: OpenRagQuestionType;
}>;

export type OpenRagMetadata = Readonly<{
  pdfUrls: Readonly<Record<string, string>>;
  questions: readonly OpenRagQuestion[];
}>;

export type OpenRagSliceDocument = Readonly<{
  fileName: string;
  id: string;
  role: "negative" | "positive";
  selectionStratum: string | null;
  url: string;
}>;

export type OpenRagSliceManifest = Readonly<{
  createdBy: "deterministic";
  datasetId: typeof OPEN_RAG_DATASET_ID;
  documents: readonly OpenRagSliceDocument[];
  maxQuestionsPerPositiveDocument: 3;
  metadata: typeof OPEN_RAG_METADATA_FILES;
  questions: readonly OpenRagQuestion[];
  revision: typeof OPEN_RAG_UPSTREAM_REVISION;
  schemaVersion: typeof OPEN_RAG_SLICE_SCHEMA_VERSION;
  seed: typeof OPEN_RAG_SLICE_SEED;
  selectionFingerprint: string;
  stratumPolicy: typeof OPEN_RAG_STRATUM_POLICY;
}>;

export type OpenRagRunnerBundle = Readonly<{
  aliases: Readonly<Record<string, Readonly<{
    documentId: string;
    role: "negative" | "positive";
  }>>>;
  questions: Readonly<{
    documents: Readonly<Record<string, Readonly<{
      cases: readonly Readonly<{
        caseId: string;
        evaluationMode: "open_rag_reference_answer";
        goldSectionId: number;
        kind: "fact" | "table";
        question: string;
        referenceAnswer: string;
        source: OpenRagQuestionSource;
        support: string;
        type: OpenRagQuestionType;
      }>[];
      txtSha256: string;
    }>>>;
    questionPackage: "open-rag-v1";
    version: 2;
  }>;
  sidecars: Readonly<Record<string, string>>;
}>;

const questionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/u;
const documentIdPattern = /^[0-9]{4}\.[0-9]{5}v[0-9]+$/u;
const allowedTypes = new Set<OpenRagQuestionType>([
  "abstractive",
  "extractive"
]);
const allowedSources = new Set<OpenRagQuestionSource>([
  "text",
  "text-image",
  "text-table",
  "text-table-image"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, code: string): string {
  if (typeof value !== "string" || value.trim().length === 0 ||
    value.includes("\u0000") || Buffer.byteLength(value, "utf8") > 64 * 1024) {
    throw new Error(code);
  }
  return value;
}

function sortedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort((left, right) => left.localeCompare(right));
}

function equalKeys(left: string[], right: string[]): boolean {
  return left.length === right.length &&
    left.every((entry, index) => entry === right[index]);
}

function decodePdfUrl(docId: string, value: unknown): string {
  if (!documentIdPattern.test(docId) || typeof value !== "string") {
    throw new Error("open_rag_pdf_url_invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("open_rag_pdf_url_invalid");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "arxiv.org" ||
    parsed.username || parsed.password || parsed.search || parsed.hash ||
    parsed.pathname !== `/pdf/${docId}`) {
    throw new Error("open_rag_pdf_url_invalid");
  }
  return parsed.toString();
}

export function decodeOpenRagMetadata(input: Readonly<{
  answers: unknown;
  pdfUrls: unknown;
  qrels: unknown;
  queries: unknown;
}>): OpenRagMetadata {
  if (!isRecord(input.answers) || !isRecord(input.pdfUrls) ||
    !isRecord(input.qrels) || !isRecord(input.queries)) {
    throw new Error("open_rag_metadata_invalid");
  }

  const queryIds = sortedKeys(input.queries);
  if (queryIds.length === 0 ||
    !equalKeys(queryIds, sortedKeys(input.answers)) ||
    !equalKeys(queryIds, sortedKeys(input.qrels))) {
    throw new Error("open_rag_metadata_key_set_invalid");
  }

  const pdfUrls = Object.fromEntries(sortedKeys(input.pdfUrls).map((docId) => [
    docId,
    decodePdfUrl(docId, input.pdfUrls[docId])
  ]));

  const questions = queryIds.map((id): OpenRagQuestion => {
    if (!questionIdPattern.test(id)) throw new Error("open_rag_query_id_invalid");
    const rawQuery = input.queries[id];
    const rawQrel = input.qrels[id];
    if (!isRecord(rawQuery) || !isRecord(rawQrel)) {
      throw new Error("open_rag_query_row_invalid");
    }
    const type = rawQuery.type;
    const source = rawQuery.source;
    const docId = rawQrel.doc_id;
    const sectionId = rawQrel.section_id;
    if (typeof type !== "string" || !allowedTypes.has(type as OpenRagQuestionType) ||
      typeof source !== "string" ||
      !allowedSources.has(source as OpenRagQuestionSource) ||
      typeof docId !== "string" || !documentIdPattern.test(docId) ||
      !Object.hasOwn(pdfUrls, docId) || !Number.isSafeInteger(sectionId) ||
      Number(sectionId) < 0) {
      throw new Error("open_rag_query_row_invalid");
    }
    return Object.freeze({
      answer: boundedText(input.answers[id], "open_rag_answer_invalid"),
      docId,
      id,
      question: boundedText(rawQuery.query, "open_rag_question_invalid"),
      sectionId: Number(sectionId),
      source: source as OpenRagQuestionSource,
      type: type as OpenRagQuestionType
    });
  });

  return Object.freeze({
    pdfUrls: Object.freeze(pdfUrls),
    questions: Object.freeze(questions)
  });
}

function stableHash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex");
}

function stratumKey(
  source: OpenRagQuestionSource,
  type: OpenRagQuestionType
): string {
  return `${source}/${type}`;
}

function compareHash(seed: string, namespace: string, left: string, right: string): number {
  const leftHash = stableHash(seed, namespace, left);
  const rightHash = stableHash(seed, namespace, right);
  return leftHash < rightHash ? -1 : leftHash > rightHash ? 1 :
    left.localeCompare(right);
}

function sliceFingerprint(input: Omit<OpenRagSliceManifest, "selectionFingerprint">): string {
  return createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
}

export function selectOpenRagSlice(metadata: OpenRagMetadata): OpenRagSliceManifest {
  const usedDocuments = new Set<string>();
  const selectedQuestions: OpenRagQuestion[] = [];
  const positiveDocuments: OpenRagSliceDocument[] = [];

  for (const policy of OPEN_RAG_STRATUM_POLICY) {
    const key = stratumKey(policy.source, policy.type);
    const byDocument = new Map<string, OpenRagQuestion[]>();
    for (const question of metadata.questions) {
      if (question.source !== policy.source || question.type !== policy.type ||
        usedDocuments.has(question.docId)) continue;
      const rows = byDocument.get(question.docId) ?? [];
      rows.push(question);
      byDocument.set(question.docId, rows);
    }
    const candidates = [...byDocument.entries()].map(([docId, questions]) => ({
      capacity: Math.min(3, questions.length),
      docId,
      questions: [...questions].sort((left, right) =>
        compareHash(OPEN_RAG_SLICE_SEED, `${key}/question`, left.id, right.id))
    })).sort((left, right) => right.capacity - left.capacity ||
      compareHash(OPEN_RAG_SLICE_SEED, `${key}/document`, left.docId, right.docId));
    const chosen = candidates.slice(0, policy.documentCount);
    if (chosen.length !== policy.documentCount ||
      chosen.reduce((sum, entry) => sum + entry.capacity, 0) < policy.questionCount) {
      throw new Error(`open_rag_slice_stratum_capacity_invalid:${key}`);
    }

    const stratumQuestions: OpenRagQuestion[] = [];
    const nextIndex = new Map<string, number>();
    for (const entry of chosen) {
      stratumQuestions.push(entry.questions[0]!);
      nextIndex.set(entry.docId, 1);
      usedDocuments.add(entry.docId);
      positiveDocuments.push(Object.freeze({
        fileName: `${entry.docId}.pdf`,
        id: entry.docId,
        role: "positive",
        selectionStratum: key,
        url: metadata.pdfUrls[entry.docId]!
      }));
    }

    const allocationOrder = [...chosen].sort((left, right) =>
      compareHash(OPEN_RAG_SLICE_SEED, `${key}/allocation`, left.docId, right.docId));
    while (stratumQuestions.length < policy.questionCount) {
      let progressed = false;
      for (const entry of allocationOrder) {
        if (stratumQuestions.length >= policy.questionCount) break;
        const index = nextIndex.get(entry.docId) ?? 0;
        if (index >= entry.capacity) continue;
        stratumQuestions.push(entry.questions[index]!);
        nextIndex.set(entry.docId, index + 1);
        progressed = true;
      }
      if (!progressed) {
        throw new Error(`open_rag_slice_question_capacity_invalid:${key}`);
      }
    }
    selectedQuestions.push(...stratumQuestions);
  }

  const allPositiveIds = new Set(metadata.questions.map(({ docId }) => docId));
  const negativeIds = Object.keys(metadata.pdfUrls)
    .filter((docId) => !allPositiveIds.has(docId))
    .sort((left, right) =>
      compareHash(OPEN_RAG_SLICE_SEED, "negative/document", left, right))
    .slice(0, 60);
  if (negativeIds.length !== 60) throw new Error("open_rag_slice_negative_capacity_invalid");
  const negativeDocuments = negativeIds.map((id): OpenRagSliceDocument =>
    Object.freeze({
      fileName: `${id}.pdf`,
      id,
      role: "negative",
      selectionStratum: null,
      url: metadata.pdfUrls[id]!
    }));

  const documents = [...positiveDocuments, ...negativeDocuments]
    .sort((left, right) => left.id.localeCompare(right.id));
  const questions = [...selectedQuestions]
    .sort((left, right) => left.id.localeCompare(right.id));
  if (documents.length !== 100 || positiveDocuments.length !== 40 ||
    questions.length !== 100 || new Set(questions.map(({ id }) => id)).size !== 100 ||
    questions.some(({ docId }) => !usedDocuments.has(docId))) {
    throw new Error("open_rag_slice_invariant_invalid");
  }

  const withoutFingerprint = Object.freeze({
    createdBy: "deterministic" as const,
    datasetId: OPEN_RAG_DATASET_ID,
    documents: Object.freeze(documents),
    maxQuestionsPerPositiveDocument: 3 as const,
    metadata: OPEN_RAG_METADATA_FILES,
    questions: Object.freeze(questions),
    revision: OPEN_RAG_UPSTREAM_REVISION,
    schemaVersion: OPEN_RAG_SLICE_SCHEMA_VERSION,
    seed: OPEN_RAG_SLICE_SEED,
    stratumPolicy: OPEN_RAG_STRATUM_POLICY
  });
  return Object.freeze({
    ...withoutFingerprint,
    selectionFingerprint: sliceFingerprint(withoutFingerprint)
  });
}

export function assertOpenRagPdfShape(header: Uint8Array, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 5 || bytes > OPEN_RAG_MAX_PDF_BYTES ||
    header.length < 5 || Buffer.from(header.subarray(0, 5)).toString("ascii") !== "%PDF-") {
    throw new Error("open_rag_pdf_invalid");
  }
}

function evaluatorSidecar(
  document: OpenRagSliceDocument,
  questions: readonly OpenRagQuestion[]
): string {
  if (document.role === "negative") {
    return "Open RAG evaluator-only hard-negative marker.\n";
  }
  return [
    "Open RAG evaluator-only references; this file is never uploaded to AIQSA.",
    ...questions.flatMap((question) => [
      "",
      `Question ${question.id}`,
      question.question,
      "Reference answer",
      question.answer
    ]),
    ""
  ].join("\n");
}

export function buildOpenRagRunnerBundle(
  manifest: OpenRagSliceManifest
): OpenRagRunnerBundle {
  const documents = [...manifest.documents]
    .sort((left, right) => left.id.localeCompare(right.id));
  const aliases: Record<string, Readonly<{
    documentId: string;
    role: "negative" | "positive";
  }>> = {};
  const questionDocuments: Record<string, Readonly<{
    cases: readonly Readonly<{
      caseId: string;
      evaluationMode: "open_rag_reference_answer";
      goldSectionId: number;
      kind: "fact" | "table";
      question: string;
      referenceAnswer: string;
      source: OpenRagQuestionSource;
      support: string;
      type: OpenRagQuestionType;
    }>[];
    txtSha256: string;
  }>> = {};
  const sidecars: Record<string, string> = {};

  for (const [index, document] of documents.entries()) {
    const alias = `doc-${String(index + 1).padStart(3, "0")}`;
    aliases[alias] = Object.freeze({
      documentId: document.id,
      role: document.role
    });
    const questions = manifest.questions
      .filter(({ docId }) => docId === document.id)
      .sort((left, right) => left.id.localeCompare(right.id));
    const sidecar = evaluatorSidecar(document, questions);
    sidecars[document.id] = sidecar;
    if (questions.length === 0) continue;
    questionDocuments[alias] = Object.freeze({
      cases: Object.freeze(questions.map((question, caseIndex) => Object.freeze({
        caseId: `${alias}-q${caseIndex + 1}`,
        evaluationMode: "open_rag_reference_answer" as const,
        goldSectionId: question.sectionId,
        kind: question.source.includes("table") ? "table" as const : "fact" as const,
        question: question.question,
        referenceAnswer: question.answer,
        source: question.source,
        // The public dataset supplies a reference answer and a section qrel,
        // not a human-authored verbatim evidence span. Keep this evaluator-only
        // field schema-compatible without pretending it is source evidence.
        support: question.answer,
        type: question.type
      }))),
      txtSha256: createHash("sha256").update(sidecar, "utf8").digest("hex")
    });
  }

  if (Object.keys(aliases).length !== 100 ||
    Object.values(questionDocuments).reduce((sum, entry) => sum + entry.cases.length, 0) !==
      100) {
    throw new Error("open_rag_runner_bundle_invariant_invalid");
  }
  return Object.freeze({
    aliases: Object.freeze(aliases),
    questions: Object.freeze({
      documents: Object.freeze(questionDocuments),
      questionPackage: "open-rag-v1" as const,
      version: 2 as const
    }),
    sidecars: Object.freeze(sidecars)
  });
}
