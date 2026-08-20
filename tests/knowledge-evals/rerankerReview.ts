import { createHash, randomInt, randomUUID } from "node:crypto";
import { chmod, lstat, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type {
  KnowledgeRerankerCandidatePool,
  KnowledgeRerankerCorpusManifest,
  KnowledgeRerankerDatasetSplit,
  KnowledgeRerankerLanguage
} from "./rerankerCorpusSchema";

export const KNOWLEDGE_RERANKER_REVIEW_VERSION = "knowledge-reranker-review-v1" as const;
export const KNOWLEDGE_RERANKER_REVIEW_PACKET_FILE = "review-packet.json" as const;
export const KNOWLEDGE_RERANKER_REVIEW_MAPPING_FILE = "review-mapping.json" as const;
export const KNOWLEDGE_RERANKER_REVIEWER_A_FILE = "reviewer-a-submission.json" as const;
export const KNOWLEDGE_RERANKER_REVIEWER_B_FILE = "reviewer-b-submission.json" as const;
export const KNOWLEDGE_RERANKER_ADJUDICATION_FILE = "adjudication.json" as const;

const REVIEW_DIRECTORY_PATTERN = /^aiqsa-knowledge-reranker-review-[A-Za-z0-9_-]{6,64}$/u;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const opaqueIdSchema = z.string().uuid();

const humanReviewerSchema = z.strictObject({
  humanAttestation: z.literal("independent_human_review"),
  id: z.string().regex(/^human-reviewer-[A-Za-z0-9_-]{4,64}$/u),
  implementationAgent: z.literal(false),
  provenance: z.literal("external_human")
});

const answerabilitySchema = z.enum(["answerable", "no_answer", "uncertain"]);
const relevanceSchema = z.number().int().min(0).max(3);

const reviewCandidateLabelSchema = z.strictObject({
  relevance: relevanceSchema,
  reviewItemId: opaqueIdSchema
});

const reviewQueryDecisionSchema = z.strictObject({
  answerability: answerabilitySchema,
  candidates: z.array(reviewCandidateLabelSchema).min(1),
  reviewQueryId: opaqueIdSchema
});

export const knowledgeRerankerReviewerSubmissionSchema = z.strictObject({
  artifactType: z.literal("knowledge_reranker_reviewer_submission"),
  artifactVersion: z.literal(KNOWLEDGE_RERANKER_REVIEW_VERSION),
  packetSha256: sha256Schema,
  queries: z.array(reviewQueryDecisionSchema).min(1),
  reviewer: humanReviewerSchema
});

export const knowledgeRerankerAdjudicationSchema = z.strictObject({
  adjudicator: humanReviewerSchema,
  annotatorSubmissionSha256s: z.tuple([sha256Schema, sha256Schema]),
  artifactType: z.literal("knowledge_reranker_adjudication"),
  artifactVersion: z.literal(KNOWLEDGE_RERANKER_REVIEW_VERSION),
  completed: z.literal(true),
  decisions: z.array(reviewQueryDecisionSchema).min(1),
  packetSha256: sha256Schema,
  unresolvedMaterialDisagreements: z.literal(0)
});

const reviewPacketSchema = z.strictObject({
  artifactType: z.literal("knowledge_reranker_blind_packet"),
  artifactVersion: z.literal(KNOWLEDGE_RERANKER_REVIEW_VERSION),
  candidatePoolQualityGateEligible: z.boolean(),
  corpusSha256: sha256Schema,
  instructions: z.strictObject({
    answerability: z.tuple([
      z.literal("answerable: at least one passage directly or substantially answers the query"),
      z.literal("no_answer: none of the passages contains enough evidence to answer"),
      z.literal("uncertain: ambiguity prevents a stable answerability decision")
    ]),
    independence: z.literal("Complete this packet without consulting another annotator or model scores."),
    relevance: z.tuple([
      z.literal("0: irrelevant or misleading for the query"),
      z.literal("1: topically related but does not answer"),
      z.literal("2: partially answers or provides material supporting context"),
      z.literal("3: directly answers the query")
    ])
  }),
  packetSha256: sha256Schema,
  queries: z.array(z.strictObject({
    candidates: z.array(z.strictObject({
      passageText: z.string().min(1),
      reviewItemId: opaqueIdSchema
    })).min(1),
    language: z.enum(["en", "ru"]),
    queryText: z.string().min(1),
    reviewQueryId: opaqueIdSchema
  })).min(1)
});

const reviewMappingSchema = z.strictObject({
  artifactType: z.literal("knowledge_reranker_review_mapping"),
  artifactVersion: z.literal(KNOWLEDGE_RERANKER_REVIEW_VERSION),
  candidatePoolSha256: sha256Schema,
  corpusSha256: sha256Schema,
  entries: z.array(z.strictObject({
    cosineSimilarity: z.number().finite().min(-1).max(1),
    passageId: z.string().regex(/^kr-passage-[0-9]{3}$/u),
    queryId: z.string().regex(/^kr-query-[0-9]{2}$/u),
    retrievalRank: z.number().int().min(1).max(50),
    reviewItemId: opaqueIdSchema,
    reviewQueryId: opaqueIdSchema,
    split: z.enum(["development", "calibration", "held_out", "blinded_review"])
  })).min(1),
  mappingSha256: sha256Schema,
  packetSha256: sha256Schema
});

export type KnowledgeRerankerReviewPacket = z.infer<typeof reviewPacketSchema>;
export type KnowledgeRerankerReviewMapping = z.infer<typeof reviewMappingSchema>;
export type KnowledgeRerankerReviewerSubmission = z.infer<
  typeof knowledgeRerankerReviewerSubmissionSchema
>;
export type KnowledgeRerankerAdjudication = z.infer<
  typeof knowledgeRerankerAdjudicationSchema
>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalSha256(value: unknown): string {
  return sha256(JSON.stringify(value));
}

export function knowledgeRerankerReviewerSubmissionSha256(value: unknown): string {
  return canonicalSha256(knowledgeRerankerReviewerSubmissionSchema.parse(value));
}

function shuffle<T>(values: readonly T[], randomIndex: (maximum: number) => number): T[] {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = randomIndex(index + 1);
    [shuffled[index], shuffled[target]] = [shuffled[target]!, shuffled[index]!];
  }
  return shuffled;
}

