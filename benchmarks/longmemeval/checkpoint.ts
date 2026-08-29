import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const checkpointDirectoryName = "case-checkpoints";
const checkpointManifestName = "checkpoint-manifest.json";
const answersName = "answers.jsonl";
const safeQuestionId = /^[A-Za-z0-9_]{1,64}$/u;
const safeQuestionType = /^[a-z][a-z0-9-]{0,63}$/u;
const safeReason = /^[A-Za-z0-9_:-]{1,160}$/u;

export type LongMemEvalCheckpointExecution = Readonly<{
  caseConcurrency: number;
  origin: "LIVE" | "RECOVERED";
  sessionConcurrency: number;
}>;

export type LongMemEvalCheckpointOutcome<TSummary, TFailure> =
  | Readonly<{
      hypothesis: string;
      reason: string;
      status: "COMPLETE";
      summary: TSummary;
    }>
  | Readonly<{
      failure: TFailure;
      reason: string;
      status: "FAILED";
    }>;

export type LongMemEvalCheckpointAttempt<TSummary, TFailure> = Readonly<{
  attempt: number;
  completedAt: string;
  execution: LongMemEvalCheckpointExecution;
  outcome: LongMemEvalCheckpointOutcome<TSummary, TFailure>;
}>;

export type LongMemEvalCaseCheckpoint<TSummary, TFailure> = Readonly<{
  attempts: readonly LongMemEvalCheckpointAttempt<TSummary, TFailure>[];
  questionId: string;
  questionType: string;
  version: 1;
}>;

export type LongMemEvalCheckpointManifest<TIdentity> = Readonly<{
  identity: TIdentity;
  startedAt: string;
  version: 1;
}>;

type CheckpointDecoders<TSummary, TFailure> = Readonly<{
  failure: (value: unknown) => TFailure;
  summary: (value: unknown) => TSummary;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function isoTimestamp(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value));
}

function assertQuestionIdentity(questionId: string, questionType: string): void {
  if (!safeQuestionId.test(questionId) || !safeQuestionType.test(questionType)) {
    throw new Error("longmemeval_checkpoint_identity_invalid");
  }
}

function assertExecution(value: unknown): LongMemEvalCheckpointExecution {
  if (!isRecord(value) || !positiveInteger(value.caseConcurrency) ||
    !positiveInteger(value.sessionConcurrency) ||
    (value.origin !== "LIVE" && value.origin !== "RECOVERED")) {
    throw new Error("longmemeval_checkpoint_execution_invalid");
  }
  return Object.freeze({
    caseConcurrency: value.caseConcurrency,
    origin: value.origin,
    sessionConcurrency: value.sessionConcurrency
  });
}

function decodeOutcome<TSummary, TFailure>(
  value: unknown,
  decoders: CheckpointDecoders<TSummary, TFailure>
): LongMemEvalCheckpointOutcome<TSummary, TFailure> {
  if (!isRecord(value) || typeof value.reason !== "string" ||
    !safeReason.test(value.reason)) {
    throw new Error("longmemeval_checkpoint_outcome_invalid");
  }
  if (value.status === "COMPLETE" && typeof value.hypothesis === "string") {
    return Object.freeze({
      hypothesis: value.hypothesis,
      reason: value.reason,
      status: value.status,
      summary: decoders.summary(value.summary)
    });
  }
  if (value.status === "FAILED") {
    return Object.freeze({
      failure: decoders.failure(value.failure),
      reason: value.reason,
      status: value.status
    });
  }
  throw new Error("longmemeval_checkpoint_outcome_invalid");
}

function decodeCaseCheckpoint<TSummary, TFailure>(
  value: unknown,
  decoders: CheckpointDecoders<TSummary, TFailure>
): LongMemEvalCaseCheckpoint<TSummary, TFailure> {
  if (!isRecord(value) || value.version !== 1 ||
    typeof value.questionId !== "string" || typeof value.questionType !== "string" ||
    !Array.isArray(value.attempts) || value.attempts.length === 0) {
    throw new Error("longmemeval_checkpoint_invalid");
  }
  assertQuestionIdentity(value.questionId, value.questionType);
  const attempts = value.attempts.map((candidate, index) => {
    if (!isRecord(candidate) || candidate.attempt !== index + 1 ||
      !isoTimestamp(candidate.completedAt)) {
      throw new Error("longmemeval_checkpoint_attempt_invalid");
    }
    return Object.freeze({
      attempt: candidate.attempt,
      completedAt: candidate.completedAt,
      execution: assertExecution(candidate.execution),
      outcome: decodeOutcome(candidate.outcome, decoders)
    });
  });
  return Object.freeze({
    attempts: Object.freeze(attempts),
    questionId: value.questionId,
    questionType: value.questionType,
    version: 1 as const
  });
}

