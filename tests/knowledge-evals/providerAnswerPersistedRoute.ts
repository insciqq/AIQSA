import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  readFile,
  readdir,
  realpath,
  writeFile
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Prisma, type PrismaClient } from "@prisma/client";
import { textMessageContent } from "../../lib/domain/content";
import type { KnowledgeCitationViewer } from "../../lib/contracts/knowledgeCitations";
import { finalizeParsedDocument } from "../../lib/server/parsing/assessment";
import type { ParsedBoundingBox } from "../../lib/server/parsing/types";
import {
  resolveKnowledgeCitationViewer
} from "../../lib/server/knowledge/citationViewer";
import {
  groundKnowledgeRunAnswer,
  loadKnowledgeEvidencePackage,
  settleKnowledgeGrounding
} from "../../lib/server/knowledge/evidenceRepository";
import {
  knowledgeEvidenceReceiptHash,
  type KnowledgeEvidencePackage
} from "../../lib/server/knowledge/evidencePackage";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "../../lib/server/knowledge/knowledgeBudget";
import { getKnowledgeExtractionConfig } from
  "../../lib/server/knowledge/knowledgeExtractionConfig";
import {
  knowledgeProfileConfiguration,
  knowledgeProfileEgressPolicy
} from "../../lib/server/knowledge/knowledgeProfile";
import { encodeKnowledgeNormalizedDocument } from
  "../../lib/server/knowledge/normalizedDocument";
import { createPrismaKnowledgeRetrievalStore } from
  "../../lib/server/knowledge/prismaRetrievalRepository";
import {
  KNOWLEDGE_RESULT_VERSION,
  type KnowledgeRetrievalEvidence,
  type KnowledgeRetrievedPassageEvidence
} from "../../lib/server/knowledge/retrievalTypes";
import { knowledgeToolResultText } from "../../lib/server/knowledge/toolResult";
import type { StorageAdapter } from "../../lib/server/uploads/storage";
import { assertDisposableStatefulTestTarget } from "../../scripts/stateful-test-target";
import {
  KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT,
  KNOWLEDGE_PROVIDER_ANSWER_MAPPING_FILE,
  KNOWLEDGE_PROVIDER_ANSWER_OUTPUT_FREEZE_FILE,
  KNOWLEDGE_PROVIDER_ANSWER_PACKET_FILE,
  KNOWLEDGE_PROVIDER_ANSWER_REVIEW_DIRECTORY_PREFIX,
  assertProviderAnswerReviewArtifactChain,
  createPersistedProviderAnswerReviewArtifacts,
  providerAnswerEvalCases,
  providerAnswerEvalProfiles,
  validateProviderAnswerReviewDirectory,
  writeProviderAnswerReviewArtifacts,
  type ProviderAnswerCitationViewerArtifact,
  type ProviderAnswerEvalCase,
  type ProviderAnswerEvalProfile,
  type ProviderAnswerOutputFreeze,
  type ProviderAnswerReviewMapping,
  type ProviderAnswerReviewPacket
} from "./providerAnswerEval";

export const KNOWLEDGE_PROVIDER_ANSWER_PERSISTED_ROUTE_VERSION =
  "knowledge-provider-answer-persisted-route-v1" as const;
export const KNOWLEDGE_PROVIDER_ANSWER_PERSISTED_ROUTE_RECEIPT_FILE =
  "persisted-route-receipt.json";
export const KNOWLEDGE_PROVIDER_ANSWER_PERSISTED_ROUTE_DIRECTORY_PREFIX =
  "aiqsa-knowledge-provider-persisted-route-";

const PRIVATE_ARTIFACT_MAX_BYTES = 8 * 1_024 * 1_024;
const REVIEW_DIRECTORY_PATTERN = new RegExp(
  `^${KNOWLEDGE_PROVIDER_ANSWER_REVIEW_DIRECTORY_PREFIX}[A-Za-z0-9_-]{6,64}$`,
  "u"
);
const PERSISTED_ROUTE_DIRECTORY_PATTERN = new RegExp(
  `^${KNOWLEDGE_PROVIDER_ANSWER_PERSISTED_ROUTE_DIRECTORY_PREFIX}[A-Za-z0-9_-]{6,64}$`,
  "u"
);
const VECTOR_SPACE_FINGERPRINT = "7".repeat(64);
const PERSISTED_ROUTE_PROFILE = Object.freeze({
  connectionId: "knowledge-provider-answer-persisted-route-connection-v1",
  credentialId: "knowledge-provider-answer-persisted-route-credential-v1",
  credentialVersionId: "knowledge-provider-answer-persisted-route-credential-version-v1",
  modelId: "knowledge-provider-answer-persisted-route-model-v1",
  profileId: "knowledge-provider-answer-persisted-route-profile-v1",
  profileRevisionId: "knowledge-provider-answer-persisted-route-profile-revision-v1"
});
const SOURCE_FILE_PATTERN = /^review-source-[1-8]\.(?:csv|html?|markdown|md|txt)$/u;
const EVALUATION_VECTOR_LITERAL = `[1,${Array<string>(1_023).fill("0").join(",")}]`;

export type ProviderAnswerArtifactChain = Readonly<{
  freeze: ProviderAnswerOutputFreeze;
  mapping: ProviderAnswerReviewMapping;
  packet: ProviderAnswerReviewPacket;
}>;

type SelectedProvider = ProviderAnswerEvalProfile["provider"];

export type ProviderAnswerPersistedRouteErrorCode =
  | "knowledge_provider_answer_persisted_route_argument_invalid"
  | "knowledge_provider_answer_persisted_route_artifact_invalid"
  | "knowledge_provider_answer_persisted_route_capture_failed"
  | "knowledge_provider_answer_persisted_route_cleanup_failed"
  | "knowledge_provider_answer_persisted_route_database_unsafe"
  | "knowledge_provider_answer_persisted_route_directory_invalid"
  | "knowledge_provider_answer_persisted_route_directory_unsafe"
  | "knowledge_provider_answer_persisted_route_digest_failed"
  | "knowledge_provider_answer_persisted_route_incomplete_provider"
  | "knowledge_provider_answer_persisted_route_persistence_failed"
  | "knowledge_provider_answer_persisted_route_receipt_invalid"
  | "knowledge_provider_answer_persisted_route_write_failed";

export class ProviderAnswerPersistedRouteError extends Error {
  constructor(readonly code: ProviderAnswerPersistedRouteErrorCode) {
    super(code);
    this.name = "ProviderAnswerPersistedRouteError";
  }
}

type ContentFreeCaseReceipt = Readonly<{
  caseBindingSha256: string;
  persistedEvidenceReceiptSha256: string;
  persistedSourceLocalSha256: string;
  persistedViewerSetSha256: string;
  providerEvidenceReceiptSha256: string;
  providerSourceLocalSha256: string;
  providerViewerSetSha256: string;
  sourceLocalEquivalenceSha256: string;
  viewerCount: number;
  viewerSetSha256: string;
}>;

export type ProviderAnswerPersistedRouteReceipt = Readonly<{
  artifactType: "knowledge_answer_persisted_route_receipt";
  artifactVersion: typeof KNOWLEDGE_PROVIDER_ANSWER_PERSISTED_ROUTE_VERSION;
  caseCount: typeof KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT;
  codeDigests: Readonly<{
    groundingSha256: string;
    harnessSha256: string;
    migrationSetSha256: string;
    persistenceSha256: string;
    resolverSha256: string;
  }>;
  entries: readonly ContentFreeCaseReceipt[];
  execution: Readonly<{
    callerSuppliedProvenanceAccepted: false;
    directPersonalSources: true;
    disposableDatabaseRequired: true;
    productionCitationResolverUsed: true;
    productionGroundingSettlementUsed: true;
    productionReceiptPersistenceUsed: true;
    resolverIsolationLevel: "RepeatableRead";
  }>;
  executionReceiptSha256: string;
  gates: Readonly<{
    citationViewerPersistedRouteGatePassed: true;
    fullProductionReleaseEligible: false;
    independentHumanReviewCompleted: false;
  }>;
  input: Readonly<{
    mappingSha256: string;
    outputFreezeSha256: string;
    packetSha256: string;
    provider: SelectedProvider;
  }>;
  output: Readonly<{
    mappingSha256: string;
    outputFreezeSha256: string;
    packetSha256: string;
  }>;
  privateContentIncluded: false;
  viewerCount: number;
}>;

export type ProviderAnswerPersistedRouteReport = Readonly<{
  aggregateOnly: true;
  caseCount: typeof KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT;
  citationViewerPersistedRouteGatePassed: true;
  executionReceiptSha256: string;
  fullProductionReleaseEligible: false;
  inputOutputFreezeSha256: Readonly<{
    input: string;
    output: string;
  }>;
  privateContentIncluded: false;
  provider: SelectedProvider;
  viewerCount: number;
}>;

export type ValidatedProviderAnswerPersistedRoutePromotion = Readonly<{
  receipt: ProviderAnswerPersistedRouteReceipt;
  report: ProviderAnswerPersistedRouteReport;
}>;

export type ProviderAnswerPersistedRouteAudit = Readonly<{
  receipt: ProviderAnswerPersistedRouteReceipt;
  releaseTrustEligible: false;
  report: ProviderAnswerPersistedRouteReport;
}>;

export type ProviderAnswerPersistedRouteCapture = Readonly<{
  artifacts: ProviderAnswerArtifactChain;
  inputArtifacts: ProviderAnswerArtifactChain;
  promotion: ValidatedProviderAnswerPersistedRoutePromotion;
  receipt: ProviderAnswerPersistedRouteReceipt;
  report: ProviderAnswerPersistedRouteReport;
}>;

type SourceLocalProjection = Readonly<{
  baseDisplayName: string | null;
  contentHash: string;
  excerpt: string;
  fileDisplayName: string;
  handle: string;
  headingPath: readonly string[];
  page: number;
  sourceDisplayName: string;
  sourceVersionNumber: number;
  state: "available";
}>;

type PreparedSource = Readonly<{
  artifactId: string;
  contentHash: string;
  encoded: ReturnType<typeof encodeKnowledgeNormalizedDocument>;
  evidence: SourceLocalProjection;
  passageId: string;
  sectionId: string;
  sourceId: string;
  storageKey: string;
  versionId: string;
}>;

