import { spawn } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import {
  MEMORY_PHASE7_HINDSIGHT_REFERENCE
} from "../lib/evaluation/memory/phase7";
import { assertExactHindsightReferencePin } from
  "../tests/harness/memory-reference/hindsightReference";

const CONTAINER_NAME = "aiqsa-memory-hindsight-v070";
const COMPOSE_NETWORK = "aiqsa-dev_default";
const IMAGE = `ghcr.io/vectorize-io/hindsight@${MEMORY_PHASE7_HINDSIGHT_REFERENCE.imageDigest}`;
const MAX_CAPTURE_BYTES = 2 * 1_024 * 1_024;
const EXPECTED_PIN = Object.freeze({
  commit: "99525144b257e827ff07e98665eddd7000b8fc3c",
  imageDigest: "sha256:03cfd4d99ca4a067fbc250473b44611a1a69ea4f7457da9e2af700ff0b999825",
  tag: "0.7.0"
});
let failureStage = "startup";

type CommandResult = Readonly<{ code: number; stderr: string; stdout: string }>;

function capture(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const collect = (target: Buffer[], value: Buffer) => {
      bytes += value.byteLength;
      if (bytes > MAX_CAPTURE_BYTES) {
        child.kill("SIGTERM");
        reject(new Error("memory_phase7_hindsight_command_output_too_large"));
        return;
      }
      target.push(value);
    };
    child.stdout.on("data", (value: Buffer) => collect(stdout, value));
    child.stderr.on("data", (value: Buffer) => collect(stderr, value));
    child.once("error", () => reject(new Error("memory_phase7_hindsight_command_unavailable")));
    child.once("close", (code) => resolve({
      code: code ?? 1,
      stderr: Buffer.concat(stderr).toString("utf8"),
      stdout: Buffer.concat(stdout).toString("utf8")
    }));
  });
}

async function checked(
  command: string,
  args: readonly string[],
  code: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const result = await capture(command, args, env);
  if (result.code !== 0) throw new Error(code);
  return result.stdout.trim();
}

async function loadPrivateEnvironment(): Promise<void> {
  await stat(".env");
  process.loadEnvFile(".env");
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`memory_phase7_hindsight_${name.toLocaleLowerCase("en-US")}_missing`);
  return value;
}

function containerEndpoint(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("memory_phase7_hindsight_llm_endpoint_invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("memory_phase7_hindsight_llm_endpoint_invalid");
  }
  if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
    parsed.hostname = "host.docker.internal";
  }
  return parsed.toString().replace(/\/$/u, "");
}