async function writeTextAtomic(path: string, text: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, text, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function checkpointPath(outputDirectory: string, questionId: string): string {
  if (!safeQuestionId.test(questionId)) {
    throw new Error("longmemeval_checkpoint_identity_invalid");
  }
  return resolve(outputDirectory, checkpointDirectoryName, `${questionId}.json`);
}

export async function createLongMemEvalCheckpointRun<TIdentity>(input: Readonly<{
  identity: TIdentity;
  outputDirectory: string;
  startedAt?: Date;
}>): Promise<LongMemEvalCheckpointManifest<TIdentity>> {
  const startedAt = input.startedAt ?? new Date();
  if (!Number.isFinite(startedAt.getTime())) {
    throw new Error("longmemeval_checkpoint_started_at_invalid");
  }
  await mkdir(input.outputDirectory, { mode: 0o700, recursive: false });
  await mkdir(resolve(input.outputDirectory, checkpointDirectoryName), {
    mode: 0o700,
    recursive: false
  });
  await writeFile(resolve(input.outputDirectory, answersName), "", {
    flag: "wx",
    mode: 0o600
  });
  const manifest = Object.freeze({
    identity: input.identity,
    startedAt: startedAt.toISOString(),
    version: 1 as const
  });
  await writeTextAtomic(
    resolve(input.outputDirectory, checkpointManifestName),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return manifest;
}

export async function resumeLongMemEvalCheckpointRun<TIdentity>(input: Readonly<{
  expectedIdentity: TIdentity;
  outputDirectory: string;
}>): Promise<LongMemEvalCheckpointManifest<TIdentity>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(
      resolve(input.outputDirectory, checkpointManifestName),
      "utf8"
    )) as unknown;
  } catch {
    throw new Error("longmemeval_checkpoint_manifest_unavailable");
  }
  if (!isRecord(value) || value.version !== 1 || !isoTimestamp(value.startedAt) ||
    !isDeepStrictEqual(value.identity, input.expectedIdentity)) {
    throw new Error("longmemeval_checkpoint_manifest_mismatch");
  }
  const entries = await readdir(resolve(input.outputDirectory, checkpointDirectoryName), {
    withFileTypes: true
  }).catch(() => {
    throw new Error("longmemeval_checkpoint_directory_unavailable");
  });
  if (entries.some((entry) => !entry.isFile() ||
    (!entry.name.endsWith(".json") && !entry.name.endsWith(".tmp")))) {
    throw new Error("longmemeval_checkpoint_directory_invalid");
  }
  return Object.freeze({
    identity: input.expectedIdentity,
    startedAt: value.startedAt,
    version: 1 as const
  });
}

export async function loadLongMemEvalCaseCheckpoints<TSummary, TFailure>(
  outputDirectory: string,
  decoders: CheckpointDecoders<TSummary, TFailure>
): Promise<ReadonlyMap<string, LongMemEvalCaseCheckpoint<TSummary, TFailure>>> {
  const directory = resolve(outputDirectory, checkpointDirectoryName);
  const entries = await readdir(directory, { withFileTypes: true });
  const checkpoints = new Map<
    string,
    LongMemEvalCaseCheckpoint<TSummary, TFailure>
  >();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isFile() && entry.name.endsWith(".tmp")) continue;
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      throw new Error("longmemeval_checkpoint_directory_invalid");
    }
    let value: unknown;
    try {
      value = JSON.parse(await readFile(resolve(directory, entry.name), "utf8")) as unknown;
    } catch {
      throw new Error("longmemeval_checkpoint_invalid");
    }
    const checkpoint = decodeCaseCheckpoint(value, decoders);
    if (entry.name !== `${checkpoint.questionId}.json` ||
      checkpoints.has(checkpoint.questionId)) {
      throw new Error("longmemeval_checkpoint_identity_invalid");
    }
    checkpoints.set(checkpoint.questionId, checkpoint);
  }
  return checkpoints;
}

export async function writeLongMemEvalCaseCheckpoint<TSummary, TFailure>(input: Readonly<{
  execution: LongMemEvalCheckpointExecution;
  outcome: LongMemEvalCheckpointOutcome<TSummary, TFailure>;
  outputDirectory: string;
  previous?: LongMemEvalCaseCheckpoint<TSummary, TFailure>;
  questionId: string;
  questionType: string;
}>): Promise<LongMemEvalCaseCheckpoint<TSummary, TFailure>> {
  assertQuestionIdentity(input.questionId, input.questionType);
  if (input.previous && (input.previous.questionId !== input.questionId ||
    input.previous.questionType !== input.questionType)) {
    throw new Error("longmemeval_checkpoint_identity_invalid");
  }
  if (!safeReason.test(input.outcome.reason)) {
    throw new Error("longmemeval_checkpoint_outcome_invalid");
  }
  const execution = assertExecution(input.execution);
  const previousAttempts = input.previous?.attempts ?? [];
  const checkpoint = Object.freeze({
    attempts: Object.freeze([
      ...previousAttempts,
      Object.freeze({
        attempt: previousAttempts.length + 1,
        completedAt: new Date().toISOString(),
        execution,
        outcome: input.outcome
      })
    ]),
    questionId: input.questionId,
    questionType: input.questionType,
    version: 1 as const
  });
  await writeTextAtomic(
    checkpointPath(input.outputDirectory, input.questionId),
    `${JSON.stringify(checkpoint, null, 2)}\n`
  );
  return checkpoint;
}

export async function writeLongMemEvalAnswersAtomic(
  outputDirectory: string,
  answers: readonly Readonly<{ hypothesis: string; questionId: string }>[]
): Promise<void> {
  const text = answers.map(({ hypothesis, questionId }) => `${JSON.stringify({
    hypothesis,
    question_id: questionId
  })}\n`).join("");
  await writeTextAtomic(resolve(outputDirectory, answersName), text);
}
