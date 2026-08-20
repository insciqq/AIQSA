import { chmod, lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import {
  assertKnowledgeSemanticGroundingBenchmarkContract,
  runCurrentFenceSemanticGroundingBenchmark
} from "./semanticGrounding";
import {
  assertKnowledgeSemanticFinalArtifactFreezeChain,
  assertKnowledgeSemanticCandidateBenchmarkContract,
  runKnowledgeSemanticCalibrationFreeze,
  runKnowledgeSemanticFinalPredictionFreeze,
  runKnowledgeSemanticCandidateBenchmark,
  type KnowledgeSemanticCalibrationFreezeManifest,
  type KnowledgeSemanticCandidateBenchmarkReport,
  type KnowledgeSemanticFinalArtifactFreezeChain,
  type KnowledgeSemanticFinalPredictionFreezeManifest
} from "./semanticGroundingBenchmark";
import {
  assertKnowledgeSemanticCandidateFreezeArtifact,
  assertKnowledgeSemanticCandidateFreezeManifest,
  createKnowledgeSemanticCandidateFreezeManifest,
  createKnowledgeSemanticGroundingCandidatePool,
  createKnowledgeSemanticGroundingCandidates,
  type KnowledgeSemanticCandidateFreezeManifest
} from "./semanticGroundingCandidates";
import {
  createLocalSemanticGroundingExecutor,
  resolveSystemModelSemanticGroundingExecutor
} from "./semanticGroundingRunners";
import {
  KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_MAPPING_FILE,
  KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_PACKET_FILE,
  readKnowledgeSemanticGroundingReviewEvidenceDirectory,
  writeKnowledgeSemanticGroundingReviewArtifacts,
  type KnowledgeSemanticGroundingReviewScope
} from "./semanticGroundingReview";
import {
  KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION,
  knowledgeSemanticGroundingFixtures
} from "./semanticGroundingFixtures";

export type KnowledgeSemanticReviewPreparationReport = Readonly<{
  aggregateOnly: true;
  claimCount: number;
  corpusSha256: string;
  filesCreated: readonly [
    typeof KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_PACKET_FILE,
    typeof KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_MAPPING_FILE
  ];
  humanReviewPending: true;
  poolSha256: string;
  reviewScope: KnowledgeSemanticGroundingReviewScope;
  selectionEligible: false;
  version: "knowledge-semantic-review-preparation-v1";
}>;

export type KnowledgeSemanticFreezePreparationReport = Readonly<{
  aggregateOnly: true;
  artifactCreated: "freeze-manifest.json";
  candidateCount: 4;
  candidateSetDigest: string;
  corpusSha256: string;
  externalExecutionPerformed: false;
  labelsUsed: false;
  manifestSha256: string;
  poolSha256: string;
  selectionEligible: false;
  semanticProof: false;
  thresholdScheduleSha256: string;
  version: "knowledge-semantic-freeze-preparation-v1";
}>;

export type KnowledgeSemanticCalibrationFreezePreparationReport = Readonly<{
  aggregateOnly: true;
  artifactCreated: "calibration-freeze.json";
  calibrationLabelSha256: string;
  candidateCount: 4;
  candidateFreezeManifestSha256: string;
  externalExecutionScope: "calibration_split_only";
  labelsStored: false;
  manifestSha256: string;
  selectionEligible: false;
  semanticProof: false;
  version: "knowledge-semantic-calibration-freeze-preparation-v1";
}>;

export type KnowledgeSemanticFinalPredictionFreezePreparationReport = Readonly<{
  aggregateOnly: true;
  artifactCreated: "final-prediction-freeze.json";
  candidateCount: 4;
  candidateFreezeManifestSha256: string;
  calibrationFreezeManifestSha256: string;
  externalExecutionScope: "development_held_out_blinded_without_labels";
  labelsStored: false;
  manifestSha256: string;
  selectionEligible: false;
  semanticProof: false;
  version: "knowledge-semantic-final-prediction-freeze-preparation-v1";
}>;

export type KnowledgeSemanticGroundingCliOptions = Readonly<{
  calibrationFreezePath: string | null;
  finalPredictionFreezePath: string | null;
  executePaidSystemModel: boolean;
  freezeManifestPath: string | null;
  help: boolean;
  localRunnerConfigPath: string | null;
  prepareReviewDirectory: string | null;
  prepareReviewScope: KnowledgeSemanticGroundingReviewScope | null;
  reviewDirectory: string | null;
  trustAnchorSetPath: string | null;
  trustAnchorSetSha256: string | null;
  writeCalibrationFreezePath: string | null;
  writeFinalPredictionFreezePath: string | null;
  writeFreezeManifestPath: string | null;
}>;

export const KNOWLEDGE_SEMANTIC_GROUNDING_CLI_USAGE = [
  "Usage: npm run eval:knowledge:semantic-grounding -- [options]",
  "",
  "  --local-runner-config <absolute-json-path>",
  "      Execute the loopback-only, credential-free multilingual NLI runner protocol.",
  "  --execute-paid-system-model",
  "      Execute the exact admitted installation System Model strict-output role.",
  "      The frozen corpus makes at most one sequential call per claim; no fallback runs.",
  "  --review-directory <absolute-/tmp-path>",
  "      Import two external-human submissions plus completed adjudication from owner-only files.",
  "      The directory may contain human-trust-evidence.json, never the trust-anchor root.",
  "  --trust-anchor-set <absolute-/tmp-file>",
  "      Read the separately controlled owner-only trust-anchors.json for final scoring.",
  "  --trust-anchor-set-sha256 <64-lowercase-hex>",
  "      Require the independently supplied exact digest pin for that anchor set.",
  "  --freeze-manifest <absolute-/tmp-file>",
  "      Validate an owner-only pre-evaluation freeze before importing labels or scoring.",
  "  --write-freeze-manifest <absolute-/tmp-file>",
  "      Write a new owner-only identity freeze and stop before any label scoring.",
  "  --write-calibration-freeze <absolute-/tmp-file>",
  "      Run only calibration claims and freeze exact outputs/selected thresholds, then stop.",
  "  --calibration-freeze <absolute-/tmp-file>",
  "      Validate the calibration artifact and run non-calibration scoring with frozen thresholds.",
  "  --write-final-prediction-freeze <absolute-/tmp-file>",
  "      Execute frozen candidates on development/held-out/blinded claims without labels.",
  "  --final-prediction-freeze <absolute-/tmp-file>",
  "      Validate the label-free prediction artifact before importing review labels.",
  "  --prepare-review-directory <absolute-empty-/tmp-path>",
  "      Write a blind owner-only packet and private mapping, then stop before human review.",
  "  --review-scope <calibration|final>",
  "      Calibration binds only the identity freeze; final requires frozen non-label predictions.",
  "  --help",
  "",
  "External execution requires current operator authorization under agent_docs/TESTING.md.",
  "Preparing/importing artifacts never authors, simulates, or accepts human judgments."
].join("\n");

const FREEZE_DIRECTORY_PATTERN =
  /^aiqsa-knowledge-semantic-freeze-[A-Za-z0-9_-]{6,64}$/u;
const FREEZE_MANIFEST_FILE = "freeze-manifest.json" as const;
const CALIBRATION_FREEZE_FILE = "calibration-freeze.json" as const;
const FINAL_PREDICTION_FREEZE_FILE = "final-prediction-freeze.json" as const;
const FREEZE_MANIFEST_MAX_BYTES = 128 * 1024;
const FINAL_PREDICTION_FREEZE_MAX_BYTES = 2 * 1024 * 1024;
const TRUST_DIRECTORY_PATTERN =
  /^aiqsa-knowledge-semantic-trust-[A-Za-z0-9_-]{6,64}$/u;
const TRUST_ANCHOR_SET_FILE = "trust-anchors.json" as const;
const TRUST_ANCHOR_SET_MAX_BYTES = 128 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function assertAbsoluteCliPath(value: string): string {
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new Error("knowledge_semantic_cli_path_invalid");
  }
  return value;
}

