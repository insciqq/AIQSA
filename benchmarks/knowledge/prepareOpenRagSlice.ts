import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync
} from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolve } from "node:path";
import {
  OPEN_RAG_MAX_PDF_BYTES,
  OPEN_RAG_METADATA_FILES,
  OPEN_RAG_SLICE_SEED,
  OPEN_RAG_UPSTREAM_REVISION,
  assertOpenRagPdfShape,
  buildOpenRagRunnerBundle,
  decodeOpenRagMetadata,
  selectOpenRagSlice,
  type OpenRagSliceDocument,
  type OpenRagSliceManifest
} from "./openRagSlice";

type Options = Readonly<{
  concurrency: number;
  download: boolean;
  metadataDirectory: string;
  outputRoot: string;
  prepareRunner: boolean;
}>;

const defaultMetadataDirectory = resolve(
  "benchmarks/knowledge/.data/datasets/open-ragbench"
);
const defaultOutputRoot = resolve(
  "benchmarks/knowledge/.data/open-rag-pdf-slices"
);

function parsePositiveInteger(value: string | undefined, code: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 8) {
    throw new Error(code);
  }
  return parsed;
}

function parseOptions(argv: string[]): Options {
  let concurrency = 4;
  let download = false;
  let metadataDirectory = defaultMetadataDirectory;
  let outputRoot = defaultOutputRoot;
  let prepareRunner = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--download") {
      download = true;
    } else if (argument === "--prepare-runner") {
      prepareRunner = true;
    } else if (argument === "--concurrency") {
      concurrency = parsePositiveInteger(argv[++index], "open_rag_concurrency_invalid");
    } else if (argument === "--metadata-directory") {
      const value = argv[++index];
      if (!value) throw new Error("open_rag_metadata_directory_invalid");
      metadataDirectory = resolve(value);
    } else if (argument === "--output-root") {
      const value = argv[++index];
      if (!value) throw new Error("open_rag_output_root_invalid");
      outputRoot = resolve(value);
    } else {
      throw new Error(`open_rag_argument_unknown:${argument}`);
    }
  }
  return Object.freeze({
    concurrency,
    download,
    metadataDirectory,
    outputRoot,
    prepareRunner
  });
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    }
  }), new Transform({
    transform(_chunk: Buffer, _encoding, callback) {
      callback();
    }
  }));
  return hash.digest("hex");
}

async function loadPinnedJson(
  directory: string,
  fileName: keyof typeof OPEN_RAG_METADATA_FILES
): Promise<unknown> {
  const path = resolve(directory, fileName);
  const [content, details] = await Promise.all([readFile(path), stat(path)]);
  const expected = OPEN_RAG_METADATA_FILES[fileName];
  const actualHash = createHash("sha256").update(content).digest("hex");
  if (details.size !== expected.bytes || actualHash !== expected.sha256) {
    throw new Error(`open_rag_metadata_pin_mismatch:${fileName}`);
  }
  return JSON.parse(content.toString("utf8")) as unknown;
}

async function loadSlice(metadataDirectory: string): Promise<OpenRagSliceManifest> {
  const [answers, pdfUrls, qrels, queries] = await Promise.all([
    loadPinnedJson(metadataDirectory, "answers.json"),
    loadPinnedJson(metadataDirectory, "pdf_urls.json"),
    loadPinnedJson(metadataDirectory, "qrels.json"),
    loadPinnedJson(metadataDirectory, "queries.json")
  ]);
  return selectOpenRagSlice(decodeOpenRagMetadata({
    answers,
    pdfUrls,
    qrels,
    queries
  }));
}

async function ensureManifest(directory: string, manifest: OpenRagSliceManifest): Promise<void> {
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, "slice.json");
  const encoded = `${JSON.stringify(manifest, null, 2)}\n`;
  if (existsSync(path)) {
    if (await readFile(path, "utf8") !== encoded) {
      throw new Error("open_rag_existing_slice_manifest_mismatch");
    }
    return;
  }
  await writeFile(path, encoded, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function assertResponseUrl(value: string): void {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" ||
    (parsed.hostname !== "arxiv.org" && !parsed.hostname.endsWith(".arxiv.org")) ||
    parsed.username || parsed.password) {
    throw new Error("open_rag_pdf_redirect_invalid");
  }
}

async function validatePdfFile(path: string): Promise<Readonly<{
  bytes: number;
  sha256: string;
}>> {
  const details = await stat(path);
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(5);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    assertOpenRagPdfShape(header.subarray(0, bytesRead), details.size);
  } finally {
    await file.close();
  }
  return Object.freeze({ bytes: details.size, sha256: await sha256File(path) });
}

