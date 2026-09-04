import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { canonicalJson } from "./contract";
import {
  BRIGHT_STACKOVERFLOW_CORPUS_SHARD_ROWS,
  BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT,
  BRIGHT_STACKOVERFLOW_PREPARED_FORMAT_VERSION,
  BRIGHT_STACKOVERFLOW_QUERY_COUNT,
  BRIGHT_STACKOVERFLOW_REVISION,
  BRIGHT_STACKOVERFLOW_SUITE_ID,
  assertSha256
} from "./brightStackOverflowContract";

export const BRIGHT_STACKOVERFLOW_RAW_GPT2_TOKENS = 75_455_855 as const;
export const BRIGHT_STACKOVERFLOW_PREPARED_GPT2_TOKENS = 75_350_370 as const;
export const BRIGHT_STACKOVERFLOW_PREPARED_CORPUS_FINGERPRINT =
  "7dd370a0dcfcc45cb6b58265a61490e2e56267534a6a845d1da8025bfe279b45" as const;
export const BRIGHT_STACKOVERFLOW_PREPARED_MANIFEST_FINGERPRINT =
  "d68018de3afabdb21398d663e9be57966cbca3f0aa898bd365da751991542716" as const;

export type BrightPreparedFileReceipt = Readonly<{
  bytes: number;
  path: string;
  sha256: string;
}>;

export type BrightPreparedManifest = Readonly<{
  corpus: Readonly<{
    documentCount: number;
    preparedFingerprint: string;
    preparedGpt2Tokens: number;
    rawGpt2Tokens: number;
    shardRows: number;
    shards: readonly BrightPreparedFileReceipt[];
  }>;
  dataset: Readonly<{
    revision: string;
    suiteId: string;
  }>;
  formatVersion: number;
  manifestFingerprint: string;
  queries: Readonly<{
    evaluatorFile: BrightPreparedFileReceipt;
    queryCount: number;
    runtimeFile: BrightPreparedFileReceipt;
  }>;
  schemaVersion: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeReceipt(
  value: unknown,
  expectedPath?: string
): BrightPreparedFileReceipt {
  if (!isRecord(value) || !Number.isSafeInteger(value.bytes) ||
    Number(value.bytes) < 1 || typeof value.path !== "string" ||
    value.path.startsWith("/") || value.path.includes("..") ||
    expectedPath !== undefined && value.path !== expectedPath ||
    typeof value.sha256 !== "string") {
    throw new Error("bright_stackoverflow_prepared_manifest_invalid");
  }
  return Object.freeze({
    bytes: Number(value.bytes),
    path: value.path,
    sha256: assertSha256(
      value.sha256,
      "bright_stackoverflow_prepared_manifest_invalid"
    )
  });
}

export function decodeBrightPreparedManifest(value: unknown): BrightPreparedManifest {
  if (!isRecord(value) || !isRecord(value.corpus) || !isRecord(value.dataset) ||
    !isRecord(value.queries) ||
    value.formatVersion !== BRIGHT_STACKOVERFLOW_PREPARED_FORMAT_VERSION ||
    value.schemaVersion !== 1 ||
    value.dataset.suiteId !== BRIGHT_STACKOVERFLOW_SUITE_ID ||
    value.dataset.revision !== BRIGHT_STACKOVERFLOW_REVISION ||
    value.corpus.documentCount !== BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT ||
    value.corpus.preparedFingerprint !==
      BRIGHT_STACKOVERFLOW_PREPARED_CORPUS_FINGERPRINT ||
    value.corpus.shardRows !== BRIGHT_STACKOVERFLOW_CORPUS_SHARD_ROWS ||
    value.corpus.rawGpt2Tokens !== BRIGHT_STACKOVERFLOW_RAW_GPT2_TOKENS ||
    value.corpus.preparedGpt2Tokens !== BRIGHT_STACKOVERFLOW_PREPARED_GPT2_TOKENS ||
    value.queries.queryCount !== BRIGHT_STACKOVERFLOW_QUERY_COUNT ||
    !Array.isArray(value.corpus.shards) ||
    value.corpus.shards.length !== Math.ceil(
      BRIGHT_STACKOVERFLOW_DOCUMENT_COUNT / BRIGHT_STACKOVERFLOW_CORPUS_SHARD_ROWS
    ) || typeof value.manifestFingerprint !== "string") {
    throw new Error("bright_stackoverflow_prepared_manifest_invalid");
  }
  const manifestFingerprint = assertSha256(
    value.manifestFingerprint,
    "bright_stackoverflow_prepared_manifest_invalid"
  );
  const { manifestFingerprint: _fingerprint, ...manifestBody } = value;
  const computed = createHash("sha256")
    .update(canonicalJson(manifestBody), "utf8")
    .digest("hex");
  if (manifestFingerprint !== BRIGHT_STACKOVERFLOW_PREPARED_MANIFEST_FINGERPRINT ||
    computed !== manifestFingerprint) {
    throw new Error("bright_stackoverflow_prepared_manifest_mismatch");
  }
  const shards = Object.freeze(value.corpus.shards.map((entry, index) =>
    decodeReceipt(
      entry,
      `corpus/part-${String(index).padStart(5, "0")}.jsonl`
    )));
  return Object.freeze({
    corpus: Object.freeze({
      documentCount: Number(value.corpus.documentCount),
      preparedFingerprint: assertSha256(
        String(value.corpus.preparedFingerprint),
        "bright_stackoverflow_prepared_manifest_invalid"
      ),
      preparedGpt2Tokens: Number(value.corpus.preparedGpt2Tokens),
      rawGpt2Tokens: Number(value.corpus.rawGpt2Tokens),
      shardRows: Number(value.corpus.shardRows),
      shards
    }),
    dataset: Object.freeze({
      revision: String(value.dataset.revision),
      suiteId: String(value.dataset.suiteId)
    }),
    formatVersion: Number(value.formatVersion),
    manifestFingerprint,
    queries: Object.freeze({
      evaluatorFile: decodeReceipt(
        value.queries.evaluatorFile,
        "queries/evaluator.jsonl"
      ),
      queryCount: Number(value.queries.queryCount),
      runtimeFile: decodeReceipt(
        value.queries.runtimeFile,
        "queries/runtime.jsonl"
      )
    }),
    schemaVersion: Number(value.schemaVersion)
  });
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyReceipt(
  root: string,
  receipt: BrightPreparedFileReceipt
): Promise<void> {
  const path = resolve(root, receipt.path);
  if (!path.startsWith(`${root}${sep}`)) {
    throw new Error("bright_stackoverflow_prepared_shard_path_invalid");
  }
  const file = await stat(path).catch(() => null);
  if (!file?.isFile() || file.size !== receipt.bytes ||
    await sha256File(path) !== receipt.sha256) {
    throw new Error("bright_stackoverflow_prepared_shard_mismatch");
  }
}

/** Verifies every deterministic output receipt before resume/product work. */
export async function verifyBrightPreparedDataset(
  preparedRoot: string
): Promise<BrightPreparedManifest> {
  const root = resolve(preparedRoot);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8")) as unknown;
  } catch {
    throw new Error("bright_stackoverflow_prepared_manifest_invalid");
  }
  const manifest = decodeBrightPreparedManifest(raw);
  for (const receipt of [
    ...manifest.corpus.shards,
    manifest.queries.runtimeFile,
    manifest.queries.evaluatorFile
  ]) {
    await verifyReceipt(root, receipt);
  }
  return manifest;
}