async function readPrivateTrustAnchorSet(path: string): Promise<unknown> {
  const directory = dirname(path);
  if (dirname(directory) !== "/tmp" ||
    !TRUST_DIRECTORY_PATTERN.test(basename(directory)) ||
    basename(path) !== TRUST_ANCHOR_SET_FILE) {
    throw new Error("knowledge_semantic_trust_anchor_path_invalid");
  }
  let directoryDetails: Awaited<ReturnType<typeof lstat>>;
  let fileDetails: Awaited<ReturnType<typeof lstat>>;
  let canonicalDirectory: string;
  let canonicalFile: string;
  try {
    [directoryDetails, fileDetails, canonicalDirectory, canonicalFile] = await Promise.all([
      lstat(directory),
      lstat(path),
      realpath(directory),
      realpath(path)
    ]);
  } catch {
    throw new Error("knowledge_semantic_trust_anchor_unavailable");
  }
  const processUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!directoryDetails.isDirectory() || directoryDetails.isSymbolicLink() ||
    canonicalDirectory !== directory || (directoryDetails.mode & 0o777) !== 0o700 ||
    processUid !== null && directoryDetails.uid !== processUid ||
    !fileDetails.isFile() || fileDetails.isSymbolicLink() || canonicalFile !== path ||
    fileDetails.size < 2 || fileDetails.size > TRUST_ANCHOR_SET_MAX_BYTES ||
    (fileDetails.mode & 0o777) !== 0o600 ||
    processUid !== null && fileDetails.uid !== processUid) {
    throw new Error("knowledge_semantic_trust_anchor_unsafe");
  }
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error("knowledge_semantic_trust_anchor_invalid");
  }
}

