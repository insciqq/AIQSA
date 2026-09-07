import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brightAnswerCodeFingerprint, brightAnswerHash, createBrightAnswerStore,
  readBrightPrivateJson } from "./brightAnswerHarness";
import { decodeKnowledgeFrozenRunManifest, knowledgeRunManifestFingerprint,
  resolveKnowledgeBenchmarkOutputDirectory } from "./contract";
import { assertOpenRagPrivatePathNoSymlinks } from "./openRagAnswerRunner";
import { KNOWLEDGE_RETRIEVAL_REPLAY_VERSION, replayKnowledgeRetrieval } from "./retrievalReplay";

export function parseKnowledgeReplayCli(argv: readonly string[]) {
  let output: string | undefined, queryIndex: number | undefined;
  let compareCurrent = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--compare-current" && !compareCurrent) compareCurrent = true;
    else if (argument === "--output" && output === undefined) {
      output = argv[++index];
      if (!output || output.startsWith("--")) throw new Error("knowledge_benchmark_replay_arguments_invalid");
    } else if (argument === "--query-index" && queryIndex === undefined) {
      const value = argv[++index];
      if (!value || !/^(?:0|[1-9]\d{0,5})$/u.test(value)) throw new Error("knowledge_benchmark_replay_arguments_invalid");
      queryIndex = Number(value);
    } else throw new Error("knowledge_benchmark_replay_arguments_invalid");
  }
  if (output === undefined || queryIndex === undefined) throw new Error("knowledge_benchmark_replay_arguments_invalid");
  return { output, queryIndex, compareCurrent };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function main() {
  const options = parseKnowledgeReplayCli(process.argv.slice(2));
  const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(benchmarkRoot, "../..");
  const output = await assertOpenRagPrivatePathNoSymlinks(repositoryRoot,
    resolve(resolveKnowledgeBenchmarkOutputDirectory(benchmarkRoot, options.output), "replay"));
  const stored = await readBrightPrivateJson(resolve(output, "manifest.json"));
  if (!record(stored) || !record(stored.manifest) ||
    stored.fingerprint !== brightAnswerHash(stored.manifest) ||
    stored.manifest.version !== KNOWLEDGE_RETRIEVAL_REPLAY_VERSION ||
    typeof stored.manifest.codeFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(stored.manifest.codeFingerprint) ||
    knowledgeRunManifestFingerprint(decodeKnowledgeFrozenRunManifest(stored.manifest.retrievalManifest)) !==
      stored.manifest.manifestFingerprint) throw new Error("knowledge_benchmark_replay_manifest_invalid");
  const currentFingerprint = await brightAnswerCodeFingerprint(repositoryRoot);
  const codeChanged = currentFingerprint !== stored.manifest.codeFingerprint;
  if (codeChanged && !options.compareCurrent) throw new Error("knowledge_benchmark_replay_executable_drift");
  const store = await createBrightAnswerStore({ repositoryRoot, output,
    manifest: stored.manifest, resume: true });
  try {
    const replay = await replayKnowledgeRetrieval({ store, queryIndex: options.queryIndex });
    if (!options.compareCurrent && !replay.exact) throw new Error("knowledge_benchmark_replay_result_mismatch");
    process.stdout.write(JSON.stringify({ event: "knowledge_retrieval_replay_complete",
      queryIndex: options.queryIndex, codeChanged, exact: replay.exact,
      scoreable: false, recordedCalls: replay.calls, providerRequests: 0, databaseRequests: 0,
      selectedPassages: replay.result.passages.length, stageDurations: replay.stageDurations }) + "\n");
  } finally { await store.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const known = new Set(["knowledge_benchmark_replay_arguments_invalid", "knowledge_benchmark_replay_invalid",
      "knowledge_benchmark_replay_manifest_invalid", "knowledge_benchmark_replay_executable_drift",
      "knowledge_benchmark_replay_input_mismatch", "knowledge_benchmark_replay_native_input_mismatch",
      "knowledge_benchmark_replay_unconsumed_calls", "knowledge_benchmark_replay_result_mismatch",
      "bright_answer_output_locked", "bright_answer_checkpoint_corrupt", "bright_answer_checkpoint_invalid"]);
    const code = error instanceof Error && known.has(error.message) ? error.message : "knowledge_benchmark_replay_failed";
    process.stdout.write(JSON.stringify({ event: "knowledge_retrieval_replay_failed", code }) + "\n");
    process.exitCode = 1;
  });
}