type PersistedCaseCapture = Readonly<{
  caseDefinition: ProviderAnswerEvalCase;
  evidenceReceiptSha256: string;
  grounding: NonNullable<Awaited<ReturnType<typeof groundKnowledgeRunAnswer>>>["grounding"];
  sourceLocalSha256: string;
  viewerArtifacts: readonly ProviderAnswerCitationViewerArtifact[];
  viewerSetSha256: string;
}>;

function fail(code: ProviderAnswerPersistedRouteErrorCode): never {
  throw new ProviderAnswerPersistedRouteError(code);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    return Object.freeze(value);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) fail("knowledge_provider_answer_persisted_route_artifact_invalid");
  return serialized;
}

function sha256Bytes(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalSha256(value: unknown): string {
  return sha256Bytes(canonicalJson(value));
}

function sha256Value(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return record(value) && Object.keys(value).sort().join("\0") ===
    [...keys].sort().join("\0");
}

function inputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function safeProvider(value: string): value is SelectedProvider {
  return value === "anthropic" || value === "gemini" || value === "openai";
}

export function parseProviderAnswerPersistedRouteCli(argv: readonly string[]): Readonly<{
  help: boolean;
  inputReviewDirectory: string | null;
  outputReviewDirectory: string | null;
  promotionDirectory: string | null;
  provider: SelectedProvider | null;
}> {
  let help = false;
  let inputReviewDirectory: string | null = null;
  let outputReviewDirectory: string | null = null;
  let promotionDirectory: string | null = null;
  let provider: SelectedProvider | null = null;
  const value = (argument: string, name: string, index: number): Readonly<{
    nextIndex: number;
    value: string;
  }> => {
    if (argument === name) {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        fail("knowledge_provider_answer_persisted_route_argument_invalid");
      }
      return { nextIndex: index + 1, value: next };
    }
    return { nextIndex: index, value: argument.slice(`${name}=`.length) };
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--help") {
      if (argv.length !== 1) fail("knowledge_provider_answer_persisted_route_argument_invalid");
      help = true;
      continue;
    }
    if (argument === "--provider" || argument.startsWith("--provider=")) {
      if (provider !== null) fail("knowledge_provider_answer_persisted_route_argument_invalid");
      const selected = value(argument, "--provider", index);
      if (!safeProvider(selected.value)) {
        fail("knowledge_provider_answer_persisted_route_argument_invalid");
      }
      provider = selected.value;
      index = selected.nextIndex;
      continue;
    }
    if (argument === "--input-review-dir" || argument.startsWith("--input-review-dir=")) {
      if (inputReviewDirectory !== null) {
        fail("knowledge_provider_answer_persisted_route_argument_invalid");
      }
      const selected = value(argument, "--input-review-dir", index);
      inputReviewDirectory = selected.value;
      index = selected.nextIndex;
      continue;
    }
    if (argument === "--output-review-dir" || argument.startsWith("--output-review-dir=")) {
      if (outputReviewDirectory !== null) {
        fail("knowledge_provider_answer_persisted_route_argument_invalid");
      }
      const selected = value(argument, "--output-review-dir", index);
      outputReviewDirectory = selected.value;
      index = selected.nextIndex;
      continue;
    }
    if (argument === "--promotion-dir" || argument.startsWith("--promotion-dir=")) {
      if (promotionDirectory !== null) {
        fail("knowledge_provider_answer_persisted_route_argument_invalid");
      }
      const selected = value(argument, "--promotion-dir", index);
      promotionDirectory = selected.value;
      index = selected.nextIndex;
      continue;
    }
    fail("knowledge_provider_answer_persisted_route_argument_invalid");
  }
  if (help) {
    return { help, inputReviewDirectory, outputReviewDirectory, promotionDirectory, provider };
  }
  if (!provider || !inputReviewDirectory || !outputReviewDirectory || !promotionDirectory ||
    new Set([inputReviewDirectory, outputReviewDirectory, promotionDirectory]).size !== 3) {
    fail("knowledge_provider_answer_persisted_route_argument_invalid");
  }
  return { help, inputReviewDirectory, outputReviewDirectory, promotionDirectory, provider };
}

const inputArtifactFiles = Object.freeze([
  KNOWLEDGE_PROVIDER_ANSWER_MAPPING_FILE,
  KNOWLEDGE_PROVIDER_ANSWER_OUTPUT_FREEZE_FILE,
  KNOWLEDGE_PROVIDER_ANSWER_PACKET_FILE
].sort());
const promotionArtifactFiles = Object.freeze([
  KNOWLEDGE_PROVIDER_ANSWER_PERSISTED_ROUTE_RECEIPT_FILE
]);
const issuedCaptures = new WeakSet<object>();
const validatedPromotions = new WeakSet<object>();

function safeReviewDirectoryPath(reviewDirectory: string): boolean {
  return Boolean(reviewDirectory && isAbsolute(reviewDirectory) &&
    resolve(reviewDirectory) === reviewDirectory && dirname(reviewDirectory) === "/tmp" &&
    REVIEW_DIRECTORY_PATTERN.test(basename(reviewDirectory)));
}

function safePromotionDirectoryPath(promotionDirectory: string): boolean {
  return Boolean(promotionDirectory && isAbsolute(promotionDirectory) &&
    resolve(promotionDirectory) === promotionDirectory &&
    dirname(promotionDirectory) === "/tmp" &&
    PERSISTED_ROUTE_DIRECTORY_PATTERN.test(basename(promotionDirectory)));
}

async function assertPrivatePromotionDirectory(
  promotionDirectory: string,
  expectedFiles: readonly string[]
): Promise<void> {
  if (!safePromotionDirectoryPath(promotionDirectory)) {
    fail("knowledge_provider_answer_persisted_route_directory_invalid");
  }
  try {
    const [details, canonical, entries] = await Promise.all([
      lstat(promotionDirectory),
      realpath(promotionDirectory),
      readdir(promotionDirectory)
    ]);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!details.isDirectory() || details.isSymbolicLink() ||
      canonical !== promotionDirectory || (details.mode & 0o777) !== 0o700 ||
      (uid !== null && details.uid !== uid) ||
      canonicalJson([...entries].sort()) !== canonicalJson([...expectedFiles].sort())) {
      fail("knowledge_provider_answer_persisted_route_directory_unsafe");
    }
  } catch (error) {
    if (error instanceof ProviderAnswerPersistedRouteError) throw error;
    fail("knowledge_provider_answer_persisted_route_directory_unsafe");
  }
}

async function readPrivateJson(reviewDirectory: string, fileName: string): Promise<unknown> {
  const path = resolve(reviewDirectory, fileName);
  try {
    const details = await lstat(path);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!details.isFile() || details.isSymbolicLink() || details.size < 2 ||
      details.size > PRIVATE_ARTIFACT_MAX_BYTES || (details.mode & 0o777) !== 0o600 ||
      (uid !== null && details.uid !== uid)) {
      fail("knowledge_provider_answer_persisted_route_directory_unsafe");
    }
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof ProviderAnswerPersistedRouteError) throw error;
    fail("knowledge_provider_answer_persisted_route_artifact_invalid");
  }
}

export async function readProviderAnswerArtifactDirectory(
  reviewDirectory: string
): Promise<ProviderAnswerArtifactChain> {
  if (!safeReviewDirectoryPath(reviewDirectory)) {
    fail("knowledge_provider_answer_persisted_route_directory_invalid");
  }
  try {
    const [details, canonical, entries] = await Promise.all([
      lstat(reviewDirectory),
      realpath(reviewDirectory),
      readdir(reviewDirectory)
    ]);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!details.isDirectory() || details.isSymbolicLink() || canonical !== reviewDirectory ||
      (details.mode & 0o777) !== 0o700 || (uid !== null && details.uid !== uid) ||
      canonicalJson([...entries].sort()) !== canonicalJson(inputArtifactFiles)) {
      fail("knowledge_provider_answer_persisted_route_directory_unsafe");
    }
  } catch (error) {
    if (error instanceof ProviderAnswerPersistedRouteError) throw error;
    fail("knowledge_provider_answer_persisted_route_directory_unsafe");
  }
  const [freeze, mapping, packet] = await Promise.all([
    readPrivateJson(reviewDirectory, KNOWLEDGE_PROVIDER_ANSWER_OUTPUT_FREEZE_FILE),
    readPrivateJson(reviewDirectory, KNOWLEDGE_PROVIDER_ANSWER_MAPPING_FILE),
    readPrivateJson(reviewDirectory, KNOWLEDGE_PROVIDER_ANSWER_PACKET_FILE)
  ]);
  const chain = { freeze, mapping, packet };
  try {
    assertProviderAnswerReviewArtifactChain(chain);
  } catch {
    fail("knowledge_provider_answer_persisted_route_artifact_invalid");
  }
  return chain;
}

type CompleteMappingEntry = Extract<
  ProviderAnswerReviewMapping["entries"][number],
  Readonly<{ status: "complete" }>
>;

function selectedProviderEntries(
  chain: ProviderAnswerArtifactChain,
  provider: SelectedProvider
): readonly CompleteMappingEntry[] {
  const allProviderEntries = chain.mapping.entries.filter((entry) => entry.provider === provider);
  const complete = allProviderEntries.filter((entry): entry is CompleteMappingEntry =>
    entry.status === "complete");
  const expectedCases = providerAnswerEvalCases();
  const expectedIds = new Set(expectedCases.map(({ id }) => id));
  const profile = providerAnswerEvalProfiles().find((candidate) => candidate.provider === provider);
  if (!profile || allProviderEntries.length !== KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT ||
    complete.length !== KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT ||
    new Set(complete.map(({ caseId }) => caseId)).size !== KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT ||
    complete.some((entry) => !expectedIds.has(entry.caseId) ||
      entry.modelId !== profile.modelId || !chain.packet.items.some((item) =>
        item.reviewId === entry.reviewId && item.outputSha256 === entry.outputSha256))) {
    fail("knowledge_provider_answer_persisted_route_incomplete_provider");
  }
  return Object.freeze([...complete].sort((left, right) =>
    left.caseId.localeCompare(right.caseId)));
}

