import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  createDocumentParserBoundary,
  getDocumentParserConfig,
  isDocumentParserError
} from "../lib/server/parsing";
import { getKnowledgeExtractionConfig } from "../lib/server/knowledge/knowledgeExtractionConfig";
import {
  createKnowledgeOcrFixtures,
  KNOWLEDGE_OCR_DPI,
  KNOWLEDGE_OCR_PAGE_HEIGHT_PX,
  KNOWLEDGE_OCR_PAGE_WIDTH_PX,
  knowledgeOcrTextEvidence
} from "./knowledge-ocr-fixtures";

const COMPOSE_FILE = "docker-compose.dev.yml";
const MATRIX = Object.freeze([10, 50, 100]);
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1_024;
const EXPECTED_IMAGE = "aiqsa-docling:v1.21.0-easyocr-ru-en-1";
const EXPECTED_IMAGE_BASE_DIGEST = "sha256:c7d56cf78c45ab61406bc2dfebbac562c16e38538393f838991a949577cd3d0a";
const EXPECTED_IMAGE_VERSION = "v1.21.0-easyocr-ru-en-1";
const EXPECTED_CLIENT_TIMEOUT_MS = 300_000;
const EXPECTED_CPU_LIMIT = 2;
const EXPECTED_MEMORY_LIMIT_BYTES = 10 * 1_024 ** 3;
const EXPECTED_SERVER_SYNC_WAIT_SECONDS = 290;
const EXPECTED_RUNTIME_ENV = Object.freeze([
  "DOCLING_NUM_THREADS=2",
  "DOCLING_SERVE_ENG_LOC_NUM_WORKERS=1",
  "DOCLING_SERVE_LAYOUT_BATCH_SIZE=4",
  "DOCLING_SERVE_LOAD_MODELS_AT_BOOT=false",
  "DOCLING_SERVE_OCR_BATCH_SIZE=4",
  "DOCLING_SERVE_OPTIONS_CACHE_SIZE=1",
  "DOCLING_SERVE_QUEUE_MAX_SIZE=4",
  "DOCLING_SERVE_TABLE_BATCH_SIZE=4",
  "HF_HUB_OFFLINE=1",
  "OMP_NUM_THREADS=2",
  "TRANSFORMERS_OFFLINE=1"
]);
const DOCLING_SYNC_WAIT_MS = 290_000;
const OCR_ASSET_VERIFIER_PATH = "/opt/app-root/src/aiqsa-verify-ocr-assets.py";
let benchmarkStage = "startup";

type CapturedCommand = Readonly<{
  code: number;
  stderr: string;
  stdout: string;
}>;

type DoclingInspection = Readonly<{
  baseDigest: string;
  cpuLimit: number;
  id: string;
  image: string;
  imageVersion: string;
  memoryLimitBytes: number;
  serverSyncWaitMs: number;
}>;

type MatrixCaseResult = Readonly<{
  deadlineReached: boolean;
  output: Readonly<Record<string, unknown>>;
  recoveryReason?: "container-oom" | "parser-timeout";
}>;

function writeBoundedJson(evidence: Readonly<Record<string, unknown>>): void {
  const line = JSON.stringify(evidence);
  if (Buffer.byteLength(line, "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
    throw new Error("ocr_benchmark_evidence_too_large");
  }
  process.stdout.write(`${line}\n`);
}

function capture(command: string, args: readonly string[]): Promise<CapturedCommand> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let totalBytes = 0;

    const collect = (target: Buffer[], value: Buffer) => {
      totalBytes += value.byteLength;
      if (totalBytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        reject(new Error("ocr_benchmark_command_output_too_large"));
        return;
      }
      target.push(value);
    };
    child.stdout.on("data", (value: Buffer) => collect(stdout, value));
    child.stderr.on("data", (value: Buffer) => collect(stderr, value));
    child.once("error", () => reject(new Error("ocr_benchmark_command_unavailable")));
    child.once("close", (code) => resolve({
      code: code ?? 1,
      stderr: Buffer.concat(stderr).toString("utf8"),
      stdout: Buffer.concat(stdout).toString("utf8")
    }));
  });
}