export async function validateKnowledgeRerankerReviewDirectory(
  reviewDirectory: string
): Promise<string> {
  if (!reviewDirectory || !isAbsolute(reviewDirectory) ||
    resolve(reviewDirectory) !== reviewDirectory || dirname(reviewDirectory) !== "/tmp" ||
    !REVIEW_DIRECTORY_PATTERN.test(basename(reviewDirectory))) {
    throw new Error("knowledge_reranker_review_directory_invalid");
  }
  let details: Awaited<ReturnType<typeof lstat>>;
  let canonical: string;
  try {
    [details, canonical] = await Promise.all([lstat(reviewDirectory), realpath(reviewDirectory)]);
  } catch {
    throw new Error("knowledge_reranker_review_directory_unavailable");
  }
  const processUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!details.isDirectory() || details.isSymbolicLink() || canonical !== reviewDirectory ||
    (details.mode & 0o777) !== 0o700 || (processUid !== null && details.uid !== processUid)) {
    throw new Error("knowledge_reranker_review_directory_unsafe");
  }
  if ((await readdir(reviewDirectory)).length !== 0) {
    throw new Error("knowledge_reranker_review_directory_not_empty");
  }
  return reviewDirectory;
}

function corpusLookups(corpus: KnowledgeRerankerCorpusManifest): Readonly<{
  passages: Map<string, Readonly<{ text: string }>>;
  queries: Map<string, Readonly<{
    language: KnowledgeRerankerLanguage;
    split: KnowledgeRerankerDatasetSplit;
    text: string;
  }>>;
}> {
  return Object.freeze({
    passages: new Map(corpus.documents.flatMap((document) => document.passages
      .map((passage) => [passage.id, { text: passage.text }] as const))),
    queries: new Map(corpus.queries.map((query) => [query.id, {
      language: query.language,
      split: query.split,
      text: query.text
    }] as const))
  });
}