function selectedProviderArtifactChain(
  chain: ProviderAnswerArtifactChain,
  provider: SelectedProvider
): ProviderAnswerArtifactChain {
  const entries = selectedProviderEntries(chain, provider);
  const reviewIds = new Set(entries.map(({ reviewId }) => reviewId));
  const items = chain.packet.items.filter(({ reviewId }) => reviewIds.has(reviewId));
  if (items.length !== KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT) {
    fail("knowledge_provider_answer_persisted_route_incomplete_provider");
  }
  const { packetSha256: _oldPacketSha256, ...oldPacketBody } = chain.packet;
  const packetBody: Omit<ProviderAnswerReviewPacket, "packetSha256"> = {
    ...oldPacketBody,
    items: Object.freeze([...items])
  };
  const packet: ProviderAnswerReviewPacket = Object.freeze({
    ...packetBody,
    packetSha256: canonicalSha256(packetBody)
  });
  const { mappingSha256: _oldMappingSha256, ...oldMappingBody } = chain.mapping;
  const mappingBody: Omit<ProviderAnswerReviewMapping, "mappingSha256"> = {
    ...oldMappingBody,
    entries: Object.freeze([...entries]),
    packetSha256: packet.packetSha256
  };
  const mapping: ProviderAnswerReviewMapping = Object.freeze({
    ...mappingBody,
    mappingSha256: canonicalSha256(mappingBody)
  });
  const outputs = items.map(({ outputSha256, reviewId }) => ({
    outputSha256,
    reviewId
  })).sort((left, right) => left.reviewId.localeCompare(right.reviewId));
  const { freezeSha256: _oldFreezeSha256, ...oldFreezeBody } = chain.freeze;
  const freezeBody: Omit<ProviderAnswerOutputFreeze, "freezeSha256"> = {
    ...oldFreezeBody,
    mappingSha256: mapping.mappingSha256,
    outputCount: KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT,
    outputs: Object.freeze(outputs),
    packetSha256: packet.packetSha256
  };
  const freeze: ProviderAnswerOutputFreeze = Object.freeze({
    ...freezeBody,
    freezeSha256: canonicalSha256(freezeBody)
  });
  const selected = Object.freeze({ freeze, mapping, packet });
  try {
    assertProviderAnswerReviewArtifactChain(selected);
  } catch {
    fail("knowledge_provider_answer_persisted_route_artifact_invalid");
  }
  return selected;
}

function sourceLocalProjection(input: Readonly<{
  artifact: ProviderAnswerCitationViewerArtifact;
  evidence: ProviderAnswerReviewPacket["items"][number]["sourceLocalEvidence"][number];
  provenance: ProviderAnswerCitationViewerArtifact["provenance"];
}>): SourceLocalProjection {
  const { artifact, evidence, provenance } = input;
  const viewer = artifact.viewer;
  const releaseEvidenceEligible = provenance === "persisted_route";
  if (artifact.provenance !== provenance ||
    artifact.releaseEvidenceEligible !== releaseEvidenceEligible ||
    viewer.state !== "available" ||
    evidence.state !== "available" || typeof evidence.excerpt !== "string" ||
    !evidence.excerpt || !sha256Value(evidence.contentHash) ||
    typeof evidence.locator?.page !== "number" || !Number.isSafeInteger(evidence.locator.page) ||
    evidence.locator.page < 1 || !Number.isSafeInteger(evidence.sourceVersionNumber) ||
    evidence.sourceVersionNumber! < 1 || viewer.handle !== evidence.handle ||
    viewer.excerpt !== evidence.excerpt || viewer.source.name !== evidence.sourceName ||
    viewer.source.versionNumber !== evidence.sourceVersionNumber ||
    !SOURCE_FILE_PATTERN.test(viewer.source.fileName) ||
    viewer.source.statuses.length !== 0 || viewer.originalKind !== null ||
    viewer.source.baseName !== evidence.baseName) {
    fail("knowledge_provider_answer_persisted_route_artifact_invalid");
  }
  return Object.freeze({
    baseDisplayName: viewer.source.baseName,
    contentHash: evidence.contentHash,
    excerpt: evidence.excerpt,
    fileDisplayName: viewer.source.fileName,
    handle: evidence.handle,
    headingPath: Object.freeze([...evidence.headingPath]),
    page: evidence.locator.page,
    sourceDisplayName: viewer.source.name,
    sourceVersionNumber: evidence.sourceVersionNumber,
    state: "available"
  });
}

function packetSourceLocalProjection(
  item: ProviderAnswerReviewPacket["items"][number],
  provenance: ProviderAnswerCitationViewerArtifact["provenance"] = "synthetic_projection"
): readonly SourceLocalProjection[] {
  if (item.citationViewerArtifacts.length !== item.sourceLocalEvidence.length ||
    item.citationViewerArtifacts.length < 1 || item.citationViewerArtifacts.length > 8) {
    fail("knowledge_provider_answer_persisted_route_artifact_invalid");
  }
  const projections = item.sourceLocalEvidence.map((evidence, index) => sourceLocalProjection({
    artifact: item.citationViewerArtifacts[index]!,
    evidence,
    provenance
  }));
  if (new Set(projections.map(({ handle }) => handle)).size !== projections.length) {
    fail("knowledge_provider_answer_persisted_route_artifact_invalid");
  }
  return Object.freeze(projections);
}

function parsedBoxes(viewer: KnowledgeCitationViewer): readonly ParsedBoundingBox[] {
  if (viewer.state !== "available") return [];
  return Object.freeze(viewer.locator.boundingBoxes.map((box) => Object.freeze({
    bottom: box.bottom,
    coordinateOrigin: box.coordinateOrigin,
    left: box.left,
    page: box.page,
    right: box.right,
    top: box.top
  })));
}

function prepareSources(input: Readonly<{
  language: ProviderAnswerEvalCase["language"];
  item: ProviderAnswerReviewPacket["items"][number];
  runNonce: string;
}>): readonly PreparedSource[] {
  const extractionConfig = getKnowledgeExtractionConfig();
  const sourceLocal = packetSourceLocalProjection(input.item);
  return Object.freeze(sourceLocal.map((evidence, index) => {
    const providerViewer = input.item.citationViewerArtifacts[index]!.viewer;
    const parsed = finalizeParsedDocument({
      blocks: [{
        assetIds: [],
        boundingBoxes: parsedBoxes(providerViewer),
        headingPath: evidence.headingPath,
        index: 0,
        isTable: false,
        languageHints: [input.language],
        page: evidence.page,
        pageEnd: evidence.page,
        readingOrder: 0,
        table: null,
        text: evidence.excerpt,
        type: "paragraph"
      }],
      engine: "inline",
      languages: [input.language],
      mediaType: providerViewer.state === "available"
        ? providerViewer.source.mimeType
        : "text/plain",
      pageCount: evidence.page,
      status: "complete"
    });
    const encoded = encodeKnowledgeNormalizedDocument(parsed, extractionConfig, {
      sourceDisplayName: evidence.fileDisplayName,
      sourceMediaType: providerViewer.state === "available"
        ? providerViewer.source.mimeType
        : "text/plain"
    });
    return Object.freeze({
      artifactId: `provider-answer-artifact-${randomUUID()}`,
      contentHash: evidence.contentHash,
      encoded,
      evidence,
      passageId: `provider-answer-passage-${randomUUID()}`,
      sectionId: `provider-answer-section-${randomUUID()}`,
      sourceId: `provider-answer-source-${randomUUID()}`,
      storageKey: `knowledge-provider-answer-persisted-route/${input.runNonce}/${index + 1}.json`,
      versionId: `provider-answer-version-${randomUUID()}`
    });
  }));
}

async function ensurePersistedRouteProfile(client: PrismaClient): Promise<void> {
  await client.providerConnection.upsert({
    create: {
      displayName: "Knowledge persisted-route local evaluation",
      family: "test",
      id: PERSISTED_ROUTE_PROFILE.connectionId
    },
    update: {},
    where: { id: PERSISTED_ROUTE_PROFILE.connectionId }
  });
  await client.providerModel.upsert({
    create: {
      capabilities: {},
      connectionId: PERSISTED_ROUTE_PROFILE.connectionId,
      defaultParams: {},
      displayName: "Knowledge persisted-route local embedding fixture",
      id: PERSISTED_ROUTE_PROFILE.modelId,
      modelClass: "embedding",
      modelId: PERSISTED_ROUTE_PROFILE.modelId,
      provider: "test"
    },
    update: {},
    where: { id: PERSISTED_ROUTE_PROFILE.modelId }
  });
  await client.providerCredential.upsert({
    create: {
      connectionId: PERSISTED_ROUTE_PROFILE.connectionId,
      enabled: true,
      id: PERSISTED_ROUTE_PROFILE.credentialId,
      label: "Knowledge persisted-route local credential"
    },
    update: {},
    where: { id: PERSISTED_ROUTE_PROFILE.credentialId }
  });
  await client.providerCredentialVersion.upsert({
    create: {
      activatedAt: new Date(),
      credentialId: PERSISTED_ROUTE_PROFILE.credentialId,
      id: PERSISTED_ROUTE_PROFILE.credentialVersionId,
      testEvidence: { authenticationMode: "none", synthetic: true },
      testedAt: new Date(),
      version: 1
    },
    update: {},
    where: { id: PERSISTED_ROUTE_PROFILE.credentialVersionId }
  });
  await client.knowledgeIndexProfile.upsert({
    create: { id: PERSISTED_ROUTE_PROFILE.profileId },
    update: {},
    where: { id: PERSISTED_ROUTE_PROFILE.profileId }
  });
  const existing = await client.knowledgeIndexProfileRevision.findUnique({
    select: {
      embeddingProviderModelId: true,
      profileId: true,
      targetDimension: true,
      vectorSpaceFingerprint: true
    },
    where: { id: PERSISTED_ROUTE_PROFILE.profileRevisionId }
  });
  if (!existing) {
    await client.knowledgeIndexProfileRevision.create({
      data: {
        activatedAt: new Date(),
        chunkingProfileVersion: 1,
        egressPolicy: knowledgeProfileEgressPolicy({
          embeddingProviderModelId: PERSISTED_ROUTE_PROFILE.modelId
        }),
        embeddingConfiguration: {},
        embeddingProviderModelId: PERSISTED_ROUTE_PROFILE.modelId,
        executionAuthority: "installation",
        id: PERSISTED_ROUTE_PROFILE.profileRevisionId,
        preflightCheckedAt: new Date(),
        preflightStatus: "ready",
        profileConfiguration: knowledgeProfileConfiguration({
          candidateLimit: 40,
          embeddingProviderModelId: PERSISTED_ROUTE_PROFILE.modelId,
          resultLimit: 8,
          scoreThreshold: 0.01
        }),
        profileId: PERSISTED_ROUTE_PROFILE.profileId,
        revisionNumber: 1,
        targetDimension: 1_024,
        vectorSpaceFingerprint: VECTOR_SPACE_FINGERPRINT
      }
    });
  } else if (existing.embeddingProviderModelId !== PERSISTED_ROUTE_PROFILE.modelId ||
    existing.profileId !== PERSISTED_ROUTE_PROFILE.profileId ||
    existing.targetDimension !== 1_024 ||
    existing.vectorSpaceFingerprint.trim() !== VECTOR_SPACE_FINGERPRINT) {
    fail("knowledge_provider_answer_persisted_route_persistence_failed");
  }
}