async function checkedOutput(command: string, args: readonly string[], code: string): Promise<string> {
  const result = await capture(command, args);
  if (result.code !== 0) throw new Error(code);
  return result.stdout.trim();
}

function memoryBytes(value: string): number | undefined {
  const usage = value.split("/")[0]?.trim();
  // `docker stats` emits cursor-control bytes even without an allocated TTY on
  // some Docker Desktop builds. Search the bounded usage half rather than
  // requiring the numeric token to begin at byte zero.
  const match = /(\d+(?:\.\d+)?)\s*([kmgt]?i?b)/iu.exec(usage ?? "");
  if (!match) return undefined;
  const unit = match[2].toLowerCase();
  const scales: Readonly<Record<string, number>> = {
    b: 1,
    gb: 1_000 ** 3,
    gib: 1_024 ** 3,
    kb: 1_000,
    kib: 1_024,
    mb: 1_000 ** 2,
    mib: 1_024 ** 2,
    tb: 1_000 ** 4,
    tib: 1_024 ** 4
  };
  const scale = scales[unit];
  return scale ? Math.round(Number(match[1]) * scale) : undefined;
}

function startMemoryMonitor(containerId: string): Readonly<{
  peakBytes: () => number | undefined;
  stop: () => Promise<void>;
}> {
  const child = spawn("docker", [
    "stats",
    "--format",
    "{{.MemUsage}}",
    containerId
  ], { stdio: ["ignore", "pipe", "ignore"] });
  let carry = "";
  let peak: number | undefined;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));

  child.stdout.on("data", (value: Buffer) => {
    carry += value.toString("utf8");
    const lines = carry.split(/\r?\n/u);
    carry = lines.pop() ?? "";
    for (const line of lines) {
      const bytes = memoryBytes(line);
      if (bytes !== undefined) peak = Math.max(peak ?? 0, bytes);
    }
  });

  return Object.freeze({
    peakBytes: () => peak,
    stop: async () => {
      child.kill("SIGTERM");
      await closed;
    }
  });
}

function requestedPageCount(): number {
  const index = process.argv.indexOf("--pages");
  const pageCount = index >= 0 ? Number(process.argv[index + 1]) : Number.NaN;
  if (!MATRIX.includes(pageCount)) throw new Error("ocr_benchmark_invalid_page_count");
  return pageCount;
}

function configuredClientTimeoutMs(): number {
  const knowledgeConfig = getKnowledgeExtractionConfig();
  const parserConfig = getDocumentParserConfig(process.env, {
    requestMaxBytesDefault: knowledgeConfig.maxFileBytes
  });
  const clientTimeoutMs = parserConfig.docling?.timeoutMs;
  if (clientTimeoutMs === undefined) throw new Error("ocr_benchmark_docling_not_configured");
  return clientTimeoutMs;
}