export function createKnowledgeRerankerReviewArtifacts(input: Readonly<{
  corpus: KnowledgeRerankerCorpusManifest;
  pool: KnowledgeRerankerCandidatePool;
  randomId?: () => string;
  randomIndex?: (maximum: number) => number;
}>): Readonly<{
  mapping: KnowledgeRerankerReviewMapping;
  packet: KnowledgeRerankerReviewPacket;
}> {
  if (input.pool.corpusSha256 !== input.corpus.corpusSha256 ||
    input.pool.queries.length !== input.corpus.queries.length) {
    throw new Error("knowledge_reranker_review_pool_corpus_mismatch");
  }
  const randomId = input.randomId ?? randomUUID;
  const randomIndex = input.randomIndex ?? randomInt;
  const lookups = corpusLookups(input.corpus);
  const mappingEntries: KnowledgeRerankerReviewMapping["entries"][number][] = [];
  const packetQueries = input.pool.queries.map((poolQuery) => {
    const query = lookups.queries.get(poolQuery.queryId);
    if (!query) throw new Error("knowledge_reranker_review_query_missing");
    const reviewQueryId = randomId();
    const candidates = poolQuery.candidates.map((candidate) => {
      const passage = lookups.passages.get(candidate.passageId);
      if (!passage) throw new Error("knowledge_reranker_review_passage_missing");
      const reviewItemId = randomId();
      mappingEntries.push({
        cosineSimilarity: candidate.cosineSimilarity,
        passageId: candidate.passageId,
        queryId: poolQuery.queryId,
        retrievalRank: candidate.rank,
        reviewItemId,
        reviewQueryId,
        split: query.split
      });
      return Object.freeze({ passageText: passage.text, reviewItemId });
    });
    return Object.freeze({
      candidates: Object.freeze(shuffle(candidates, randomIndex)),
      language: query.language,
      queryText: query.text,
      reviewQueryId
    });
  });
  const packetBody = {
    artifactType: "knowledge_reranker_blind_packet" as const,
    artifactVersion: KNOWLEDGE_RERANKER_REVIEW_VERSION,
    candidatePoolQualityGateEligible: input.pool.qualityGateEligible,
    corpusSha256: input.corpus.corpusSha256,
    instructions: {
      answerability: [
        "answerable: at least one passage directly or substantially answers the query",
        "no_answer: none of the passages contains enough evidence to answer",
        "uncertain: ambiguity prevents a stable answerability decision"
      ] as const,
      independence: "Complete this packet without consulting another annotator or model scores." as const,
      relevance: [
        "0: irrelevant or misleading for the query",
        "1: topically related but does not answer",
        "2: partially answers or provides material supporting context",
        "3: directly answers the query"
      ] as const
    },
    queries: Object.freeze(shuffle(packetQueries, randomIndex))
  };
  const packet = reviewPacketSchema.parse({
    ...packetBody,
    packetSha256: canonicalSha256(packetBody)
  });
  const mappingBody = {
    artifactType: "knowledge_reranker_review_mapping" as const,
    artifactVersion: KNOWLEDGE_RERANKER_REVIEW_VERSION,
    candidatePoolSha256: input.pool.poolSha256,
    corpusSha256: input.corpus.corpusSha256,
    entries: mappingEntries,
    packetSha256: packet.packetSha256
  };
  const mapping = reviewMappingSchema.parse({
    ...mappingBody,
    mappingSha256: canonicalSha256(mappingBody)
  });
  return Object.freeze({ mapping, packet });
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  await chmod(path, 0o600);
  const details = await stat(path);
  if (!details.isFile() || (details.mode & 0o777) !== 0o600) {
    throw new Error("knowledge_reranker_review_artifact_permissions_invalid");
  }
}

export async function writeKnowledgeRerankerReviewArtifacts(input: Readonly<{
  corpus: KnowledgeRerankerCorpusManifest;
  pool: KnowledgeRerankerCandidatePool;
  randomId?: () => string;
  randomIndex?: (maximum: number) => number;
  reviewDirectory: string;
}>): Promise<Readonly<{
  mapping: KnowledgeRerankerReviewMapping;
  packet: KnowledgeRerankerReviewPacket;
}>> {
  const reviewDirectory = await validateKnowledgeRerankerReviewDirectory(input.reviewDirectory);
  const artifacts = createKnowledgeRerankerReviewArtifacts(input);
  await writePrivateJson(resolve(reviewDirectory, KNOWLEDGE_RERANKER_REVIEW_PACKET_FILE),
    artifacts.packet);
  await writePrivateJson(resolve(reviewDirectory, KNOWLEDGE_RERANKER_REVIEW_MAPPING_FILE),
    artifacts.mapping);
  return artifacts;
}

const reviewImportFiles = Object.freeze([
  KNOWLEDGE_RERANKER_REVIEW_PACKET_FILE,
  KNOWLEDGE_RERANKER_REVIEW_MAPPING_FILE,
  KNOWLEDGE_RERANKER_REVIEWER_A_FILE,
  KNOWLEDGE_RERANKER_REVIEWER_B_FILE,
  KNOWLEDGE_RERANKER_ADJUDICATION_FILE
]);

async function readPrivateReviewJson(reviewDirectory: string, fileName: string): Promise<unknown> {
  const path = resolve(reviewDirectory, fileName);
  const details = await lstat(path);
  const processUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!details.isFile() || details.isSymbolicLink() || details.size < 2 ||
    details.size > 1024 * 1024 || (details.mode & 0o777) !== 0o600 ||
    processUid !== null && details.uid !== processUid) {
    throw new Error("knowledge_reranker_review_artifact_permissions_invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error("knowledge_reranker_review_artifact_invalid");
  }
  return parsed;
}