function planner(caseDefinition: ProviderAnswerEvalCase) {
  return {
    automaticRetrieval: true,
    coverage: caseDefinition.evidence.coverage,
    evidenceMode: "fuller",
    intent: caseDefinition.evidence.originalIntent.intent,
    originalQuery: caseDefinition.query,
    rewrite: { exactTerms: [], query: caseDefinition.query },
    status: "ready",
    strategy: caseDefinition.evidence.strategy,
    subqueries: [{
      exactTerms: [],
      lanes: ["semantic", "lexical"],
      ordinal: 0,
      purpose: "answer",
      query: caseDefinition.query,
      targetNames: []
    }],
    version: 1
  } as const;
}

function automaticSearchArguments(query: string) {
  return {
    coverage: { expectedPassageCount: null, mode: "partial" },
    exactTerms: [],
    lanes: ["exact", "lexical", "metadata", "semantic"],
    operation: "automatic_search",
    phaseOrdinal: 0,
    plannerVersion: 2,
    purpose: "answer",
    query,
    strategy: "focused",
    subqueryOrdinal: 0,
    targetNames: [],
    targetResolution: null,
    targetSourceIds: []
  } as const;
}

async function createPersistedCaseFixture(input: Readonly<{
  answer: string;
  caseDefinition: ProviderAnswerEvalCase;
  client: PrismaClient;
  item: ProviderAnswerReviewPacket["items"][number];
  profile: ProviderAnswerEvalProfile;
  sources: readonly PreparedSource[];
}>): Promise<Readonly<{
  assistantMessageId: string;
  chatId: string;
  profileBindingId: string;
  runId: string;
  toolCallId: string;
  userId: string;
}>> {
  const nonce = randomUUID();
  const userId = `provider-answer-persisted-route-user-${nonce}`;
  return input.client.$transaction(async (tx) => {
    await tx.user.create({
      data: { displayName: "Knowledge persisted-route evaluation", id: userId, status: "active" }
    });
    const chat = await tx.chat.create({
      data: { title: "Knowledge persisted-route evaluation", userId }
    });
    const userMessage = await tx.message.create({
      data: {
        chatId: chat.id,
        content: textMessageContent(input.caseDefinition.query),
        role: "user"
      }
    });
    const assistantMessage = await tx.message.create({
      data: {
        chatId: chat.id,
        content: textMessageContent(input.answer),
        parentMessageId: userMessage.id,
        role: "assistant",
        status: "complete"
      }
    });
    await tx.chat.update({
      data: { activeLeafMessageId: assistantMessage.id },
      where: { id: chat.id }
    });
    const run = await tx.modelRun.create({
      data: {
        assistantMessageId: assistantMessage.id,
        chatId: chat.id,
        modelId: input.profile.modelId,
        normalizedRequest: inputJson({
          knowledgePlan: {
            baseIds: [],
            mode: "explicit",
            sourceIds: input.sources.map(({ sourceId }) => sourceId),
            version: 1
          },
          knowledgePlanner: planner(input.caseDefinition)
        }),
        provider: input.profile.provider,
        status: "in_progress",
        userId,
        userMessageId: userMessage.id
      }
    });
    await tx.knowledgeRunScope.create({
      data: {
        budgetPolicy: inputJson(DEFAULT_KNOWLEDGE_BUDGET_POLICY),
        exclusions: [],
        modelRunId: run.id,
        resolvedBaseCount: 0,
        resolvedSourceCount: input.sources.length,
        selection: inputJson({
          baseIds: [],
          mode: "explicit",
          sourceIds: input.sources.map(({ sourceId }) => sourceId),
          version: 1
        })
      }
    });
    const profileBinding = await tx.knowledgeRunProfileBinding.create({
      data: {
        embeddingConnectionId: PERSISTED_ROUTE_PROFILE.connectionId,
        embeddingCredentialId: PERSISTED_ROUTE_PROFILE.credentialId,
        embeddingCredentialSource: "default",
        embeddingCredentialVersionId: PERSISTED_ROUTE_PROFILE.credentialVersionId,
        embeddingExecutionSnapshot: inputJson({
          localEvaluation: true,
          providerModelId: PERSISTED_ROUTE_PROFILE.modelId
        }),
        embeddingProviderModelId: PERSISTED_ROUTE_PROFILE.modelId,
        modelRunId: run.id,
        ordinal: 0,
        profileRevisionId: PERSISTED_ROUTE_PROFILE.profileRevisionId,
        targetDimension: 1_024,
        vectorSpaceFingerprint: VECTOR_SPACE_FINGERPRINT
      }
    });
    for (let index = 0; index < input.sources.length; index += 1) {
      const source = input.sources[index]!;
      const viewer = input.item.citationViewerArtifacts[index]!.viewer;
      if (viewer.state !== "available") {
        fail("knowledge_provider_answer_persisted_route_artifact_invalid");
      }
      await tx.knowledgeSource.create({
        data: {
          id: source.sourceId,
          name: source.evidence.sourceDisplayName,
          ownerUserId: userId
        }
      });
      await tx.knowledgeSourceVersion.create({
        data: {
          byteSize: Buffer.byteLength(source.evidence.excerpt, "utf8"),
          checksum: sha256Bytes(source.evidence.excerpt),
          fileName: source.evidence.fileDisplayName,
          id: source.versionId,
          mimeType: viewer.source.mimeType,
          ownerUserId: userId,
          sourceId: source.sourceId,
          versionNumber: source.evidence.sourceVersionNumber
        }
      });
      await tx.knowledgeSourceIndexArtifact.create({
        data: {
          chunkCount: 1,
          embeddedPassageCount: 0,
          id: source.artifactId,
          normalizedTextByteSize: source.encoded.body.byteLength,
          normalizedTextChecksum: source.encoded.checksum,
          normalizedTextStorageKey: source.storageKey,
          pageCount: source.evidence.page,
          processingStage: "embedding",
          profileRevisionId: PERSISTED_ROUTE_PROFILE.profileRevisionId,
          sourceVersionId: source.versionId,
          state: "processing"
        }
      });
      const hierarchicalId = `provider-answer-hierarchy-${randomUUID()}`;
      await tx.knowledgeHierarchicalIndexArtifact.create({
        data: {
          derivationMode: "normalized_v2",
          id: hierarchicalId,
          schemaVersion: 2,
          sourceArtifactId: source.artifactId,
          sourceVersionId: source.versionId,
          state: "building"
        }
      });
      await tx.knowledgeArtifactDocumentIndex.create({
        data: {
          contentHash: source.encoded.document.contentHash,
          documentType: viewer.source.mimeType,
          fileName: source.evidence.fileDisplayName,
          indexArtifactId: hierarchicalId,
          languageConfig: input.caseDefinition.language === "ru" ? "russian" : "english",
          languages: [input.caseDefinition.language],
          pageCount: source.evidence.page,
          sourceName: source.evidence.sourceDisplayName
        }
      });
      await tx.knowledgeArtifactSectionIndex.create({
        data: {
          contentHash: source.contentHash,
          fileName: source.evidence.fileDisplayName,
          headingPath: [...source.evidence.headingPath],
          headingText: source.evidence.headingPath.join(" "),
          id: source.sectionId,
          indexArtifactId: hierarchicalId,
          label: source.evidence.headingPath.at(-1) ?? "Review evidence",
          languageConfig: input.caseDefinition.language === "ru" ? "russian" : "english",
          languages: [input.caseDefinition.language],
          ordinal: 0,
          page: source.evidence.page,
          pageEnd: source.evidence.page,
          passageEnd: 0,
          passageStart: 0
        }
      });
      const blockId = source.encoded.document.blocks[0]?.id;
      if (!blockId) fail("knowledge_provider_answer_persisted_route_persistence_failed");
      await tx.knowledgeArtifactPassageIndex.create({
        data: {
          contentHash: source.contentHash,
          embeddingTextHash: sha256Bytes(source.evidence.excerpt),
          fileName: source.evidence.fileDisplayName,
          headingPath: [...source.evidence.headingPath],
          headingText: source.evidence.headingPath.join(" "),
          id: source.passageId,
          indexArtifactId: hierarchicalId,
          languageConfig: input.caseDefinition.language === "ru" ? "russian" : "english",
          languages: [input.caseDefinition.language],
          ordinal: 0,
          page: source.evidence.page,
          pageEnd: source.evidence.page,
          sectionId: source.sectionId,
          sourceBlockEnd: 0,
          sourceBlockIds: [blockId],
          sourceBlockStart: 0,
          sourceName: source.evidence.sourceDisplayName,
          text: source.evidence.excerpt,
          tokenCount: Math.max(1, source.evidence.excerpt.trim().split(/\s+/u).length)
        }
      });
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "KnowledgeArtifactPassageEmbedding" (
          "passageId", "indexArtifactId", "embeddingTextHash",
          "embeddingDimension", "embedding", "createdAt"
        ) VALUES (
          ${source.passageId}, ${hierarchicalId}, ${sha256Bytes(source.evidence.excerpt)},
          1024, ${EVALUATION_VECTOR_LITERAL}::vector, ${new Date()}
        )
      `);
      const exactValue = source.evidence.sourceDisplayName.slice(0, 512);
      await tx.knowledgeArtifactExactEntry.create({
        data: {
          id: `provider-answer-exact-${randomUUID()}`,
          indexArtifactId: hierarchicalId,
          kind: "title",
          normalizedValue: exactValue.toLocaleLowerCase("en-US"),
          ordinal: 0,
          page: source.evidence.page,
          pageEnd: source.evidence.page,
          passageId: source.passageId,
          sectionId: source.sectionId,
          value: exactValue,
          valueHash: sha256Bytes(exactValue)
        }
      });
      await tx.knowledgeHierarchicalIndexArtifact.update({
        data: {
          checksum: canonicalSha256({
            contentHash: source.contentHash,
            passageId: source.passageId,
            sourceArtifactId: source.artifactId
          }),
          documentCount: 1,
          exactEntryCount: 1,
          passageCount: 1,
          readyAt: new Date(),
          sectionCount: 1,
          state: "ready"
        },
        where: { id: hierarchicalId }
      });
      await tx.knowledgeSourceIndexArtifact.update({
        data: {
          embeddedPassageCount: 1,
          processingStage: null,
          readyAt: new Date(),
          state: "ready"
        },
        where: { id: source.artifactId }
      });
      await tx.knowledgeSource.update({
        data: { currentVersionId: source.versionId },
        where: { id: source.sourceId }
      });
      await tx.knowledgeRunSourceBinding.create({
        data: {
          accessProvenance: inputJson({
            authority: { knowledgeBaseIds: [], owner: true, projectId: null },
            selectionProvenance: ["explicit_source"]
          }),
          baseProvenance: [],
          directSelected: true,
          fileNameSnapshot: source.evidence.fileDisplayName,
          modelRunId: run.id,
          ordinal: index,
          profileBindingId: profileBinding.id,
          readinessState: "ready",
          selectionKind: "direct",
          sourceAlias: `S${index + 1}`,
          sourceArtifactId: source.artifactId,
          sourceId: source.sourceId,
          sourceNameSnapshot: source.evidence.sourceDisplayName,
          sourceVersionId: source.versionId,
          sourceVersionNumber: source.evidence.sourceVersionNumber
        }
      });
    }
    const toolCall = await tx.modelRunToolCall.create({
      data: {
        arguments: inputJson(automaticSearchArguments(input.caseDefinition.query)),
        modelRunId: run.id,
        ordinal: 0,
        providerCallId: `provider-answer-persisted-route-call-${nonce}`,
        roundIndex: 0,
        startedAt: new Date(),
        state: "running",
        toolName: "retrieve_knowledge"
      }
    });
    return Object.freeze({
      assistantMessageId: assistantMessage.id,
      chatId: chat.id,
      profileBindingId: profileBinding.id,
      runId: run.id,
      toolCallId: toolCall.id,
      userId
    });
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    timeout: 120_000
  });
}

function persistedRetrievalEvidence(input: Readonly<{
  caseDefinition: ProviderAnswerEvalCase;
  profileBindingId: string;
  sources: readonly PreparedSource[];
}>): KnowledgeRetrievalEvidence {
  const profileDisplayName = input.sources[0]?.evidence.baseDisplayName;
  if (!profileDisplayName || input.sources.some((source) =>
    source.evidence.baseDisplayName !== profileDisplayName)) {
    fail("knowledge_provider_answer_persisted_route_artifact_invalid");
  }
  const results: KnowledgeRetrievedPassageEvidence[] = input.sources.map((source, index) => ({
    annRank: index + 1,
    baseName: source.evidence.baseDisplayName ?? "Pinned Knowledge Profile",
    bindingOrdinal: 0,
    chunkId: source.passageId,
    chunkIndex: 0,
    confidence: 1,
    contentHash: source.contentHash,
    documentId: source.sourceId,
    documentVersionId: source.versionId,
    documentVersionNumber: source.evidence.sourceVersionNumber,
    fileName: source.evidence.fileDisplayName,
    ftsRank: index + 1,
    ftsScore: 1,
    fusedScore: 2 / (61 + index),
    handle: source.evidence.handle,
    headingPath: source.evidence.headingPath,
    includedText: source.evidence.excerpt,
    includedTextBytes: Buffer.byteLength(source.evidence.excerpt, "utf8"),
    knowledgeBaseId: input.profileBindingId,
    page: source.evidence.page,
    sectionId: source.sectionId,
    sourceAlias: `S${index + 1}`,
    sourceArtifactId: source.artifactId,
    sourceName: source.evidence.sourceDisplayName,
    sourceTextBytes: Buffer.byteLength(source.evidence.excerpt, "utf8"),
    textTruncated: false,
    vectorDistance: 0.1,
    vectorScore: 0.9
  }));
  const draft: KnowledgeRetrievalEvidence = {
    bases: [{
      baseContentRevision: 0,
      baseName: profileDisplayName,
      candidateCount: results.length,
      indexedContentRevision: 0,
      indexGenerationId: PERSISTED_ROUTE_PROFILE.profileRevisionId,
      knowledgeBaseId: input.profileBindingId,
      ordinal: 0,
      state: "ready",
      targetDimension: 1_024,
      vectorSpaceFingerprint: VECTOR_SPACE_FINGERPRINT
    }],
    candidateCount: results.length,
    candidateLimit: 40,
    durationMs: 0,
    embeddingExecutions: [],
    fusion: "rrf_k60",
    invocationOrdinal: 1,
    operation: "automatic_search",
    outcome: "complete",
    postRerankOrder: results.map(({ chunkId }) => chunkId),
    preRerankOrder: results.map(({ chunkId }) => chunkId),
    providerText: "pending",
    query: input.caseDefinition.query,
    rerankerBinding: null,
    resultLimit: 8,
    results,
    scopeAliases: results.map((result, index) => ({
      alias: `S${index + 1}`,
      kind: "source" as const,
      label: result.sourceName!
    })),
    threshold: 0.01,
    version: KNOWLEDGE_RESULT_VERSION
  };
  return Object.freeze({ ...draft, providerText: knowledgeToolResultText(draft) });
}

function sourceLocalFromPersisted(
  evidence: KnowledgeEvidencePackage,
  viewers: readonly KnowledgeCitationViewer[]
): readonly SourceLocalProjection[] {
  const viewerByHandle = new Map(viewers.map((viewer) => [viewer.handle, viewer]));
  return Object.freeze(evidence.items.map((item) => {
    const viewer = viewerByHandle.get(item.handle);
    if (item.state !== "available" || viewer?.state !== "available" ||
      typeof item.excerpt !== "string" || !sha256Value(item.contentHash) ||
      typeof item.locator?.page !== "number" || !Number.isSafeInteger(item.sourceVersionNumber) ||
      !item.sourceName || viewer.excerpt !== item.excerpt ||
      viewer.source.name !== item.sourceName ||
      viewer.source.versionNumber !== item.sourceVersionNumber) {
      fail("knowledge_provider_answer_persisted_route_capture_failed");
    }
    return Object.freeze({
      baseDisplayName: viewer.source.baseName,
      contentHash: item.contentHash,
      excerpt: item.excerpt,
      fileDisplayName: viewer.source.fileName,
      handle: item.handle,
      headingPath: Object.freeze([...item.headingPath]),
      page: item.locator.page,
      sourceDisplayName: viewer.source.name,
      sourceVersionNumber: item.sourceVersionNumber,
      state: "available" as const
    });
  }));
}

async function cleanupPersistedCase(input: Readonly<{
  client: PrismaClient;
  fixture: Awaited<ReturnType<typeof createPersistedCaseFixture>> | null;
  sources: readonly PreparedSource[];
  storage: StorageAdapter;
}>): Promise<void> {
  let failed = false;
  if (input.fixture) {
    try {
      await input.client.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL aiqsa.knowledge_purge = 'on'`;
        await tx.chat.deleteMany({
          where: { id: input.fixture!.chatId, userId: input.fixture!.userId }
        });
        await tx.knowledgeSource.updateMany({
          data: { currentVersionId: null, pendingVersionId: null },
          where: { id: { in: input.sources.map(({ sourceId }) => sourceId) } }
        });
        await tx.knowledgeSourceIndexArtifact.deleteMany({
          where: { id: { in: input.sources.map(({ artifactId }) => artifactId) } }
        });
        await tx.knowledgeSourceVersion.deleteMany({
          where: { id: { in: input.sources.map(({ versionId }) => versionId) } }
        });
        await tx.knowledgeSource.deleteMany({
          where: { id: { in: input.sources.map(({ sourceId }) => sourceId) } }
        });
        await tx.user.deleteMany({ where: { id: input.fixture!.userId } });
      }, { timeout: 120_000 });
    } catch {
      failed = true;
    }
  }
  for (const source of input.sources) {
    try {
      await input.storage.deleteObject(source.storageKey);
    } catch {
      failed = true;
    }
  }
  if (failed) fail("knowledge_provider_answer_persisted_route_cleanup_failed");
}