async function waitHealthy(): Promise<void> {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const state = await capture("docker", [
      "inspect", "--format", "{{.State.Status}}", CONTAINER_NAME
    ]);
    if (state.code !== 0 || state.stdout.trim() === "exited" || state.stdout.trim() === "dead") {
      const logs = await capture("docker", ["logs", "--tail", "240", CONTAINER_NAME]);
      const combined = logs.stderr + logs.stdout;
      const sanitized = combined.replace(/Bearer\s+\S+/giu, "Bearer <redacted>");
      await writeFile("/tmp/aiqsa-hindsight-startup.log", sanitized, { mode: 0o600 });
      if (/init_embeddings|\/embeddings\.py/u.test(combined)) {
        throw new Error("memory_phase7_hindsight_embedding_startup_failed");
      }
      if (/Connection verification failed|verify_llm/u.test(combined)) {
        throw new Error("memory_phase7_hindsight_llm_startup_failed");
      }
      throw new Error("memory_phase7_hindsight_container_exited");
    }
    try {
      const response = await fetch("http://127.0.0.1:18888/health", {
        signal: AbortSignal.timeout(3_000)
      });
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
    } catch {
      // Startup includes the embedded PostgreSQL migration and embedding probe.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("memory_phase7_hindsight_startup_timeout");
}

async function stopContainer(): Promise<void> {
  await capture("docker", ["stop", "--time", "10", CONTAINER_NAME]).catch(() => undefined);
  await capture("docker", ["rm", "--force", CONTAINER_NAME]).catch(() => undefined);
}

async function referenceSmoke(): Promise<void> {
  async function request(path: string, method: "POST" | "PUT", body: unknown) {
    const response = await fetch(`http://127.0.0.1:18888${path}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method,
      signal: AbortSignal.timeout(180_000)
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`memory_phase7_hindsight_smoke_http_${response.status}`);
    return JSON.parse(text) as Readonly<Record<string, unknown>>;
  }
  const bank = "phase7-tuning-smoke";
  await request(`/v1/default/banks/${bank}`, "PUT", { enable_observations: false });
  const retained = await request(`/v1/default/banks/${bank}/memories`, "POST", {
    async: false,
    items: [{
      content: "For this synthetic tuning probe, the user prefers compact pull requests.",
      document_id: "phase7-tuning-smoke-document",
      timestamp: "unset"
    }]
  });
  if (retained.success !== true || retained.items_count !== 1) {
    throw new Error("memory_phase7_hindsight_smoke_retain_invalid");
  }
  const recalled = await request(`/v1/default/banks/${bank}/memories/recall`, "POST", {
    budget: "low",
    include: { chunks: null, entities: null, source_facts: null },
    max_tokens: 256,
    query: "What pull request size does the user prefer?",
    trace: false,
    types: ["world", "experience"]
  });
  if (!Array.isArray(recalled.results)) {
    throw new Error("memory_phase7_hindsight_smoke_recall_invalid");
  }
  process.stdout.write(`${JSON.stringify({
    referenceSmoke: "passed",
    returnedFacts: recalled.results.length
  })}\n`);
}

async function main(): Promise<void> {
  failureStage = "pin";
  assertExactHindsightReferencePin(MEMORY_PHASE7_HINDSIGHT_REFERENCE, EXPECTED_PIN);
  const smokeOnly = process.argv.slice(2).includes("--reference-smoke-only");
  const evaluatorArguments = process.argv.slice(2).filter((value) =>
    value !== "--reference-smoke-only"
  );
  if (
    !smokeOnly &&
    !evaluatorArguments.some((value) => value.startsWith("--evidence-output="))
  ) {
    throw new Error("memory_phase7_hindsight_evidence_output_required");
  }
  const preflight = evaluatorArguments.includes("--preflight-only");
  failureStage = "environment";
  await loadPrivateEnvironment();
  const llmApiKey = preflight ? "preflight-unused" : required("_DEV_CUSTOM_OPENAI_API_KEY");
  const llmEndpoint = preflight
    ? "http://host.docker.internal:1/v1"
    : containerEndpoint(required("_DEV_CUSTOM_OPENAI_ENDPOINT"));
  const openRouterApiKey = preflight ? "preflight-unused" : required("OPENROUTER_API_KEY");
  await checked("docker", ["network", "inspect", COMPOSE_NETWORK],
    "memory_phase7_hindsight_compose_network_missing");
  const stale = await capture("docker", ["container", "inspect", CONTAINER_NAME]);
  if (stale.code === 0) throw new Error("memory_phase7_hindsight_container_already_exists");

  if (preflight) {
    failureStage = "preflight";
    const result = await checked("docker", [
      "compose", "-f", "docker-compose.dev.yml", "run", "--rm", "-T", "--no-deps",
      "-e", "NODE_OPTIONS=--max-old-space-size=1536",
      "-e", "AIQSA_HINDSIGHT_REFERENCE_URL=http://aiqsa-memory-hindsight-v070:8888",
      "app", "npx", "tsx", "scripts/memory-phase7-hindsight-evaluation.ts",
      ...evaluatorArguments
    ], "memory_phase7_hindsight_preflight_failed", {
      ...process.env,
      AIQSA_APP_CPU_LIMIT: "2",
      AIQSA_APP_MEMORY_LIMIT: "2g"
    });
    process.stdout.write(`${result}\n`);
    return;
  }

  failureStage = "image";
  await checked("docker", ["image", "inspect", IMAGE],
    "memory_phase7_hindsight_image_missing");
  const runtimeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HINDSIGHT_API_ACCESS_LOG: "false",
    HINDSIGHT_API_DB_POOL_MAX_SIZE: "4",
    HINDSIGHT_API_DB_POOL_MIN_SIZE: "1",
    HINDSIGHT_API_EMBEDDINGS_OPENAI_BATCH_SIZE: "64",
    HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY: openRouterApiKey,
    HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
    HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS:
      String(MEMORY_PHASE7_HINDSIGHT_REFERENCE.embeddingDimensions),
    HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL:
      MEMORY_PHASE7_HINDSIGHT_REFERENCE.embeddingModel,
    HINDSIGHT_API_EMBEDDINGS_PROVIDER: "openai",
    HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION: "false",
    HINDSIGHT_API_ENABLE_OBSERVATIONS: "false",
    HINDSIGHT_API_ENABLE_OBSERVATION_HISTORY: "false",
    HINDSIGHT_API_LLM_API_KEY: llmApiKey,
    HINDSIGHT_API_LLM_BASE_URL: llmEndpoint,
    HINDSIGHT_API_LLM_MAX_CONCURRENT: "1",
    HINDSIGHT_API_LLM_MAX_RETRIES: "1",
    HINDSIGHT_API_LLM_MODEL: MEMORY_PHASE7_HINDSIGHT_REFERENCE.llmModel,
    HINDSIGHT_API_LLM_PROVIDER: "openai",
    HINDSIGHT_API_LLM_TIMEOUT: "120",
    HINDSIGHT_API_LOG_LEVEL: "warning",
    HINDSIGHT_API_MCP_ENABLED: "false",
    HINDSIGHT_API_RECALL_MAX_CONCURRENT: "1",
    HINDSIGHT_API_RERANKER_PROVIDER: "rrf",
    HINDSIGHT_API_RETAIN_BATCH_ENABLED: "false",
    HINDSIGHT_API_RETAIN_LLM_MAX_CONCURRENT: "1",
    HINDSIGHT_API_TEXT_SEARCH_EXTENSION: "native",
    HINDSIGHT_API_TEXT_SEARCH_EXTENSION_NATIVE_LANGUAGE:
      MEMORY_PHASE7_HINDSIGHT_REFERENCE.textSearchLanguage,
    HINDSIGHT_API_VECTOR_EXTENSION:
      MEMORY_PHASE7_HINDSIGHT_REFERENCE.vectorExtension,
    HINDSIGHT_API_WORKERS: "1"
  };
  runtimeEnv.HINDSIGHT_API_WORKER_ID = CONTAINER_NAME;
  runtimeEnv.HINDSIGHT_ENABLE_CP = "false";
  const passedEnv = [
    "HINDSIGHT_API_ACCESS_LOG",
    "HINDSIGHT_API_DB_POOL_MAX_SIZE",
    "HINDSIGHT_API_DB_POOL_MIN_SIZE",
    "HINDSIGHT_API_EMBEDDINGS_OPENAI_BATCH_SIZE",
    "HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY",
    "HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL",
    "HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS",
    "HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL",
    "HINDSIGHT_API_EMBEDDINGS_PROVIDER",
    "HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION",
    "HINDSIGHT_API_ENABLE_OBSERVATIONS",
    "HINDSIGHT_API_ENABLE_OBSERVATION_HISTORY",
    "HINDSIGHT_API_LLM_API_KEY",
    "HINDSIGHT_API_LLM_BASE_URL",
    "HINDSIGHT_API_LLM_MAX_CONCURRENT",
    "HINDSIGHT_API_LLM_MAX_RETRIES",
    "HINDSIGHT_API_LLM_MODEL",
    "HINDSIGHT_API_LLM_PROVIDER",
    "HINDSIGHT_API_LLM_TIMEOUT",
    "HINDSIGHT_API_LOG_LEVEL",
    "HINDSIGHT_API_MCP_ENABLED",
    "HINDSIGHT_API_RECALL_MAX_CONCURRENT",
    "HINDSIGHT_API_RERANKER_PROVIDER",
    "HINDSIGHT_API_RETAIN_BATCH_ENABLED",
    "HINDSIGHT_API_RETAIN_LLM_MAX_CONCURRENT",
    "HINDSIGHT_API_TEXT_SEARCH_EXTENSION",
    "HINDSIGHT_API_TEXT_SEARCH_EXTENSION_NATIVE_LANGUAGE",
    "HINDSIGHT_API_VECTOR_EXTENSION",
    "HINDSIGHT_API_WORKER_ID",
    "HINDSIGHT_API_WORKERS",
    "HINDSIGHT_ENABLE_CP"
  ];
  failureStage = "container-start";
  await checked("docker", [
    "run", "--detach", "--name", CONTAINER_NAME,
    "--network", COMPOSE_NETWORK,
    "--network-alias", CONTAINER_NAME,
    "--add-host", "host.docker.internal:host-gateway",
    "--publish", "127.0.0.1:18888:8888",
    "--memory", "4g", "--memory-swap", "4g", "--cpus", "2",
    "--pids-limit", "512", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=256m",
    ...passedEnv.flatMap((name) => ["--env", name]),
    IMAGE
  ], "memory_phase7_hindsight_container_start_failed", runtimeEnv);

  try {
    failureStage = "health";
    await waitHealthy();
    const limits = JSON.parse(await checked("docker", [
      "inspect", "--format",
      "{\"memory\":{{.HostConfig.Memory}},\"memorySwap\":{{.HostConfig.MemorySwap}},\"nanoCpus\":{{.HostConfig.NanoCpus}},\"pids\":{{.HostConfig.PidsLimit}}}",
      CONTAINER_NAME
    ], "memory_phase7_hindsight_limits_unavailable")) as Readonly<{
      memory: number;
      memorySwap: number;
      nanoCpus: number;
      pids: number;
    }>;
    if (
      limits.memory !== 4 * 1_024 ** 3 || limits.memorySwap !== limits.memory ||
      limits.nanoCpus !== 2_000_000_000 || limits.pids !== 512
    ) throw new Error("memory_phase7_hindsight_limits_invalid");

    if (smokeOnly) {
      failureStage = "reference-smoke";
      await referenceSmoke();
      return;
    }

    failureStage = "evaluation";
    const evaluation = await capture("docker", [
      "compose", "-f", "docker-compose.dev.yml", "run", "--rm", "-T", "--no-deps",
      "-e", "NODE_OPTIONS=--max-old-space-size=1536",
      "-e", "AIQSA_HINDSIGHT_REFERENCE_URL=http://aiqsa-memory-hindsight-v070:8888",
      "app", "npx", "tsx", "scripts/memory-phase7-hindsight-evaluation.ts",
      ...evaluatorArguments
    ], {
      ...process.env,
      AIQSA_APP_CPU_LIMIT: "2",
      AIQSA_APP_MEMORY_LIMIT: "2g"
    });
    if (evaluation.code !== 0) {
      const detail = /^(memory_[a-z0-9_]+):([a-z0-9-]+)$/mu.exec(evaluation.stderr.trim());
      if (detail) {
        failureStage = detail[2]!;
        throw new Error(detail[1]!);
      }
      throw new Error("memory_phase7_hindsight_evaluation_command_failed");
    }
    process.stdout.write(`${evaluation.stdout.trim()}\n`);
  } finally {
    await stopContainer();
  }
}

void main().catch((error: unknown) => {
  const code = error instanceof Error && /^memory_[a-z0-9_]+$/u.test(error.message)
    ? error.message
    : "memory_phase7_hindsight_orchestration_failed";
  process.stderr.write(`${code}:${failureStage}\n`);
  process.exitCode = 1;
});