/** Imports externally completed review artifacts without projecting their text
 * or labels into the aggregate benchmark report. */
export async function readKnowledgeRerankerReviewEvidenceDirectory(
  reviewDirectory: string
): Promise<KnowledgeRerankerImportedReviewEvidence> {
  if (!reviewDirectory || !isAbsolute(reviewDirectory) ||
    resolve(reviewDirectory) !== reviewDirectory || dirname(reviewDirectory) !== "/tmp" ||
    !REVIEW_DIRECTORY_PATTERN.test(basename(reviewDirectory))) {
    throw new Error("knowledge_reranker_review_directory_invalid");
  }
  const [details, canonical, entries] = await Promise.all([
    lstat(reviewDirectory),
    realpath(reviewDirectory),
    readdir(reviewDirectory)
  ]);
  const processUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!details.isDirectory() || details.isSymbolicLink() || canonical !== reviewDirectory ||
    (details.mode & 0o777) !== 0o700 ||
    processUid !== null && details.uid !== processUid ||
    entries.length !== reviewImportFiles.length ||
    reviewImportFiles.some((fileName) => !entries.includes(fileName))) {
    throw new Error("knowledge_reranker_review_directory_unsafe");
  }
  const [packet, mapping, first, second, adjudication] = await Promise.all(
    reviewImportFiles.map((fileName) => readPrivateReviewJson(reviewDirectory, fileName))
  );
  return importKnowledgeRerankerReviewEvidence({
    adjudication,
    mapping,
    packet,
    submissions: [first, second]
  });
}

function decisionShape(decisions: readonly z.infer<typeof reviewQueryDecisionSchema>[]): Map<
  string,
  z.infer<typeof reviewQueryDecisionSchema>
> {
  return new Map(decisions.map((decision) => [decision.reviewQueryId, decision]));
}

function assertCompleteDecisions(
  decisions: readonly z.infer<typeof reviewQueryDecisionSchema>[],
  mapping: KnowledgeRerankerReviewMapping
): void {
  const expected = new Map<string, Set<string>>();
  for (const entry of mapping.entries) {
    const items = expected.get(entry.reviewQueryId) ?? new Set();
    items.add(entry.reviewItemId);
    expected.set(entry.reviewQueryId, items);
  }
  const actual = decisionShape(decisions);
  if (actual.size !== expected.size) throw new Error("knowledge_reranker_review_incomplete");
  for (const [reviewQueryId, expectedItems] of expected) {
    const decision = actual.get(reviewQueryId);
    if (!decision || decision.candidates.length !== expectedItems.size ||
      new Set(decision.candidates.map((candidate) => candidate.reviewItemId)).size !==
        expectedItems.size ||
      decision.candidates.some((candidate) => !expectedItems.has(candidate.reviewItemId))) {
      throw new Error("knowledge_reranker_review_incomplete");
    }
    const directlyRelevant = decision.candidates.some((candidate) => candidate.relevance >= 2);
    if ((decision.answerability === "answerable" && !directlyRelevant) ||
      (decision.answerability === "no_answer" && directlyRelevant)) {
      throw new Error("knowledge_reranker_review_answerability_inconsistent");
    }
  }
}

export type KnowledgeRerankerImportedReviewEvidence = Readonly<{
  adjudicationComplete: true;
  candidatePoolSha256: string;
  candidatePoolQualityGateEligible: boolean;
  disagreement: Readonly<{
    adjudicatedItemCount: number;
    answerabilityDisagreementCount: number;
    pairLabelDisagreementCount: number;
    rawPairAgreement: number;
  }>;
  independentAnnotatorCount: 2;
  labels: readonly Readonly<{
    answerability: "answerable" | "no_answer" | "uncertain";
    language: KnowledgeRerankerLanguage;
    relevance: readonly Readonly<{ passageId: string; relevance: number }>[];
    queryId: string;
    split: KnowledgeRerankerDatasetSplit;
  }>[];
  mappingSha256: string;
  packetSha256: string;
  unresolvedMaterialDisagreements: 0;
}>;