async function capturePersistedCase(input: Readonly<{
  answer: string;
  caseDefinition: ProviderAnswerEvalCase;
  client: PrismaClient;
  item: ProviderAnswerReviewPacket["items"][number];
  profile: ProviderAnswerEvalProfile;
  storage: StorageAdapter;
}>): Promise<PersistedCaseCapture> {
  const runNonce = randomUUID();
  const sources = prepareSources({
    item: input.item,
    language: input.caseDefinition.language,
    runNonce
  });
  const providerSourceLocal = packetSourceLocalProjection(input.item);
  let fixture: Awaited<ReturnType<typeof createPersistedCaseFixture>> | null = null;
  let result: PersistedCaseCapture | null = null;
  let operationError: unknown = null;
  try {
    for (const source of sources) {
      await input.storage.putObject({
        body: source.encoded.body,
        contentType: "application/json",
        storageKey: source.storageKey
      });
    }
    fixture = await createPersistedCaseFixture({ ...input, sources });
    const store = createPrismaKnowledgeRetrievalStore(input.client);
    const persisted = await store.persistReceipt({
      evidence: persistedRetrievalEvidence({
        caseDefinition: input.caseDefinition,
        profileBindingId: fixture.profileBindingId,
        sources
      }),
      modelRunToolCallId: fixture.toolCallId,
      runId: fixture.runId,
      userId: fixture.userId
    });
    if (!persisted) fail("knowledge_provider_answer_persisted_route_persistence_failed");
    const persistedFixture = fixture;
    const resolved = await input.client.$transaction(async (tx) => {
      const evidence = await loadKnowledgeEvidencePackage(tx, {
        runId: persistedFixture.runId,
        userId: persistedFixture.userId
      });
      if (!evidence || evidence.items.length !== sources.length) {
        fail("knowledge_provider_answer_persisted_route_persistence_failed");
      }
      const grounded = await groundKnowledgeRunAnswer(tx, {
        answer: input.answer,
        runId: persistedFixture.runId,
        userId: persistedFixture.userId
      });
      if (!grounded || grounded.grounding.finalText !== input.answer) {
        fail("knowledge_provider_answer_persisted_route_capture_failed");
      }
      await settleKnowledgeGrounding(tx, grounded);
      const viewers: KnowledgeCitationViewer[] = [];
      for (const item of evidence.items) {
        const viewer = await resolveKnowledgeCitationViewer(tx, input.storage, {
          assistantMessageId: persistedFixture.assistantMessageId,
          handle: item.handle,
          runId: persistedFixture.runId,
          userId: persistedFixture.userId
        });
        if (!viewer) fail("knowledge_provider_answer_persisted_route_capture_failed");
        viewers.push(viewer.citation);
      }
      return Object.freeze({
        evidence,
        grounded,
        viewers: Object.freeze(viewers)
      });
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 120_000
    });
    const providerViewers = input.item.citationViewerArtifacts.map(({ viewer }) => viewer);
    if (canonicalJson(providerViewers) !== canonicalJson(resolved.viewers)) {
      fail("knowledge_provider_answer_persisted_route_capture_failed");
    }
    const persistedSourceLocal = sourceLocalFromPersisted(
      resolved.evidence,
      resolved.viewers
    );
    if (canonicalJson(providerSourceLocal) !== canonicalJson(persistedSourceLocal)) {
      fail("knowledge_provider_answer_persisted_route_capture_failed");
    }
    result = Object.freeze({
      caseDefinition: input.caseDefinition,
      evidenceReceiptSha256: knowledgeEvidenceReceiptHash(resolved.evidence),
      grounding: resolved.grounded.grounding,
      sourceLocalSha256: canonicalSha256(persistedSourceLocal),
      viewerArtifacts: Object.freeze(resolved.viewers.map((viewer) => Object.freeze({
        provenance: "persisted_route" as const,
        releaseEvidenceEligible: true as const,
        viewer
      }))),
      viewerSetSha256: canonicalSha256(resolved.viewers)
    });
  } catch (error) {
    operationError = error;
  }
  try {
    await cleanupPersistedCase({ client: input.client, fixture, sources, storage: input.storage });
  } catch (cleanupError) {
    if (!operationError) operationError = cleanupError;
  }
  if (operationError) {
    if (operationError instanceof ProviderAnswerPersistedRouteError) throw operationError;
    fail("knowledge_provider_answer_persisted_route_persistence_failed");
  }
  return result ?? fail("knowledge_provider_answer_persisted_route_capture_failed");
}