async function runInsideContainer(): Promise<void> {
  benchmarkStage = "inside-preflight";
  const clientTimeoutMs = configuredClientTimeoutMs();
  if (process.argv.includes("--preflight")) {
    writeBoundedJson({ clientTimeoutMs });
    return;
  }
  if (clientTimeoutMs !== EXPECTED_CLIENT_TIMEOUT_MS) {
    throw new Error("ocr_benchmark_unsupported_client_timeout");
  }
  const pageCount = requestedPageCount();
  benchmarkStage = `fixture-${pageCount}`;
  const directory = await mkdtemp(join(tmpdir(), `aiqsa-ocr-benchmark-${pageCount}-`));

  try {
    const fixture = await createKnowledgeOcrFixtures({ directory, pageCount });
    const knowledgeConfig = getKnowledgeExtractionConfig();
    const parserConfig = getDocumentParserConfig(process.env, {
      requestMaxBytesDefault: knowledgeConfig.maxFileBytes
    });
    const parser = createDocumentParserBoundary({
      config: parserConfig,
      sidecarFallback: false
    });
    const startedAt = performance.now();

    try {
      benchmarkStage = `parse-${pageCount}`;
      const result = await parser.parse({
        bytes: fixture.imageOnlyPdf,
        fileName: `knowledge-ocr-${pageCount}.pdf`,
        mimeType: "application/pdf"
      });
      const parserWallTimeMs = Math.round(performance.now() - startedAt);
      const textEvidence = knowledgeOcrTextEvidence(result.text);
      const anchoredPageCount = new Set(result.blocks.map((block) => block.page)).size;
      benchmarkStage = `engine-${pageCount}`;
      assert.equal(result.engine, "docling");
      benchmarkStage = `page-count-${pageCount}`;
      assert.equal(result.pageCount, pageCount);
      benchmarkStage = `anchored-page-count-${pageCount}`;
      assert.equal(anchoredPageCount, pageCount);
      benchmarkStage = `page-anchor-range-${pageCount}`;
      assert(result.blocks.every((block) => block.page >= 1 && block.page <= pageCount));
      benchmarkStage = `text-evidence-${pageCount}`;
      assert.equal(textEvidence.useful, true);

      benchmarkStage = `evidence-${pageCount}`;
      writeBoundedJson({
        anchoredPageCount,
        boundaries: {
          clientTimeoutMs,
          doclingSyncWaitMs: DOCLING_SYNC_WAIT_MS,
          supportedProfile: true
        },
        completed: true,
        deadlineReached: false,
        inputBytes: fixture.imageOnlyPdf.byteLength,
        normalizedOutputBytes: Buffer.byteLength(result.text, "utf8"),
        pageCount: result.pageCount,
        parserWallTimeMs,
        status: result.status,
        textEvidence
      });
    } catch (error) {
      const parserWallTimeMs = Math.round(performance.now() - startedAt);
      if (isDocumentParserError(error) && error.code === "parser_timeout") {
        writeBoundedJson({
          completed: false,
          boundaries: {
            clientTimeoutMs,
            doclingSyncWaitMs: DOCLING_SYNC_WAIT_MS,
            supportedProfile: true
          },
          deadlineReached: true,
          errorCode: "parser_timeout",
          inputBytes: fixture.imageOnlyPdf.byteLength,
          pageCount,
          parserWallTimeMs
        });
        return;
      }
      if (isDocumentParserError(error)) benchmarkStage = `${error.code}-${pageCount}`;
      throw error;
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function serviceContainerId(service: "app" | "docling"): Promise<string> {
  const id = await checkedOutput(
    "docker",
    ["compose", "-f", COMPOSE_FILE, "ps", "-q", service],
    "ocr_benchmark_compose_unavailable"
  );
  if (!id) throw new Error(`ocr_benchmark_${service}_not_running`);
  return id.split(/\s+/u)[0];
}

async function inspectDoclingService(): Promise<DoclingInspection> {
  const id = await serviceContainerId("docling");
  const [
    health,
    image,
    baseDigest,
    imageVersion,
    resources,
    serverSyncWaitSeconds,
    runtimeEnvironment
  ] = await Promise.all([
    checkedOutput(
      "docker",
      ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", id],
      "ocr_benchmark_health_inspect_failed"
    ),
    checkedOutput("docker", ["inspect", "--format", "{{.Config.Image}}", id], "ocr_benchmark_image_inspect_failed"),
    checkedOutput(
      "docker",
      ["inspect", "--format", "{{index .Config.Labels \"org.opencontainers.image.base.digest\"}}", id],
      "ocr_benchmark_image_inspect_failed"
    ),
    checkedOutput(
      "docker",
      ["inspect", "--format", "{{index .Config.Labels \"org.opencontainers.image.version\"}}", id],
      "ocr_benchmark_image_inspect_failed"
    ),
    checkedOutput(
      "docker",
      ["inspect", "--format", "{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}", id],
      "ocr_benchmark_resource_inspect_failed"
    ),
    checkedOutput(
      "docker",
      [
        "inspect",
        "--format",
        `{{range .Config.Env}}{{if eq . "DOCLING_SERVE_MAX_SYNC_WAIT=${EXPECTED_SERVER_SYNC_WAIT_SECONDS}"}}${EXPECTED_SERVER_SYNC_WAIT_SECONDS}{{end}}{{end}}`,
        id
      ],
      "ocr_benchmark_server_wait_inspect_failed"
    ),
    checkedOutput(
      "docker",
      ["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", id],
      "ocr_benchmark_runtime_profile_inspect_failed"
    )
  ]);
  if (health !== "healthy") throw new Error("ocr_benchmark_docling_not_healthy");
  if (
    image !== EXPECTED_IMAGE
    || baseDigest !== EXPECTED_IMAGE_BASE_DIGEST
    || imageVersion !== EXPECTED_IMAGE_VERSION
  ) {
    throw new Error("ocr_benchmark_requires_current_docling_image");
  }
  const [nanoCpus, memoryLimitBytes] = resources.split(/\s+/u).map(Number);
  if (!Number.isFinite(nanoCpus) || !Number.isFinite(memoryLimitBytes)) {
    throw new Error("ocr_benchmark_resource_evidence_invalid");
  }
  if (serverSyncWaitSeconds !== String(EXPECTED_SERVER_SYNC_WAIT_SECONDS)) {
    throw new Error("ocr_benchmark_server_wait_evidence_invalid");
  }
  const runtimeEnv = new Set(runtimeEnvironment.split(/\r?\n/u).filter(Boolean));
  if (!EXPECTED_RUNTIME_ENV.every((entry) => runtimeEnv.has(entry))) {
    throw new Error("ocr_benchmark_runtime_profile_invalid");
  }

  return Object.freeze({
    baseDigest,
    cpuLimit: nanoCpus / 1_000_000_000,
    id,
    image,
    imageVersion,
    memoryLimitBytes,
    serverSyncWaitMs: Number(serverSyncWaitSeconds) * 1_000
  });
}

async function inspectClientTimeoutMs(): Promise<number> {
  const output = await checkedOutput(
    "docker",
    [
      "compose",
      "-f",
      COMPOSE_FILE,
      "exec",
      "-T",
      "app",
      "./node_modules/.bin/tsx",
      "scripts/benchmark-knowledge-ocr.ts",
      "--inside",
      "--preflight"
    ],
    "ocr_benchmark_client_timeout_inspect_failed"
  );
  const line = output.split(/\r?\n/u).at(-1);
  if (!line) throw new Error("ocr_benchmark_client_timeout_evidence_invalid");
  const evidence = JSON.parse(line) as Record<string, unknown>;
  if (!Number.isSafeInteger(evidence.clientTimeoutMs)) {
    throw new Error("ocr_benchmark_client_timeout_evidence_invalid");
  }
  return evidence.clientTimeoutMs as number;
}

async function recreateDoclingService(errorCode: string): Promise<void> {
  await checkedOutput(
    "docker",
    [
      "compose",
      "-f",
      COMPOSE_FILE,
      "up",
      "-d",
      "--no-deps",
      "--force-recreate",
      "--no-build",
      "--pull",
      "never",
      "--wait",
      "--wait-timeout",
      "300",
      "docling"
    ],
    errorCode
  );
}

async function verifyDoclingOcrAssets(containerId: string): Promise<void> {
  const output = await checkedOutput(
    "docker",
    ["exec", containerId, "python", OCR_ASSET_VERIFIER_PATH],
    "ocr_benchmark_asset_verification_failed"
  );
  const line = output.split(/\r?\n/u).at(-1);
  if (!line) throw new Error("ocr_benchmark_asset_evidence_invalid");
  const evidence = JSON.parse(line) as Record<string, unknown>;
  const versions = evidence.versions as Record<string, unknown> | undefined;
  if (
    evidence.offlineReaderReady !== true
    || evidence.modelCount !== 2
    || JSON.stringify(evidence.languages) !== JSON.stringify(["ru", "en"])
    || versions?.docling !== "2.96.1"
    || versions?.["docling-serve"] !== "1.21.0"
    || versions?.easyocr !== "1.7.2"
  ) {
    throw new Error("ocr_benchmark_asset_evidence_invalid");
  }
}

function assertCanonicalProfile(inspection: DoclingInspection, clientTimeoutMs: number): void {
  if (
    inspection.cpuLimit !== EXPECTED_CPU_LIMIT
    || inspection.memoryLimitBytes !== EXPECTED_MEMORY_LIMIT_BYTES
    || inspection.serverSyncWaitMs !== DOCLING_SYNC_WAIT_MS
    || clientTimeoutMs !== EXPECTED_CLIENT_TIMEOUT_MS
  ) {
    throw new Error("ocr_benchmark_requires_canonical_profile");
  }
}

async function recoverTimedOutDocling(
  previousId: string,
  clientTimeoutMs: number,
  reason: "container-oom" | "parser-timeout"
): Promise<Readonly<{
  inspection: DoclingInspection;
  output: Readonly<Record<string, unknown>>;
}>> {
  // Aborting the app request does not guarantee cancellation of Docling's
  // synchronous task. Replace only the disposable dev worker so a timed-out
  // matrix case cannot consume resources during the following measurement.
  await recreateDoclingService("ocr_benchmark_docling_recovery_failed");
  const inspection = await inspectDoclingService();
  if (inspection.id === previousId) throw new Error("ocr_benchmark_docling_recovery_did_not_replace_container");
  assertCanonicalProfile(inspection, clientTimeoutMs);
  await verifyDoclingOcrAssets(inspection.id);

  return Object.freeze({
    inspection,
    output: Object.freeze({
      composeFile: COMPOSE_FILE,
      containerReplaced: true,
      dependenciesRecreated: false,
      imageBuildAllowed: false,
      imagePullAllowed: false,
      imageVerified: true,
      offlineOcrAssetsVerified: true,
      performed: true,
      reason,
      service: "docling",
      succeeded: true,
      waitedForHealthy: true
    })
  });
}

async function runMatrixCase(input: Readonly<{
  cpuLimit: number;
  doclingId: string;
  memoryLimitBytes: number;
  pageCount: number;
}>): Promise<MatrixCaseResult> {
  const monitor = startMemoryMonitor(input.doclingId);
  const startedAtEpochMs = Date.now();
  const startedAt = performance.now();
  let command: CapturedCommand;
  try {
    command = await capture("docker", [
      "compose",
      "-f",
      COMPOSE_FILE,
      "exec",
      "-T",
      "app",
      "./node_modules/.bin/tsx",
      "scripts/benchmark-knowledge-ocr.ts",
      "--inside",
      "--pages",
      String(input.pageCount)
    ]);
  } finally {
    await monitor.stop();
  }
  const commandWallTimeMs = Math.round(performance.now() - startedAt);
  const peakMemoryBytes = monitor.peakBytes();
  if (peakMemoryBytes === undefined) throw new Error("ocr_benchmark_memory_evidence_missing");
  if (command.code !== 0) {
    const candidate = command.stderr.trim().split(/\r?\n/u).at(-1);
    const errorCode = candidate && /^knowledge_ocr_benchmark_failed_[a-z0-9_-]+$/u.test(candidate)
      ? candidate
      : "ocr_benchmark_case_failed";
    const events = await capture("docker", [
      "events",
      "--since",
      new Date(startedAtEpochMs).toISOString(),
      "--until",
      new Date().toISOString(),
      "--filter",
      `container=${input.doclingId}`,
      "--filter",
      "event=oom",
      "--format",
      "{{.Action}}"
    ]);
    const containerOom = events.code === 0
      && events.stdout.split(/\s+/u).includes("oom");
    if (containerOom) {
      return Object.freeze({
        deadlineReached: false,
        output: Object.freeze({
          commandWallTimeMs,
          fixture: {
            colorMode: "png-grayscale-color-type-0",
            dpi: KNOWLEDGE_OCR_DPI,
            pageHeightPx: KNOWLEDGE_OCR_PAGE_HEIGHT_PX,
            pageWidthPx: KNOWLEDGE_OCR_PAGE_WIDTH_PX,
            paper: "A4",
            repeatedPage: true
          },
          pageCount: input.pageCount,
          parser: {
            completed: false,
            deadlineReached: false,
            errorCode: "container_oom",
            memoryLimitReached: true,
            pageCount: input.pageCount
          },
          resources: {
            cpuLimit: input.cpuLimit,
            memoryLimitBytes: input.memoryLimitBytes,
            peakMemoryBytes,
            peakSampling: "docker-stats-1s",
            supportedProfile: true
          }
        }),
        recoveryReason: "container-oom"
      });
    }
    writeBoundedJson({ errorCode, event: "case-failed", pageCount: input.pageCount });
    throw new Error("ocr_benchmark_case_failed");
  }
  const line = command.stdout.trim().split(/\r?\n/u).at(-1);
  if (!line) throw new Error("ocr_benchmark_case_missing_evidence");
  const evidence = JSON.parse(line) as Record<string, unknown>;
  if (typeof evidence.deadlineReached !== "boolean") throw new Error("ocr_benchmark_case_invalid_evidence");

  return Object.freeze({
    deadlineReached: evidence.deadlineReached,
    output: Object.freeze({
      commandWallTimeMs,
      fixture: {
        colorMode: "png-grayscale-color-type-0",
        dpi: KNOWLEDGE_OCR_DPI,
        pageHeightPx: KNOWLEDGE_OCR_PAGE_HEIGHT_PX,
        pageWidthPx: KNOWLEDGE_OCR_PAGE_WIDTH_PX,
        paper: "A4",
        repeatedPage: true
      },
      pageCount: input.pageCount,
      parser: evidence,
      resources: {
        cpuLimit: input.cpuLimit,
        memoryLimitBytes: input.memoryLimitBytes,
        peakMemoryBytes,
        peakSampling: "docker-stats-1s",
        supportedProfile: true
      }
    }),
    ...(evidence.deadlineReached ? { recoveryReason: "parser-timeout" as const } : {})
  });
}

async function runFromHost(): Promise<void> {
  benchmarkStage = "host-app";
  await serviceContainerId("app");
  benchmarkStage = "host-preparation";
  const previousDoclingId = await serviceContainerId("docling");
  await recreateDoclingService("ocr_benchmark_docling_preparation_failed");
  let docling = await inspectDoclingService();
  if (docling.id === previousDoclingId) {
    throw new Error("ocr_benchmark_docling_preparation_did_not_replace_container");
  }
  const clientTimeoutMs = await inspectClientTimeoutMs();
  benchmarkStage = "host-preflight";
  assertCanonicalProfile(docling, clientTimeoutMs);
  await verifyDoclingOcrAssets(docling.id);
  writeBoundedJson({
    boundaries: {
      clientTimeoutMs,
      cpuLimit: docling.cpuLimit,
      memoryLimitBytes: docling.memoryLimitBytes,
      serverSyncWaitMs: docling.serverSyncWaitMs
    },
    event: "preflight",
    image: {
      baseDigestLabel: docling.baseDigest,
      tag: docling.image,
      versionLabel: docling.imageVersion
    },
    matrix: MATRIX,
    offlineOcrAssetsVerified: true,
    preparation: {
      containerReplaced: true,
      dependenciesRecreated: false,
      imageBuildAllowed: false,
      imagePullAllowed: false
    },
    runtimeProfileVerified: true,
    supportedProfile: true
  });

  for (const pageCount of MATRIX) {
    benchmarkStage = `host-case-${pageCount}`;
    const result = await runMatrixCase({
      cpuLimit: docling.cpuLimit,
      doclingId: docling.id,
      memoryLimitBytes: docling.memoryLimitBytes,
      pageCount
    });
    let recovery: Readonly<Record<string, unknown>> = Object.freeze({
      performed: false,
      reason: "not-required",
      succeeded: true
    });
    if (result.recoveryReason) {
      benchmarkStage = `host-recovery-${pageCount}`;
      try {
        const recovered = await recoverTimedOutDocling(
          docling.id,
          clientTimeoutMs,
          result.recoveryReason
        );
        docling = recovered.inspection;
        recovery = recovered.output;
      } catch {
        writeBoundedJson({
          ...result.output,
          recovery: {
            errorCode: "docling_recovery_failed",
            performed: true,
            reason: result.recoveryReason,
            succeeded: false
          }
        });
        throw new Error("ocr_benchmark_docling_recovery_failed");
      }
    }
    writeBoundedJson({
      ...result.output,
      recovery
    });
    if (pageCount === 10 && result.recoveryReason) {
      throw new Error("ocr_benchmark_ten_page_failed");
    }
  }
}

const insideContainer = process.argv.includes("--inside");
(insideContainer ? runInsideContainer() : runFromHost()).catch((error: unknown) => {
  const message = error instanceof Error && /^[a-z0-9_-]{1,120}$/u.test(error.message)
    ? error.message
    : benchmarkStage;
  process.stderr.write(`knowledge_ocr_benchmark_failed_${message}\n`);
  process.exitCode = 1;
});