export function importKnowledgeRerankerReviewEvidence(input: Readonly<{
  adjudication: unknown;
  mapping: unknown;
  packet: unknown;
  submissions: readonly [unknown, unknown];
}>): KnowledgeRerankerImportedReviewEvidence {
  const packet = reviewPacketSchema.parse(input.packet);
  const mapping = reviewMappingSchema.parse(input.mapping);
  const submissions = input.submissions.map((submission) =>
    knowledgeRerankerReviewerSubmissionSchema.parse(submission)) as [
      KnowledgeRerankerReviewerSubmission,
      KnowledgeRerankerReviewerSubmission
    ];
  const adjudication = knowledgeRerankerAdjudicationSchema.parse(input.adjudication);
  const { packetSha256, ...packetBody } = packet;
  const { mappingSha256, ...mappingBody } = mapping;
  if (canonicalSha256(packetBody) !== packetSha256 ||
    canonicalSha256(mappingBody) !== mappingSha256) {
    throw new Error("knowledge_reranker_review_artifact_digest_invalid");
  }
  if (mapping.packetSha256 !== packet.packetSha256 ||
    mapping.corpusSha256 !== packet.corpusSha256 ||
    submissions.some((submission) => submission.packetSha256 !== packet.packetSha256) ||
    adjudication.packetSha256 !== packet.packetSha256) {
    throw new Error("knowledge_reranker_review_binding_invalid");
  }
  if (submissions[0].reviewer.id === submissions[1].reviewer.id) {
    throw new Error("knowledge_reranker_review_annotators_not_distinct");
  }
  submissions.forEach((submission) => assertCompleteDecisions(submission.queries, mapping));
  assertCompleteDecisions(adjudication.decisions, mapping);
  const submissionHashes = submissions.map(knowledgeRerankerReviewerSubmissionSha256).sort();
  if (JSON.stringify([...adjudication.annotatorSubmissionSha256s].sort()) !==
    JSON.stringify(submissionHashes)) {
    throw new Error("knowledge_reranker_review_adjudication_sources_invalid");
  }
  const decisions = submissions.map((submission) => decisionShape(submission.queries));
  const adjudicated = decisionShape(adjudication.decisions);
  let answerabilityDisagreementCount = 0;
  let pairLabelDisagreementCount = 0;
  let pairCount = 0;
  for (const [queryId, left] of decisions[0]) {
    const right = decisions[1].get(queryId)!;
    if (left.answerability !== right.answerability) answerabilityDisagreementCount += 1;
    const rightLabels = new Map(right.candidates.map((candidate) =>
      [candidate.reviewItemId, candidate.relevance]));
    for (const candidate of left.candidates) {
      pairCount += 1;
      if (rightLabels.get(candidate.reviewItemId) !== candidate.relevance) {
        pairLabelDisagreementCount += 1;
      }
    }
  }
  const entriesByReviewQuery = new Map<string, KnowledgeRerankerReviewMapping["entries"]>();
  for (const entry of mapping.entries) {
    const entries = entriesByReviewQuery.get(entry.reviewQueryId) ?? [];
    entries.push(entry);
    entriesByReviewQuery.set(entry.reviewQueryId, entries);
  }
  const packetQueryById = new Map(packet.queries.map((query) =>
    [query.reviewQueryId, query]));
  const labels = [...adjudicated.entries()].map(([reviewQueryId, decision]) => {
    const entries = entriesByReviewQuery.get(reviewQueryId);
    const packetQuery = packetQueryById.get(reviewQueryId);
    if (!entries || !packetQuery) throw new Error("knowledge_reranker_review_mapping_invalid");
    const byItem = new Map(entries.map((entry) => [entry.reviewItemId, entry]));
    const canonical = entries[0]!;
    return Object.freeze({
      answerability: decision.answerability,
      language: packetQuery.language,
      queryId: canonical.queryId,
      relevance: Object.freeze(decision.candidates.map((candidate) => Object.freeze({
        passageId: byItem.get(candidate.reviewItemId)!.passageId,
        relevance: candidate.relevance
      }))),
      split: canonical.split
    });
  });
  return Object.freeze({
    adjudicationComplete: true,
    candidatePoolSha256: mapping.candidatePoolSha256,
    candidatePoolQualityGateEligible: packet.candidatePoolQualityGateEligible,
    disagreement: Object.freeze({
      adjudicatedItemCount: pairCount,
      answerabilityDisagreementCount,
      pairLabelDisagreementCount,
      rawPairAgreement: pairCount === 0 ? 0 : (pairCount - pairLabelDisagreementCount) / pairCount
    }),
    independentAnnotatorCount: 2,
    labels: Object.freeze(labels),
    mappingSha256: mapping.mappingSha256,
    packetSha256: packet.packetSha256,
    unresolvedMaterialDisagreements: 0
  });
}