async function regularFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const rootDetails = await lstat(root);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    fail("knowledge_provider_answer_persisted_route_digest_failed");
  }
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) fail("knowledge_provider_answer_persisted_route_digest_failed");
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
      else fail("knowledge_provider_answer_persisted_route_digest_failed");
    }
  };
  await walk(root);
  return Object.freeze(files.sort());
}

async function digestFile(path: string): Promise<string> {
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) {
      fail("knowledge_provider_answer_persisted_route_digest_failed");
    }
    return sha256Bytes(await readFile(path));
  } catch (error) {
    if (error instanceof ProviderAnswerPersistedRouteError) throw error;
    fail("knowledge_provider_answer_persisted_route_digest_failed");
  }
}

export async function providerAnswerPersistedRouteCodeDigests(
  repositoryRoot = process.cwd()
): Promise<ProviderAnswerPersistedRouteReceipt["codeDigests"]> {
  try {
    const paths = {
      grounding: resolve(repositoryRoot, "lib/server/knowledge/grounding.ts"),
      harness: resolve(repositoryRoot, "tests/knowledge-evals/providerAnswerPersistedRoute.ts"),
      persistence: resolve(repositoryRoot, "lib/server/knowledge/evidenceRepository.ts"),
      resolver: resolve(repositoryRoot, "lib/server/knowledge/citationViewer.ts")
    };
    const migrationsRoot = resolve(repositoryRoot, "prisma/migrations");
    const migrationFiles = await regularFiles(migrationsRoot);
    const [groundingSha256, harnessModuleSha256, persistenceModuleSha256, resolverSha256] =
      await Promise.all([
        digestFile(paths.grounding),
        digestFile(paths.harness),
        digestFile(paths.persistence),
        digestFile(paths.resolver)
      ]);
    const supportingPaths = [
      "lib/server/knowledge/normalizedDocument.ts",
      "lib/server/knowledge/prismaRetrievalRepository.ts",
      "tests/knowledge-evals/providerAnswerEval.ts"
    ];
    const supportDigests = await Promise.all(supportingPaths.map(async (path) => ({
      path,
      sha256: await digestFile(resolve(repositoryRoot, path))
    })));
    const migrationDigests = await Promise.all(migrationFiles.map(async (path) => ({
      path: relative(migrationsRoot, path),
      sha256: await digestFile(path)
    })));
    return Object.freeze({
      groundingSha256,
      harnessSha256: canonicalSha256({
        module: harnessModuleSha256,
        support: supportDigests
      }),
      migrationSetSha256: canonicalSha256(migrationDigests),
      persistenceSha256: persistenceModuleSha256,
      resolverSha256
    });
  } catch (error) {
    if (error instanceof ProviderAnswerPersistedRouteError) throw error;
    fail("knowledge_provider_answer_persisted_route_digest_failed");
  }
}

function receiptBody(
  receipt: ProviderAnswerPersistedRouteReceipt
): Omit<ProviderAnswerPersistedRouteReceipt, "executionReceiptSha256"> {
  const { executionReceiptSha256: _hash, ...body } = receipt;
  return body;
}

export function assertProviderAnswerPersistedRouteReceipt(
  value: unknown
): asserts value is ProviderAnswerPersistedRouteReceipt {
  try {
    if (!exactKeys(value, [
      "artifactType", "artifactVersion", "caseCount", "codeDigests", "entries",
      "execution", "executionReceiptSha256", "gates", "input", "output",
      "privateContentIncluded", "viewerCount"
    ])) fail("knowledge_provider_answer_persisted_route_receipt_invalid");
    const receipt = value as unknown as ProviderAnswerPersistedRouteReceipt;
    if (!exactKeys(receipt.codeDigests, [
      "groundingSha256", "harnessSha256", "migrationSetSha256", "persistenceSha256",
      "resolverSha256"
    ]) || !exactKeys(receipt.execution, [
      "callerSuppliedProvenanceAccepted", "directPersonalSources",
      "disposableDatabaseRequired", "productionCitationResolverUsed",
      "productionGroundingSettlementUsed", "productionReceiptPersistenceUsed",
      "resolverIsolationLevel"
    ]) || !exactKeys(receipt.gates, [
      "citationViewerPersistedRouteGatePassed", "fullProductionReleaseEligible",
      "independentHumanReviewCompleted"
    ]) || !exactKeys(receipt.input, [
      "mappingSha256", "outputFreezeSha256", "packetSha256", "provider"
    ]) || !exactKeys(receipt.output, [
      "mappingSha256", "outputFreezeSha256", "packetSha256"
    ]) || receipt.entries.some((entry) => !exactKeys(entry, [
      "caseBindingSha256", "persistedEvidenceReceiptSha256",
      "persistedSourceLocalSha256", "persistedViewerSetSha256",
      "providerEvidenceReceiptSha256", "providerSourceLocalSha256",
      "providerViewerSetSha256", "sourceLocalEquivalenceSha256", "viewerCount",
      "viewerSetSha256"
    ]))) fail("knowledge_provider_answer_persisted_route_receipt_invalid");
    const digestValues = [
      ...Object.values(receipt.codeDigests),
      receipt.executionReceiptSha256,
      receipt.input.mappingSha256,
      receipt.input.outputFreezeSha256,
      receipt.input.packetSha256,
      receipt.output.mappingSha256,
      receipt.output.outputFreezeSha256,
      receipt.output.packetSha256,
      ...receipt.entries.flatMap((entry) => [
        entry.caseBindingSha256,
        entry.persistedEvidenceReceiptSha256,
        entry.persistedSourceLocalSha256,
        entry.persistedViewerSetSha256,
        entry.providerEvidenceReceiptSha256,
        entry.providerSourceLocalSha256,
        entry.providerViewerSetSha256,
        entry.sourceLocalEquivalenceSha256,
        entry.viewerSetSha256
      ])
    ];
    if (receipt.artifactType !== "knowledge_answer_persisted_route_receipt" ||
      receipt.artifactVersion !== KNOWLEDGE_PROVIDER_ANSWER_PERSISTED_ROUTE_VERSION ||
      receipt.caseCount !== KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT ||
      receipt.entries.length !== KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT ||
      new Set(receipt.entries.map(({ caseBindingSha256 }) => caseBindingSha256)).size !==
        KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT || !safeProvider(receipt.input.provider) ||
      receipt.entries.some((entry, index) => index > 0 &&
        receipt.entries[index - 1]!.caseBindingSha256.localeCompare(
          entry.caseBindingSha256
        ) >= 0) ||
      digestValues.some((digest) => !sha256Value(digest)) ||
      receipt.entries.some((entry) => !Number.isSafeInteger(entry.viewerCount) ||
        entry.viewerCount < 1 || entry.viewerCount > 8 ||
        entry.providerEvidenceReceiptSha256 === entry.persistedEvidenceReceiptSha256 ||
        entry.providerSourceLocalSha256 !== entry.persistedSourceLocalSha256 ||
        entry.sourceLocalEquivalenceSha256 !== entry.providerSourceLocalSha256 ||
        entry.providerViewerSetSha256 !== entry.persistedViewerSetSha256 ||
        entry.viewerSetSha256 !== entry.providerViewerSetSha256) ||
      receipt.viewerCount !== receipt.entries.reduce((total, entry) =>
        total + entry.viewerCount, 0) ||
      receipt.execution.callerSuppliedProvenanceAccepted !== false ||
      receipt.execution.directPersonalSources !== true ||
      receipt.execution.disposableDatabaseRequired !== true ||
      receipt.execution.productionCitationResolverUsed !== true ||
      receipt.execution.productionGroundingSettlementUsed !== true ||
      receipt.execution.productionReceiptPersistenceUsed !== true ||
      receipt.execution.resolverIsolationLevel !== "RepeatableRead" ||
      receipt.gates.citationViewerPersistedRouteGatePassed !== true ||
      receipt.gates.fullProductionReleaseEligible !== false ||
      receipt.gates.independentHumanReviewCompleted !== false ||
      receipt.privateContentIncluded !== false ||
      canonicalSha256(receiptBody(receipt)) !== receipt.executionReceiptSha256) {
      fail("knowledge_provider_answer_persisted_route_receipt_invalid");
    }
  } catch (error) {
    if (error instanceof ProviderAnswerPersistedRouteError) throw error;
    fail("knowledge_provider_answer_persisted_route_receipt_invalid");
  }
}

function mappingEntryBody(entry: CompleteMappingEntry): Omit<
  CompleteMappingEntry,
  "outputSha256"
> {
  const { outputSha256: _outputSha256, ...body } = entry;
  return body;
}