async function validateFreezeDirectory(
  path: string,
  requireEmpty: boolean,
  expectedFile: string = FREEZE_MANIFEST_FILE
): Promise<string> {
  const directory = dirname(path);
  if (directory === "/tmp" || dirname(directory) !== "/tmp" ||
    !FREEZE_DIRECTORY_PATTERN.test(basename(directory)) || basename(path) !== expectedFile) {
    throw new Error("knowledge_semantic_freeze_path_invalid");
  }
  let details: Awaited<ReturnType<typeof lstat>>;
  let canonical: string;
  let entries: string[];
  try {
    [details, canonical, entries] = await Promise.all([
      lstat(directory),
      realpath(directory),
      readdir(directory)
    ]);
  } catch {
    throw new Error("knowledge_semantic_freeze_directory_unavailable");
  }
  const processUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!details.isDirectory() || details.isSymbolicLink() || canonical !== directory ||
    (details.mode & 0o777) !== 0o700 || processUid !== null && details.uid !== processUid) {
    throw new Error("knowledge_semantic_freeze_directory_unsafe");
  }
  if (requireEmpty && entries.length !== 0) {
    throw new Error("knowledge_semantic_freeze_directory_not_empty");
  }
  return directory;
}

async function validatePrivateFreezeFile(
  path: string,
  expectedFile: string = FREEZE_MANIFEST_FILE,
  maxBytes: number = FREEZE_MANIFEST_MAX_BYTES
): Promise<string> {
  await validateFreezeDirectory(path, false, expectedFile);
  let details: Awaited<ReturnType<typeof lstat>>;
  let canonical: string;
  try {
    [details, canonical] = await Promise.all([lstat(path), realpath(path)]);
  } catch {
    throw new Error("knowledge_semantic_freeze_manifest_unavailable");
  }
  const processUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!details.isFile() || details.isSymbolicLink() || canonical !== path ||
    details.size < 2 || details.size > maxBytes ||
    (details.mode & 0o777) !== 0o600 || processUid !== null && details.uid !== processUid) {
    throw new Error("knowledge_semantic_freeze_manifest_unsafe");
  }
  return path;
}

async function writePrivateFreezeManifest(
  path: string,
  manifest: KnowledgeSemanticCandidateFreezeManifest
): Promise<void> {
  await validateFreezeDirectory(path, true);
  try {
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await chmod(path, 0o600);
  } catch {
    throw new Error("knowledge_semantic_freeze_manifest_write_failed");
  }
  await validatePrivateFreezeFile(path);
}

async function readPrivateFreezeManifest(path: string): Promise<unknown> {
  await validatePrivateFreezeFile(path);
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error("knowledge_semantic_freeze_manifest_invalid");
  }
}

async function writePrivateCalibrationFreeze(
  path: string,
  manifest: KnowledgeSemanticCalibrationFreezeManifest
): Promise<void> {
  await validateFreezeDirectory(path, false, CALIBRATION_FREEZE_FILE);
  try {
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await chmod(path, 0o600);
  } catch {
    throw new Error("knowledge_semantic_calibration_freeze_write_failed");
  }
  await validatePrivateFreezeFile(path, CALIBRATION_FREEZE_FILE);
}

async function readPrivateCalibrationFreeze(path: string): Promise<unknown> {
  await validatePrivateFreezeFile(path, CALIBRATION_FREEZE_FILE);
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error("knowledge_semantic_calibration_freeze_invalid");
  }
}

async function writePrivateFinalPredictionFreeze(
  path: string,
  manifest: KnowledgeSemanticFinalPredictionFreezeManifest
): Promise<void> {
  await validateFreezeDirectory(path, false, FINAL_PREDICTION_FREEZE_FILE);
  try {
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await chmod(path, 0o600);
  } catch {
    throw new Error("knowledge_semantic_final_prediction_freeze_write_failed");
  }
  await validatePrivateFreezeFile(path, FINAL_PREDICTION_FREEZE_FILE,
    FINAL_PREDICTION_FREEZE_MAX_BYTES);
}