async function fetchWithRetries(url: string, start: number): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          ...(start > 0 ? { Range: `bytes=${start}-` } : {}),
          "User-Agent": "AIQSA-public-knowledge-benchmark/1"
        },
        redirect: "follow",
        signal: AbortSignal.timeout(120_000)
      });
      assertResponseUrl(response.url);
      if ((start === 0 && response.status === 200) ||
        (start > 0 && response.status === 206) ||
        (start > 0 && response.status === 200)) {
        return response;
      }
      if (response.status !== 408 && response.status !== 429 && response.status < 500) {
        throw new Error(`open_rag_pdf_http_status:${response.status}`);
      }
      lastError = new Error(`open_rag_pdf_http_retryable:${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500 * (2 ** attempt)));
  }
  throw lastError instanceof Error ? lastError : new Error("open_rag_pdf_download_failed");
}

async function downloadDocument(
  directory: string,
  document: OpenRagSliceDocument
): Promise<Readonly<{ bytes: number; docId: string; sha256: string }>> {
  const finalPath = resolve(directory, document.fileName);
  const partialPath = `${finalPath}.part`;
  if (existsSync(finalPath)) {
    return Object.freeze({ docId: document.id, ...(await validatePdfFile(finalPath)) });
  }
  await mkdir(directory, { recursive: true });

  let start = existsSync(partialPath) ? (await stat(partialPath)).size : 0;
  if (start > OPEN_RAG_MAX_PDF_BYTES) {
    throw new Error("open_rag_pdf_partial_oversized");
  }
  let response = await fetchWithRetries(document.url, start);
  if (start > 0 && response.status === 200) {
    start = 0;
    response = await fetchWithRetries(document.url, 0);
  }
  if (!response.body) throw new Error("open_rag_pdf_body_missing");
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/pdf") throw new Error("open_rag_pdf_content_type_invalid");
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) &&
    (contentLength < 1 || start + contentLength > OPEN_RAG_MAX_PDF_BYTES)) {
    throw new Error("open_rag_pdf_content_length_invalid");
  }

  let bytes = start;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > OPEN_RAG_MAX_PDF_BYTES) {
        callback(new Error("open_rag_pdf_stream_oversized"));
      } else {
        callback(null, chunk);
      }
    }
  });
  await pipeline(
    Readable.fromWeb(response.body as never),
    counter,
    createWriteStream(partialPath, { flags: start > 0 ? "a" : "w", mode: 0o600 })
  );
  await validatePdfFile(partialPath);
  await rename(partialPath, finalPath);
  return Object.freeze({ docId: document.id, ...(await validatePdfFile(finalPath)) });
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index]!);
    }
  }));
  return results;
}

async function writeExactPrivateFile(path: string, content: string): Promise<void> {
  if (existsSync(path)) {
    if (await readFile(path, "utf8") !== content) {
      throw new Error("open_rag_runner_existing_file_mismatch");
    }
    return;
  }
  await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

async function prepareRunnerBundle(
  sliceDirectory: string,
  manifest: OpenRagSliceManifest
): Promise<void> {
  const pdfDirectory = resolve(sliceDirectory, "pdfs");
  for (const document of manifest.documents) {
    await validatePdfFile(resolve(pdfDirectory, document.fileName));
  }
  const bundle = buildOpenRagRunnerBundle(manifest);
  for (const [docId, sidecar] of Object.entries(bundle.sidecars)) {
    await writeExactPrivateFile(resolve(pdfDirectory, `${docId}.txt`), sidecar);
  }
  const runnerDirectory = resolve(sliceDirectory, "runner");
  await mkdir(runnerDirectory, { recursive: true });
  await writeExactPrivateFile(
    resolve(runnerDirectory, "questions.json"),
    `${JSON.stringify(bundle.questions, null, 2)}\n`
  );
  await writeExactPrivateFile(
    resolve(runnerDirectory, "alias-map.json"),
    `${JSON.stringify(bundle.aliases, null, 2)}\n`
  );
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const manifest = await loadSlice(options.metadataDirectory);
  const sliceDirectory = resolve(options.outputRoot, manifest.selectionFingerprint);
  await ensureManifest(sliceDirectory, manifest);
  const positiveCount = manifest.documents.filter(({ role }) => role === "positive").length;
  const negativeCount = manifest.documents.length - positiveCount;
  console.log(JSON.stringify({
    dataset: "open-rag",
    documents: manifest.documents.length,
    downloadRequested: options.download,
    negativeDocuments: negativeCount,
    positiveDocuments: positiveCount,
    questions: manifest.questions.length,
    revision: OPEN_RAG_UPSTREAM_REVISION,
    seed: OPEN_RAG_SLICE_SEED,
    selectionFingerprint: manifest.selectionFingerprint,
    prepareRunnerRequested: options.prepareRunner
  }));
  if (options.download) {
    const downloads = await mapConcurrent(
      manifest.documents,
      options.concurrency,
      (document) => downloadDocument(resolve(sliceDirectory, "pdfs"), document)
    );
    const downloadManifest = Object.freeze({
      documents: downloads.sort((left, right) => left.docId.localeCompare(right.docId)),
      selectionFingerprint: manifest.selectionFingerprint
    });
    await writeFile(
      resolve(sliceDirectory, "downloads.json"),
      `${JSON.stringify(downloadManifest, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    console.log(JSON.stringify({
      downloadedDocuments: downloads.length,
      totalBytes: downloads.reduce((sum, entry) => sum + entry.bytes, 0),
      validated: true
    }));
  }
  if (options.prepareRunner) {
    await prepareRunnerBundle(sliceDirectory, manifest);
    console.log(JSON.stringify({
      evaluatorQuestionCount: manifest.questions.length,
      runnerBundleReady: true,
      sidecarCount: manifest.documents.length
    }));
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "open_rag_prepare_failed");
  process.exitCode = 1;
});