function packetItemInvariant(
  item: ProviderAnswerReviewPacket["items"][number]
): Omit<
  ProviderAnswerReviewPacket["items"][number],
  "citationViewerArtifacts" | "outputSha256"
> {
  const {
    citationViewerArtifacts: _citationViewerArtifacts,
    outputSha256: _outputSha256,
    ...invariant
  } = item;
  return invariant;
}

function expectedCaptureReport(
  receipt: ProviderAnswerPersistedRouteReceipt
): ProviderAnswerPersistedRouteReport {
  return deepFreeze({
    aggregateOnly: true,
    caseCount: KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT,
    citationViewerPersistedRouteGatePassed: true,
    executionReceiptSha256: receipt.executionReceiptSha256,
    fullProductionReleaseEligible: false,
    inputOutputFreezeSha256: {
      input: receipt.input.outputFreezeSha256,
      output: receipt.output.outputFreezeSha256
    },
    privateContentIncluded: false,
    provider: receipt.input.provider,
    viewerCount: receipt.viewerCount
  });
}

/**
 * Verifies the complete promotion proof boundary rather than trusting a
 * caller-supplied provenance label or a self-consistent receipt in isolation.
 * The persisted Evidence receipt itself is intentionally content-free and is
 * therefore bound here as an opaque production result; every derivable input,
 * output, source-local, viewer, case, and current-code binding is recomputed.
 */
export async function assertProviderAnswerPersistedRouteProof(input: Readonly<{
  inputArtifacts: ProviderAnswerArtifactChain;
  outputArtifacts: ProviderAnswerArtifactChain;
  receipt: unknown;
}>): Promise<void> {
  try {
    assertProviderAnswerReviewArtifactChain(input.inputArtifacts);
    assertProviderAnswerReviewArtifactChain(input.outputArtifacts);
    assertProviderAnswerPersistedRouteReceipt(input.receipt);
    const receipt = input.receipt;
    const currentCodeDigests = await providerAnswerPersistedRouteCodeDigests();
    const selectedInputArtifacts = selectedProviderArtifactChain(
      input.inputArtifacts,
      receipt.input.provider
    );
    if (canonicalJson(currentCodeDigests) !== canonicalJson(receipt.codeDigests) ||
      receipt.input.mappingSha256 !== selectedInputArtifacts.mapping.mappingSha256 ||
      receipt.input.outputFreezeSha256 !== selectedInputArtifacts.freeze.freezeSha256 ||
      receipt.input.packetSha256 !== selectedInputArtifacts.packet.packetSha256 ||
      receipt.output.mappingSha256 !== input.outputArtifacts.mapping.mappingSha256 ||
      receipt.output.outputFreezeSha256 !== input.outputArtifacts.freeze.freezeSha256 ||
      receipt.output.packetSha256 !== input.outputArtifacts.packet.packetSha256) {
      fail("knowledge_provider_answer_persisted_route_receipt_invalid");
    }

    const inputEntries = selectedProviderEntries(
      selectedInputArtifacts,
      receipt.input.provider
    );
    const outputEntries = selectedProviderEntries(
      input.outputArtifacts,
      receipt.input.provider
    );
    if (inputEntries.length !== KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT ||
      outputEntries.length !== KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT ||
      input.outputArtifacts.mapping.entries.length !== KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT ||
      input.outputArtifacts.packet.items.length !== KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT ||
      input.outputArtifacts.freeze.outputCount !== KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT ||
      input.outputArtifacts.mapping.entries.some((entry) =>
        entry.status !== "complete" || entry.provider !== receipt.input.provider)) {
      fail("knowledge_provider_answer_persisted_route_receipt_invalid");
    }

    const cases = new Map(providerAnswerEvalCases().map((candidate) => [
      candidate.id,
      candidate
    ]));
    const outputByCase = new Map(outputEntries.map((entry) => [entry.caseId, entry]));
    const receiptByBinding = new Map(receipt.entries.map((entry) => [
      entry.caseBindingSha256,
      entry
    ]));
    let viewerCount = 0;
    for (const inputEntry of inputEntries) {
      const outputEntry = outputByCase.get(inputEntry.caseId);
      const caseDefinition = cases.get(inputEntry.caseId);
      if (!outputEntry || !caseDefinition ||
        canonicalJson(mappingEntryBody(inputEntry)) !==
          canonicalJson(mappingEntryBody(outputEntry))) {
        fail("knowledge_provider_answer_persisted_route_receipt_invalid");
      }
      const inputItem = providerPacketItem(selectedInputArtifacts, inputEntry);
      const outputItem = providerPacketItem(input.outputArtifacts, outputEntry);
      if (canonicalJson(packetItemInvariant(inputItem)) !==
          canonicalJson(packetItemInvariant(outputItem)) ||
        inputItem.evidenceReceiptSha256 !==
          knowledgeEvidenceReceiptHash(caseDefinition.evidence) ||
        inputItem.language !== caseDefinition.language ||
        inputItem.query !== caseDefinition.query ||
        canonicalJson(inputItem.reviewDimensions) !==
          canonicalJson(caseDefinition.reviewDimensions)) {
        fail("knowledge_provider_answer_persisted_route_receipt_invalid");
      }

      const caseBindingSha256 = canonicalSha256({
        inputFreezeSha256: selectedInputArtifacts.freeze.freezeSha256,
        provider: receipt.input.provider,
        reviewId: inputEntry.reviewId
      });
      const caseReceipt = receiptByBinding.get(caseBindingSha256);
      if (!caseReceipt || caseReceipt.caseBindingSha256 !== caseBindingSha256) {
        fail("knowledge_provider_answer_persisted_route_receipt_invalid");
      }
      const providerSourceLocal = packetSourceLocalProjection(
        inputItem,
        "synthetic_projection"
      );
      const persistedSourceLocal = packetSourceLocalProjection(
        outputItem,
        "persisted_route"
      );
      const providerViewers = inputItem.citationViewerArtifacts.map(({ viewer }) => viewer);
      const persistedViewers = outputItem.citationViewerArtifacts.map(({ viewer }) => viewer);
      const providerSourceLocalSha256 = canonicalSha256(providerSourceLocal);
      const persistedSourceLocalSha256 = canonicalSha256(persistedSourceLocal);
      const providerViewerSetSha256 = canonicalSha256(providerViewers);
      const persistedViewerSetSha256 = canonicalSha256(persistedViewers);
      if (canonicalJson(providerSourceLocal) !== canonicalJson(persistedSourceLocal) ||
        canonicalJson(providerViewers) !== canonicalJson(persistedViewers) ||
        caseReceipt.providerEvidenceReceiptSha256 !== inputItem.evidenceReceiptSha256 ||
        caseReceipt.persistedEvidenceReceiptSha256 === inputItem.evidenceReceiptSha256 ||
        caseReceipt.providerSourceLocalSha256 !== providerSourceLocalSha256 ||
        caseReceipt.persistedSourceLocalSha256 !== persistedSourceLocalSha256 ||
        caseReceipt.sourceLocalEquivalenceSha256 !== providerSourceLocalSha256 ||
        caseReceipt.providerViewerSetSha256 !== providerViewerSetSha256 ||
        caseReceipt.persistedViewerSetSha256 !== persistedViewerSetSha256 ||
        caseReceipt.viewerSetSha256 !== providerViewerSetSha256 ||
        caseReceipt.viewerCount !== providerViewers.length) {
        fail("knowledge_provider_answer_persisted_route_receipt_invalid");
      }
      viewerCount += providerViewers.length;
    }
    if (receiptByBinding.size !== KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT ||
      viewerCount !== receipt.viewerCount) {
      fail("knowledge_provider_answer_persisted_route_receipt_invalid");
    }
  } catch (error) {
    if (error instanceof ProviderAnswerPersistedRouteError &&
      error.code === "knowledge_provider_answer_persisted_route_digest_failed") {
      throw error;
    }
    fail("knowledge_provider_answer_persisted_route_receipt_invalid");
  }
}

function providerPacketItem(
  chain: ProviderAnswerArtifactChain,
  entry: CompleteMappingEntry
): ProviderAnswerReviewPacket["items"][number] {
  const item = chain.packet.items.find((candidate) => candidate.reviewId === entry.reviewId);
  if (!item || item.outputSha256 !== entry.outputSha256) {
    fail("knowledge_provider_answer_persisted_route_artifact_invalid");
  }
  return item;
}