async function readPrivateFinalPredictionFreeze(path: string): Promise<unknown> {
  await validatePrivateFreezeFile(path, FINAL_PREDICTION_FREEZE_FILE,
    FINAL_PREDICTION_FREEZE_MAX_BYTES);
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error("knowledge_semantic_final_prediction_freeze_invalid");
  }
}

export function parseKnowledgeSemanticGroundingCliArgs(
  args: readonly string[]
): KnowledgeSemanticGroundingCliOptions {
  let calibrationFreezePath: string | null = null;
  let finalPredictionFreezePath: string | null = null;
  let executePaidSystemModel = false;
  let freezeManifestPath: string | null = null;
  let help = false;
  let localRunnerConfigPath: string | null = null;
  let prepareReviewDirectory: string | null = null;
  let prepareReviewScope: KnowledgeSemanticGroundingReviewScope | null = null;
  let reviewDirectory: string | null = null;
  let trustAnchorSetPath: string | null = null;
  let trustAnchorSetSha256: string | null = null;
  let writeCalibrationFreezePath: string | null = null;
  let writeFinalPredictionFreezePath: string | null = null;
  let writeFreezeManifestPath: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--execute-paid-system-model") {
      if (executePaidSystemModel) throw new Error("knowledge_semantic_cli_argument_duplicate");
      executePaidSystemModel = true;
    } else if (argument === "--help") {
      help = true;
    } else if (argument === "--review-scope") {
      const value = args[index + 1];
      if (value !== "calibration" && value !== "final") {
        throw new Error("knowledge_semantic_cli_review_scope_invalid");
      }
      if (prepareReviewScope !== null) {
        throw new Error("knowledge_semantic_cli_argument_duplicate");
      }
      prepareReviewScope = value;
      index += 1;
    } else if (argument === "--trust-anchor-set-sha256") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("knowledge_semantic_cli_argument_missing");
      }
      if (trustAnchorSetSha256 !== null) {
        throw new Error("knowledge_semantic_cli_argument_duplicate");
      }
      if (!SHA256_PATTERN.test(value)) {
        throw new Error("knowledge_semantic_cli_trust_anchor_pin_invalid");
      }
      trustAnchorSetSha256 = value;
      index += 1;
    } else if (argument === "--local-runner-config" ||
      argument === "--review-directory" ||
      argument === "--trust-anchor-set" ||
      argument === "--prepare-review-directory" ||
      argument === "--freeze-manifest" ||
      argument === "--calibration-freeze" ||
      argument === "--write-calibration-freeze" ||
      argument === "--final-prediction-freeze" ||
      argument === "--write-final-prediction-freeze" ||
      argument === "--write-freeze-manifest") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("knowledge_semantic_cli_argument_missing");
      }
      assertAbsoluteCliPath(value);
      if (argument === "--local-runner-config") {
        if (localRunnerConfigPath !== null) {
          throw new Error("knowledge_semantic_cli_argument_duplicate");
        }
        localRunnerConfigPath = value;
      } else if (argument === "--review-directory") {
        if (reviewDirectory !== null) throw new Error("knowledge_semantic_cli_argument_duplicate");
        reviewDirectory = value;
      } else if (argument === "--trust-anchor-set") {
        if (trustAnchorSetPath !== null) {
          throw new Error("knowledge_semantic_cli_argument_duplicate");
        }
        trustAnchorSetPath = value;
      } else if (argument === "--prepare-review-directory") {
        if (prepareReviewDirectory !== null) {
          throw new Error("knowledge_semantic_cli_argument_duplicate");
        }
        prepareReviewDirectory = value;
      } else if (argument === "--freeze-manifest") {
        if (freezeManifestPath !== null) throw new Error("knowledge_semantic_cli_argument_duplicate");
        freezeManifestPath = value;
      } else if (argument === "--calibration-freeze") {
        if (calibrationFreezePath !== null) {
          throw new Error("knowledge_semantic_cli_argument_duplicate");
        }
        calibrationFreezePath = value;
      } else if (argument === "--write-calibration-freeze") {
        if (writeCalibrationFreezePath !== null) {
          throw new Error("knowledge_semantic_cli_argument_duplicate");
        }
        writeCalibrationFreezePath = value;
      } else if (argument === "--final-prediction-freeze") {
        if (finalPredictionFreezePath !== null) {
          throw new Error("knowledge_semantic_cli_argument_duplicate");
        }
        finalPredictionFreezePath = value;
      } else if (argument === "--write-final-prediction-freeze") {
        if (writeFinalPredictionFreezePath !== null) {
          throw new Error("knowledge_semantic_cli_argument_duplicate");
        }
        writeFinalPredictionFreezePath = value;
      } else {
        if (writeFreezeManifestPath !== null) {
          throw new Error("knowledge_semantic_cli_argument_duplicate");
        }
        writeFreezeManifestPath = value;
      }
      index += 1;
    } else {
      throw new Error("knowledge_semantic_cli_argument_invalid");
    }
  }
  if (freezeManifestPath && writeFreezeManifestPath ||
    calibrationFreezePath && writeCalibrationFreezePath ||
    finalPredictionFreezePath && writeFinalPredictionFreezePath) {
    throw new Error("knowledge_semantic_cli_argument_conflict");
  }
  if (Boolean(trustAnchorSetPath) !== Boolean(trustAnchorSetSha256)) {
    throw new Error("knowledge_semantic_cli_trust_anchor_pair_required");
  }
  if (trustAnchorSetPath && (!reviewDirectory || !freezeManifestPath ||
    !calibrationFreezePath || !finalPredictionFreezePath || writeFreezeManifestPath ||
    writeCalibrationFreezePath || writeFinalPredictionFreezePath || prepareReviewDirectory)) {
    throw new Error("knowledge_semantic_cli_trust_anchor_purpose_invalid");
  }
  if (writeFreezeManifestPath && (reviewDirectory || calibrationFreezePath ||
    writeCalibrationFreezePath || finalPredictionFreezePath || writeFinalPredictionFreezePath)) {
    throw new Error("knowledge_semantic_cli_argument_conflict");
  }
  if (reviewDirectory && !freezeManifestPath) {
    throw new Error("knowledge_semantic_cli_freeze_manifest_required");
  }
  if (reviewDirectory && !calibrationFreezePath && !writeCalibrationFreezePath) {
    throw new Error("knowledge_semantic_cli_calibration_freeze_required");
  }
  if (reviewDirectory && !writeCalibrationFreezePath && !finalPredictionFreezePath) {
    throw new Error("knowledge_semantic_final_prediction_freeze_required");
  }
  if (writeCalibrationFreezePath && (!freezeManifestPath || !reviewDirectory)) {
    throw new Error("knowledge_semantic_cli_argument_conflict");
  }
  if (calibrationFreezePath && !freezeManifestPath) {
    throw new Error("knowledge_semantic_cli_argument_conflict");
  }
  if (writeFinalPredictionFreezePath &&
    (!freezeManifestPath || !calibrationFreezePath || reviewDirectory ||
      writeCalibrationFreezePath)) {
    throw new Error("knowledge_semantic_cli_argument_conflict");
  }
  if (finalPredictionFreezePath && (!freezeManifestPath || !calibrationFreezePath)) {
    throw new Error("knowledge_semantic_cli_argument_conflict");
  }
  if (Boolean(prepareReviewDirectory) !== Boolean(prepareReviewScope)) {
    throw new Error("knowledge_semantic_cli_review_scope_required");
  }
  if (prepareReviewDirectory && (reviewDirectory || localRunnerConfigPath ||
    executePaidSystemModel || writeFreezeManifestPath || writeCalibrationFreezePath ||
    writeFinalPredictionFreezePath || trustAnchorSetPath || trustAnchorSetSha256)) {
    throw new Error("knowledge_semantic_cli_argument_conflict");
  }
  if ((prepareReviewScope === "calibration" &&
      (!freezeManifestPath || calibrationFreezePath || finalPredictionFreezePath)) ||
    (prepareReviewScope === "final" &&
      (!freezeManifestPath || !calibrationFreezePath || !finalPredictionFreezePath))) {
    throw new Error("knowledge_semantic_cli_review_stage_invalid");
  }
  return Object.freeze({
    calibrationFreezePath,
    finalPredictionFreezePath,
    executePaidSystemModel,
    freezeManifestPath,
    help,
    localRunnerConfigPath,
    prepareReviewDirectory,
    prepareReviewScope,
    reviewDirectory,
    trustAnchorSetPath,
    trustAnchorSetSha256,
    writeCalibrationFreezePath,
    writeFinalPredictionFreezePath,
    writeFreezeManifestPath
  });
}

export function knowledgeSemanticGroundingCliErrorCode(error: unknown): string {
  return error instanceof Error && /^knowledge_[a-z0-9_]{1,120}$/u.test(error.message)
    ? error.message
    : "knowledge_semantic_benchmark_failed";
}

async function readLocalRunnerConfig(path: string): Promise<unknown> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size < 2 ||
    details.size > 16 * 1024) {
    throw new Error("knowledge_semantic_local_config_invalid");
  }
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error("knowledge_semantic_local_config_invalid");
  }
}

async function resolveSystemModelExecutor() {
  const [prismaModule, resolverModule, executorModule] = await Promise.all([
    import("../../lib/server/prisma"),
    import("../../lib/server/providerRuntime/systemModelRole"),
    import("../../lib/server/providerRuntime/structuredOutputExecutor")
  ]);
  const { prisma } = prismaModule;
  try {
    const resolver = resolverModule.createSystemModelRoleResolver(prisma);
    const resolution = await resolver.resolve();
    const pricing = resolution.ok
      ? await prisma.providerModel.findUnique({
          select: {
            inputTokenPriceMicros: true,
            outputTokenPriceMicros: true
          },
          where: { id: resolution.providerModelId }
        })
      : null;
    const semanticResolution = await resolveSystemModelSemanticGroundingExecutor({
      executeStructuredOutput: executorModule.createAcceptedStructuredOutputExecutor(prisma),
      ...(pricing ? {
        pricing: {
          inputTokenPriceMicros: pricing.inputTokenPriceMicros,
          outputTokenPriceMicros: pricing.outputTokenPriceMicros
        }
      } : {}),
      resolveSystemModel: async () => resolution
    });
    return Object.freeze({
      disconnect: () => prisma.$disconnect(),
      resolution: semanticResolution
    });
  } catch (error) {
    await prisma.$disconnect();
    throw error;
  }
}