export async function captureProviderAnswerPersistedRoute(input: Readonly<{
  artifacts: ProviderAnswerArtifactChain;
  client: PrismaClient;
  provider: SelectedProvider;
  storage: StorageAdapter;
}>): Promise<ProviderAnswerPersistedRouteCapture> {
  try {
    assertDisposableStatefulTestTarget(process.env);
  } catch {
    fail("knowledge_provider_answer_persisted_route_database_unsafe");
  }
  try {
    assertProviderAnswerReviewArtifactChain(input.artifacts);
  } catch {
    fail("knowledge_provider_answer_persisted_route_artifact_invalid");
  }
  const selectedInputArtifacts = selectedProviderArtifactChain(
    input.artifacts,
    input.provider
  );
  const entries = selectedProviderEntries(selectedInputArtifacts, input.provider);
  const cases = new Map(providerAnswerEvalCases().map((candidate) => [candidate.id, candidate]));
  const profile = providerAnswerEvalProfiles().find((candidate) =>
    candidate.provider === input.provider) ??
    fail("knowledge_provider_answer_persisted_route_incomplete_provider");
  await ensurePersistedRouteProfile(input.client);
  const captured: Array<Readonly<{
    mapping: CompleteMappingEntry;
    packet: ProviderAnswerReviewPacket["items"][number];
    persisted: PersistedCaseCapture;
    providerSourceLocalSha256: string;
    providerViewerSetSha256: string;
  }>> = [];
  for (const entry of entries) {
    const caseDefinition = cases.get(entry.caseId) ??
      fail("knowledge_provider_answer_persisted_route_artifact_invalid");
    const packet = providerPacketItem(selectedInputArtifacts, entry);
    if (packet.evidenceReceiptSha256 !== knowledgeEvidenceReceiptHash(caseDefinition.evidence) ||
      packet.language !== caseDefinition.language || packet.query !== caseDefinition.query) {
      fail("knowledge_provider_answer_persisted_route_artifact_invalid");
    }
    const providerSourceLocalSha256 = canonicalSha256(packetSourceLocalProjection(packet));
    const providerViewerSetSha256 = canonicalSha256(
      packet.citationViewerArtifacts.map(({ viewer }) => viewer)
    );
    const persisted = await capturePersistedCase({
      answer: packet.answer,
      caseDefinition,
      client: input.client,
      item: packet,
      profile,
      storage: input.storage
    });
    if (persisted.sourceLocalSha256 !== providerSourceLocalSha256 ||
      persisted.viewerSetSha256 !== providerViewerSetSha256) {
      fail("knowledge_provider_answer_persisted_route_capture_failed");
    }
    captured.push(Object.freeze({
      mapping: entry,
      packet,
      persisted,
      providerSourceLocalSha256,
      providerViewerSetSha256
    }));
  }
  const persistedArtifacts = createPersistedProviderAnswerReviewArtifacts({
    completed: captured.map(({ mapping, packet, persisted }) => ({
      answer: packet.answer,
      automatedGrounding: mapping.automatedGrounding,
      caseDefinition: persisted.caseDefinition,
      citationViewerArtifacts: persisted.viewerArtifacts,
      grounding: persisted.grounding,
      latencyMs: mapping.latencyMs,
      profile,
      reviewId: mapping.reviewId,
      usage: mapping.usage
    })),
    randomIndex: (maximum) => maximum - 1
  });
  const codeDigests = await providerAnswerPersistedRouteCodeDigests();
  const receiptEntries = Object.freeze(captured.map((capture): ContentFreeCaseReceipt => {
    const viewerCount = capture.persisted.viewerArtifacts.length;
    return Object.freeze({
      caseBindingSha256: canonicalSha256({
        inputFreezeSha256: selectedInputArtifacts.freeze.freezeSha256,
        provider: input.provider,
        reviewId: capture.mapping.reviewId
      }),
      persistedEvidenceReceiptSha256: capture.persisted.evidenceReceiptSha256,
      persistedSourceLocalSha256: capture.persisted.sourceLocalSha256,
      persistedViewerSetSha256: capture.persisted.viewerSetSha256,
      providerEvidenceReceiptSha256: capture.packet.evidenceReceiptSha256,
      providerSourceLocalSha256: capture.providerSourceLocalSha256,
      providerViewerSetSha256: capture.providerViewerSetSha256,
      sourceLocalEquivalenceSha256: capture.providerSourceLocalSha256,
      viewerCount,
      viewerSetSha256: capture.providerViewerSetSha256
    });
  }).sort((left, right) => left.caseBindingSha256.localeCompare(right.caseBindingSha256)));
  const body: Omit<ProviderAnswerPersistedRouteReceipt, "executionReceiptSha256"> = {
    artifactType: "knowledge_answer_persisted_route_receipt",
    artifactVersion: KNOWLEDGE_PROVIDER_ANSWER_PERSISTED_ROUTE_VERSION,
    caseCount: KNOWLEDGE_PROVIDER_ANSWER_CASE_COUNT,
    codeDigests,
    entries: receiptEntries,
    execution: {
      callerSuppliedProvenanceAccepted: false,
      directPersonalSources: true,
      disposableDatabaseRequired: true,
      productionCitationResolverUsed: true,
      productionGroundingSettlementUsed: true,
      productionReceiptPersistenceUsed: true,
      resolverIsolationLevel: "RepeatableRead"
    },
    gates: {
      citationViewerPersistedRouteGatePassed: true,
      fullProductionReleaseEligible: false,
      independentHumanReviewCompleted: false
    },
    input: {
      mappingSha256: selectedInputArtifacts.mapping.mappingSha256,
      outputFreezeSha256: selectedInputArtifacts.freeze.freezeSha256,
      packetSha256: selectedInputArtifacts.packet.packetSha256,
      provider: input.provider
    },
    output: {
      mappingSha256: persistedArtifacts.mapping.mappingSha256,
      outputFreezeSha256: persistedArtifacts.freeze.freezeSha256,
      packetSha256: persistedArtifacts.packet.packetSha256
    },
    privateContentIncluded: false,
    viewerCount: receiptEntries.reduce((total, entry) => total + entry.viewerCount, 0)
  };
  const receipt: ProviderAnswerPersistedRouteReceipt = deepFreeze({
    ...body,
    executionReceiptSha256: canonicalSha256(body)
  });
  assertProviderAnswerPersistedRouteReceipt(receipt);
  const report = expectedCaptureReport(receipt);
  await assertProviderAnswerPersistedRouteProof({
    inputArtifacts: selectedInputArtifacts,
    outputArtifacts: persistedArtifacts,
    receipt
  });
  const promotion: ValidatedProviderAnswerPersistedRoutePromotion = Object.freeze({
    receipt,
    report
  });
  validatedPromotions.add(promotion);
  const capture: ProviderAnswerPersistedRouteCapture = Object.freeze({
    artifacts: persistedArtifacts,
    inputArtifacts: selectedInputArtifacts,
    promotion,
    receipt,
    report
  });
  issuedCaptures.add(capture);
  return capture;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await chmod(path, 0o600);
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o777) !== 0o600) {
      fail("knowledge_provider_answer_persisted_route_write_failed");
    }
  } catch (error) {
    if (error instanceof ProviderAnswerPersistedRouteError) throw error;
    fail("knowledge_provider_answer_persisted_route_write_failed");
  }
}

export async function writeProviderAnswerPersistedRouteCapture(input: Readonly<{
  capture: ProviderAnswerPersistedRouteCapture;
  outputReviewDirectory: string;
  promotionDirectory: string;
}>): Promise<void> {
  try {
    await validateProviderAnswerReviewDirectory(input.outputReviewDirectory);
  } catch {
    fail("knowledge_provider_answer_persisted_route_directory_invalid");
  }
  await assertPrivatePromotionDirectory(input.promotionDirectory, []);
  await assertProviderAnswerPersistedRouteProof({
    inputArtifacts: input.capture.inputArtifacts,
    outputArtifacts: input.capture.artifacts,
    receipt: input.capture.receipt
  });
  if (!issuedCaptures.has(input.capture) ||
    input.capture.promotion.receipt !== input.capture.receipt ||
    input.capture.promotion.report !== input.capture.report ||
    validatedProviderAnswerPersistedRouteReceiptSha256(input.capture.promotion) !==
      input.capture.receipt.executionReceiptSha256 ||
    canonicalJson(input.capture.report) !==
      canonicalJson(expectedCaptureReport(input.capture.receipt))) {
    fail("knowledge_provider_answer_persisted_route_receipt_invalid");
  }
  await writeProviderAnswerReviewArtifacts({
    ...input.capture.artifacts,
    reviewDirectory: input.outputReviewDirectory
  });
  await writePrivateJson(
    resolve(
      input.promotionDirectory,
      KNOWLEDGE_PROVIDER_ANSWER_PERSISTED_ROUTE_RECEIPT_FILE
    ),
    input.capture.receipt
  );
  const writtenOutput = await readProviderAnswerArtifactDirectory(
    input.outputReviewDirectory
  );
  await readProviderAnswerPersistedRouteAudit({
    inputArtifacts: input.capture.inputArtifacts,
    outputArtifacts: writtenOutput,
    promotionDirectory: input.promotionDirectory
  });
}

export type ValidatedProviderAnswerPersistedRouteBinding = Readonly<{
  mappingSha256: string;
  outputFreezeSha256: string;
  packetSha256: string;
  receiptSha256: string;
}>;

export function validatedProviderAnswerPersistedRouteBinding(
  promotion: unknown
): ValidatedProviderAnswerPersistedRouteBinding {
  if (!record(promotion) || !validatedPromotions.has(promotion) ||
    !record(promotion.receipt) || !record(promotion.report)) {
    fail("knowledge_provider_answer_persisted_route_receipt_invalid");
  }
  assertProviderAnswerPersistedRouteReceipt(promotion.receipt);
  if (canonicalJson(promotion.report) !==
    canonicalJson(expectedCaptureReport(promotion.receipt))) {
    fail("knowledge_provider_answer_persisted_route_receipt_invalid");
  }
  return Object.freeze({
    mappingSha256: promotion.receipt.output.mappingSha256,
    outputFreezeSha256: promotion.receipt.output.outputFreezeSha256,
    packetSha256: promotion.receipt.output.packetSha256,
    receiptSha256: promotion.receipt.executionReceiptSha256
  });
}

export function validatedProviderAnswerPersistedRouteReceiptSha256(
  promotion: unknown
): string {
  return validatedProviderAnswerPersistedRouteBinding(promotion).receiptSha256;
}

/**
 * Reads a content-free audit sidecar after cross-checking it against both
 * artifact chains and the current implementation. Disk evidence is never a
 * live execution authority and this result cannot be promoted into release
 * trust eligibility.
 */
export async function readProviderAnswerPersistedRouteAudit(input: Readonly<{
  inputArtifacts: ProviderAnswerArtifactChain;
  outputArtifacts: ProviderAnswerArtifactChain;
  promotionDirectory: string;
}>): Promise<ProviderAnswerPersistedRouteAudit> {
  await assertPrivatePromotionDirectory(
    input.promotionDirectory,
    promotionArtifactFiles
  );
  const receipt = await readPrivateJson(
    input.promotionDirectory,
    KNOWLEDGE_PROVIDER_ANSWER_PERSISTED_ROUTE_RECEIPT_FILE
  );
  await assertProviderAnswerPersistedRouteProof({
    inputArtifacts: input.inputArtifacts,
    outputArtifacts: input.outputArtifacts,
    receipt
  });
  assertProviderAnswerPersistedRouteReceipt(receipt);
  return Object.freeze({
    receipt,
    releaseTrustEligible: false as const,
    report: expectedCaptureReport(receipt)
  });
}

/**
 * Convenience reader for the pre-human-review handoff, where both review
 * directories still contain exactly the three standard review artifacts.
 */
export async function readProviderAnswerPersistedRouteProof(input: Readonly<{
  inputReviewDirectory: string;
  outputReviewDirectory: string;
  promotionDirectory: string;
}>): Promise<ProviderAnswerPersistedRouteAudit> {
  if (new Set([
    input.inputReviewDirectory,
    input.outputReviewDirectory,
    input.promotionDirectory
  ]).size !== 3) {
    fail("knowledge_provider_answer_persisted_route_directory_invalid");
  }
  const [inputArtifacts, outputArtifacts] = await Promise.all([
    readProviderAnswerArtifactDirectory(input.inputReviewDirectory),
    readProviderAnswerArtifactDirectory(input.outputReviewDirectory)
  ]);
  return readProviderAnswerPersistedRouteAudit({
    inputArtifacts,
    outputArtifacts,
    promotionDirectory: input.promotionDirectory
  });
}