export async function runKnowledgeSemanticGroundingCli(
  args: readonly string[],
  dependencies: Readonly<{
    readReviewEvidenceDirectory?: typeof readKnowledgeSemanticGroundingReviewEvidenceDirectory;
    resolveSystemModelExecutor?: typeof resolveSystemModelExecutor;
    verificationTime?: () => string;
  }> = {}
): Promise<KnowledgeSemanticCandidateBenchmarkReport |
  KnowledgeSemanticReviewPreparationReport | KnowledgeSemanticFreezePreparationReport |
  KnowledgeSemanticCalibrationFreezePreparationReport |
  KnowledgeSemanticFinalPredictionFreezePreparationReport | null> {
  const options = parseKnowledgeSemanticGroundingCliArgs(args);
  if (options.help) return null;
  const trustAnchorSet = options.trustAnchorSetPath
    ? await readPrivateTrustAnchorSet(options.trustAnchorSetPath)
    : undefined;
  let prevalidatedFinalChain: KnowledgeSemanticFinalArtifactFreezeChain | undefined;
  if (options.finalPredictionFreezePath) {
    const pool = createKnowledgeSemanticGroundingCandidatePool();
    prevalidatedFinalChain = assertKnowledgeSemanticFinalArtifactFreezeChain({
      calibrationFreeze: await readPrivateCalibrationFreeze(options.calibrationFreezePath!),
      candidateFreeze: await readPrivateFreezeManifest(options.freezeManifestPath!),
      finalPredictionFreeze: await readPrivateFinalPredictionFreeze(
        options.finalPredictionFreezePath
      ),
      pool
    });
  }
  if (options.prepareReviewDirectory) {
    const pool = createKnowledgeSemanticGroundingCandidatePool();
    const candidateFreezeManifest = prevalidatedFinalChain?.candidateFreeze ??
      assertKnowledgeSemanticCandidateFreezeArtifact({
        manifest: await readPrivateFreezeManifest(options.freezeManifestPath!),
        pool
      });
    const calibrationFreezeManifest = prevalidatedFinalChain?.calibrationFreeze ?? null;
    const finalPredictionFreezeManifest =
      prevalidatedFinalChain?.finalPredictionFreeze ?? null;
    const artifacts = await writeKnowledgeSemanticGroundingReviewArtifacts({
      candidatePool: pool,
      corpusVersion: KNOWLEDGE_SEMANTIC_GROUNDING_CORPUS_VERSION,
      evaluationBindings: {
        calibrationFreezeManifestSha256: calibrationFreezeManifest
          ? calibrationFreezeManifest.manifestSha256
          : null,
        candidateFreezeManifestSha256: candidateFreezeManifest.manifestSha256,
        finalPredictionFreezeManifestSha256: finalPredictionFreezeManifest
          ? finalPredictionFreezeManifest.manifestSha256
          : null
      },
      fixtures: knowledgeSemanticGroundingFixtures,
      reviewScope: options.prepareReviewScope!,
      reviewDirectory: options.prepareReviewDirectory
    });
    return Object.freeze({
      aggregateOnly: true as const,
      claimCount: artifacts.packet.claimCount,
      corpusSha256: pool.corpusSha256,
      filesCreated: Object.freeze([
        KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_PACKET_FILE,
        KNOWLEDGE_SEMANTIC_GROUNDING_REVIEW_MAPPING_FILE
      ] as const),
      humanReviewPending: true as const,
      poolSha256: pool.poolSha256,
      reviewScope: options.prepareReviewScope!,
      selectionEligible: false as const,
      version: "knowledge-semantic-review-preparation-v1" as const
    });
  }
  if (options.writeFreezeManifestPath) {
    await validateFreezeDirectory(options.writeFreezeManifestPath, true);
  }
  if (options.writeFinalPredictionFreezePath) {
    await validateFreezeDirectory(options.writeFinalPredictionFreezePath, false,
      FINAL_PREDICTION_FREEZE_FILE);
  }
  const local = options.localRunnerConfigPath
    ? createLocalSemanticGroundingExecutor(await readLocalRunnerConfig(
        options.localRunnerConfigPath
      ))
    : undefined;
  const systemRuntime = options.executePaidSystemModel
    ? await (dependencies.resolveSystemModelExecutor ?? resolveSystemModelExecutor)()
    : undefined;
  try {
    const systemResolution = systemRuntime?.resolution;
    const pool = createKnowledgeSemanticGroundingCandidatePool();
    const candidates = createKnowledgeSemanticGroundingCandidates({
      ...(local ? { local } : {}),
      ...(systemResolution?.status === "available"
        ? { systemModel: systemResolution.executor }
        : systemResolution
          ? { systemUnavailableReason: systemResolution.reason }
          : {})
    });
    const freezeManifest = options.writeFreezeManifestPath
      ? createKnowledgeSemanticCandidateFreezeManifest({ candidates, pool })
      : options.freezeManifestPath
        ? assertKnowledgeSemanticCandidateFreezeManifest({
            candidates,
            manifest: prevalidatedFinalChain?.candidateFreeze ??
              await readPrivateFreezeManifest(options.freezeManifestPath),
            pool
          })
        : undefined;
    if (options.writeFreezeManifestPath) {
      await writePrivateFreezeManifest(options.writeFreezeManifestPath, freezeManifest!);
      return Object.freeze({
        aggregateOnly: true as const,
        artifactCreated: FREEZE_MANIFEST_FILE,
        candidateCount: 4 as const,
        candidateSetDigest: freezeManifest!.candidateSet.digest,
        corpusSha256: freezeManifest!.candidateSet.corpusSha256,
        externalExecutionPerformed: false as const,
        labelsUsed: false as const,
        manifestSha256: freezeManifest!.manifestSha256,
        poolSha256: freezeManifest!.candidateSet.poolSha256,
        selectionEligible: false as const,
        semanticProof: false as const,
        thresholdScheduleSha256: freezeManifest!.candidateSet.thresholdScheduleSha256,
        version: "knowledge-semantic-freeze-preparation-v1" as const
      });
    }
    if (options.writeCalibrationFreezePath) {
      const labels = await (dependencies.readReviewEvidenceDirectory ??
        readKnowledgeSemanticGroundingReviewEvidenceDirectory)(options.reviewDirectory!);
      const calibrationFreeze = await runKnowledgeSemanticCalibrationFreeze({
        candidateFreezeManifestSha256: freezeManifest!.manifestSha256,
        frozenCandidateSetDigest: freezeManifest!.candidateSet.digest,
        frozenThresholdScheduleSha256: freezeManifest!.candidateSet.thresholdScheduleSha256,
        labels: labels!,
        ...(local ? { local } : {}),
        ...(systemResolution?.status === "available"
          ? { systemModel: systemResolution.executor }
          : systemResolution
            ? { systemUnavailableReason: systemResolution.reason }
            : {})
      });
      await writePrivateCalibrationFreeze(options.writeCalibrationFreezePath, calibrationFreeze);
      return Object.freeze({
        aggregateOnly: true as const,
        artifactCreated: CALIBRATION_FREEZE_FILE,
        calibrationLabelSha256: calibrationFreeze.calibrationLabelSha256,
        candidateCount: 4 as const,
        candidateFreezeManifestSha256: calibrationFreeze.candidateFreezeManifestSha256,
        externalExecutionScope: "calibration_split_only" as const,
        labelsStored: false as const,
        manifestSha256: calibrationFreeze.manifestSha256,
        selectionEligible: false as const,
        semanticProof: false as const,
        version: "knowledge-semantic-calibration-freeze-preparation-v1" as const
      });
    }
    const calibrationFreeze = options.calibrationFreezePath
      ? prevalidatedFinalChain?.calibrationFreeze ??
        await readPrivateCalibrationFreeze(options.calibrationFreezePath)
      : undefined;
    if (options.writeFinalPredictionFreezePath) {
      if (!freezeManifest || !calibrationFreeze) {
        throw new Error("knowledge_semantic_final_prediction_freeze_binding_invalid");
      }
      const finalPredictionFreeze = await runKnowledgeSemanticFinalPredictionFreeze({
        calibrationFreeze,
        candidateFreezeManifest: freezeManifest,
        candidateFreezeManifestSha256: freezeManifest.manifestSha256,
        ...(local ? { local } : {}),
        ...(systemResolution?.status === "available"
          ? { systemModel: systemResolution.executor }
          : systemResolution
            ? { systemUnavailableReason: systemResolution.reason }
            : {})
      });
      await writePrivateFinalPredictionFreeze(
        options.writeFinalPredictionFreezePath,
        finalPredictionFreeze
      );
      return Object.freeze({
        aggregateOnly: true as const,
        artifactCreated: FINAL_PREDICTION_FREEZE_FILE,
        candidateCount: 4 as const,
        candidateFreezeManifestSha256: finalPredictionFreeze.candidateFreezeManifestSha256,
        calibrationFreezeManifestSha256: finalPredictionFreeze.calibrationFreezeManifestSha256,
        externalExecutionScope: "development_held_out_blinded_without_labels" as const,
        labelsStored: false as const,
        manifestSha256: finalPredictionFreeze.manifestSha256,
        selectionEligible: false as const,
        semanticProof: false as const,
        version: "knowledge-semantic-final-prediction-freeze-preparation-v1" as const
      });
    }
    const finalPredictionFreeze = options.finalPredictionFreezePath
      ? prevalidatedFinalChain?.finalPredictionFreeze ??
        await readPrivateFinalPredictionFreeze(options.finalPredictionFreezePath)
      : undefined;
    const labels = options.reviewDirectory
      ? await (dependencies.readReviewEvidenceDirectory ??
          readKnowledgeSemanticGroundingReviewEvidenceDirectory)(options.reviewDirectory)
      : undefined;
    const baseline = runCurrentFenceSemanticGroundingBenchmark();
    assertKnowledgeSemanticGroundingBenchmarkContract(baseline);
    const report = await runKnowledgeSemanticCandidateBenchmark({
      ...(calibrationFreeze ? {
        calibrationFreeze,
        candidateFreezeManifest: freezeManifest,
        candidateFreezeManifestSha256: freezeManifest!.manifestSha256
      } : {}),
      ...(finalPredictionFreeze ? { finalPredictionFreeze } : {}),
      ...(trustAnchorSet !== undefined || labels?.humanTrustEvidence !== undefined ? {
        humanTrust: {
          anchorSet: trustAnchorSet,
          evaluatedAt: (dependencies.verificationTime ?? (() => new Date().toISOString()))(),
          evidence: labels?.humanTrustEvidence,
          pinnedAnchorSetSha256: options.trustAnchorSetSha256 ?? undefined
        }
      } : {}),
      ...(labels ? { labels } : {}),
      ...(local ? { local } : {}),
      ...(freezeManifest ? {
        frozenCandidateSetDigest: freezeManifest.candidateSet.digest,
        frozenThresholdScheduleSha256: freezeManifest.candidateSet.thresholdScheduleSha256
      } : {}),
      ...(systemResolution?.status === "available"
        ? { systemModel: systemResolution.executor }
        : systemResolution
          ? { systemUnavailableReason: systemResolution.reason }
          : {})
    });
    if (!report.contractValid) {
      throw new Error("knowledge_semantic_candidate_benchmark_contract_failed");
    }
    return report;
  } finally {
    await systemRuntime?.disconnect();
  }
}

export async function runDefaultKnowledgeSemanticGroundingCli():
Promise<KnowledgeSemanticCandidateBenchmarkReport> {
  const report = await assertKnowledgeSemanticCandidateBenchmarkContract();
  return report;
}
