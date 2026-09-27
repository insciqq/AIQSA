import {
  spawn as spawnProcess,
  type ChildProcess,
  type SpawnOptions
} from "node:child_process";
import type { Readable } from "node:stream";
import type { StructuredDocumentFormat } from "../../domain/uploadFormats";
import { applicationRootPath } from "../runtimeModulePath";
import { withPdfWorkerAdmission } from "../uploads/pdfWorkerAdmission";
import type { TextDocumentExtractionResult } from "../uploads/textDocuments";
import { DocumentParserError } from "./errors";
import { SPREADSHEET_DEFAULT_MAX_CHARACTERS } from "./spreadsheetLimits";
import type { DocumentParserEngine, ParsedDocument } from "./types";

const ISOLATED_PARSER_TIMEOUT_MS = 120_000;
const ISOLATED_PARSER_HEAP_MB = 768;
const ISOLATED_PARSER_MEMORY_BUDGET_BYTES = 1_024 * 1_024 * 1_024;

const CHILD_ENTRY = "lib/server/parsing/isolatedParserChild.ts";
const OUTPUT_BASE_BYTES = 64 * 1_024 * 1_024;
const OUTPUT_BYTES_PER_CHARACTER = 16;
const EXIT_WAIT_MS = 5_000;
const MAX_TIMER_MS = 2_147_483_647;
const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";

export type SpawnIsolatedParser = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export type IsolatedParserOptions = Readonly<{
  maxOutputBytes?: number;
  memoryBudgetBytes?: number;
  spawn?: SpawnIsolatedParser;
  timeoutMs?: number;
}>;

type ChildRequest = Readonly<Record<string, number | string>>;

type IsolatedRun = Readonly<{
  bytes: Buffer;
  engine: DocumentParserEngine;
  maxOutputBytes: number;
  memoryBudgetBytes: number;
  request: ChildRequest;
  signal?: AbortSignal;
  spawn: SpawnIsolatedParser;
  timeoutMs: number;
}>;

type Outcome = Readonly<{ error: unknown }> | Readonly<{ value: unknown }>;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveLimit(
  value: number | undefined,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError("isolated_parser_limit_invalid");
  }
  return value;
}

function childEnvironment(): NodeJS.ProcessEnv {
  // Only what the runtime needs: no application secrets or configuration.
  return {
    NODE_ENV: process.env.NODE_ENV,
    PATH: process.env.PATH ?? DEFAULT_PATH,
    TSX_DISABLE_CACHE: "1"
  };
}

function childSignalError(signal: NodeJS.Signals, engine: DocumentParserEngine): DocumentParserError {
  if (signal === "SIGXCPU") return new DocumentParserError("parser_timeout", engine);
  // V8 aborts when its heap or the address-space limit is exhausted; an
  // unrequested SIGKILL comes from the kernel's memory pressure handling.
  if (signal === "SIGABRT" || signal === "SIGTRAP" || signal === "SIGKILL") {
    return new DocumentParserError("parser_output_too_large", engine);
  }
  return new DocumentParserError("parser_unavailable", engine);
}

function decodedMessage(output: Buffer, engine: DocumentParserEngine): Outcome {
  let message: unknown;
  try {
    message = JSON.parse(output.toString("utf8"));
  } catch {
    return { error: new DocumentParserError("parser_invalid_output", engine) };
  }
  if (isRecord(message) && message.ok === true && "result" in message) {
    return { value: message.result };
  }
  if (
    isRecord(message) && message.ok === false &&
    (message.code === "parser_rejected" || message.code === "parser_output_too_large")
  ) return { error: new DocumentParserError(message.code, engine) };
  return { error: new DocumentParserError("parser_invalid_output", engine) };
}

/**
 * Runs one parser process. It settles only after the process exited (or a
 * bounded wait after SIGKILL elapsed) and its process group was killed, so the
 * shared admission slot also covers termination.
 */
function runIsolatedChild(run: IsolatedRun): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const header = Buffer.from(JSON.stringify(run.request), "utf8");
    const headerLength = Buffer.alloc(4);
    headerLength.writeUInt32BE(header.byteLength);
    let child: ChildProcess;
    try {
      child = run.spawn(process.execPath, [
        `--max-old-space-size=${ISOLATED_PARSER_HEAP_MB}`,
        "--import",
        "tsx",
        CHILD_ENTRY,
        String(run.memoryBudgetBytes),
        // A CPU budget above the wall-clock deadline survives a stalled parent.
        String(Math.max(1, Math.ceil(2 * run.timeoutMs / 1_000)))
      ], {
        cwd: applicationRootPath(),
        // A new process group lets termination include descendants.
        detached: true,
        env: childEnvironment(),
        stdio: ["pipe", "ignore", "ignore", "pipe"]
      });
    } catch {
      reject(new DocumentParserError("parser_unavailable", run.engine));
      return;
    }

    const output = child.stdio[3] as Readable | null | undefined;
    const chunks: Buffer[] = [];
    let received = 0;
    let termination: "abort" | "overflow" | "timeout" | null = null;
    let exit: Readonly<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
    let failed = false;
    let settled = false;
    let exitWait: ReturnType<typeof setTimeout> | undefined;

    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group has already exited.
      }
    };
    const outcome = (): Outcome => {
      if (termination === "abort") return { error: abortReason(run.signal!) };
      if (termination === "timeout") {
        return { error: new DocumentParserError("parser_timeout", run.engine) };
      }
      if (termination === "overflow") {
        return { error: new DocumentParserError("parser_output_too_large", run.engine) };
      }
      if (failed || !exit) return { error: new DocumentParserError("parser_unavailable", run.engine) };
      if (exit.signal) return { error: childSignalError(exit.signal, run.engine) };
      if (exit.code !== 0) return { error: new DocumentParserError("parser_unavailable", run.engine) };
      return decodedMessage(Buffer.concat(chunks, received), run.engine);
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(exitWait);
      run.signal?.removeEventListener("abort", onAbort);
      child.stdin?.destroy();
      output?.destroy();
      const result = outcome();
      chunks.length = 0;
      if ("error" in result) reject(result.error);
      else resolve(result.value);
    };
    const waitForExit = () => {
      exitWait ??= setTimeout(settle, EXIT_WAIT_MS);
      exitWait.unref?.();
    };
    const terminate = (reason: "abort" | "overflow" | "timeout") => {
      termination ??= reason;
      killGroup();
      waitForExit();
    };
    const onAbort = () => terminate("abort");
    const deadline = setTimeout(() => terminate("timeout"), run.timeoutMs);
    deadline.unref?.();

    child.once("error", () => {
      failed = true;
      killGroup();
      if (child.pid === undefined) settle();
      else waitForExit();
    });
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      clearTimeout(deadline);
      // Descendants such as the TypeScript transformer share the group.
      killGroup();
      waitForExit();
    });
    child.once("close", settle);
    output?.on("error", () => undefined);
    output?.on("data", (chunk: Buffer) => {
      if (termination !== null) return;
      received += chunk.byteLength;
      if (received > run.maxOutputBytes) {
        chunks.length = 0;
        terminate("overflow");
        return;
      }
      chunks.push(chunk);
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.write(headerLength);
    child.stdin?.write(header);
    child.stdin?.end(run.bytes);
    run.signal?.addEventListener("abort", onAbort, { once: true });
    if (run.signal?.aborted) onAbort();
  });
}

function isolatedParse(
  input: Readonly<{
    bytes: Buffer;
    engine: DocumentParserEngine;
    maxOutputBytes: number;
    request: ChildRequest;
    signal?: AbortSignal;
  }>,
  options: IsolatedParserOptions
): Promise<unknown> {
  const run: IsolatedRun = {
    bytes: input.bytes,
    engine: input.engine,
    maxOutputBytes: positiveLimit(options.maxOutputBytes, input.maxOutputBytes),
    memoryBudgetBytes: positiveLimit(
      options.memoryBudgetBytes,
      ISOLATED_PARSER_MEMORY_BUDGET_BYTES
    ),
    request: input.request,
    ...(input.signal ? { signal: input.signal } : {}),
    spawn: options.spawn ?? spawnProcess,
    timeoutMs: positiveLimit(options.timeoutMs, ISOLATED_PARSER_TIMEOUT_MS, MAX_TIMER_MS)
  };
  if (input.signal?.aborted) return Promise.reject(abortReason(input.signal));
  // Share the local PDF memory slot; the deadline starts only after admission.
  return withPdfWorkerAdmission(() => runIsolatedChild(run), input.signal);
}

function everyRecord(
  value: unknown,
  predicate: (entry: Record<string, unknown>) => boolean = () => true
): boolean {
  return Array.isArray(value) && value.every((entry) => isRecord(entry) && predicate(entry));
}

function everyString(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function deepFreeze<T>(value: T): T {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null || Object.isFrozen(current)) continue;
    Object.freeze(current);
    for (const entry of Object.values(current)) pending.push(entry);
  }
  return value;
}

function spreadsheetDocument(value: unknown, mediaType: string): ParsedDocument {
  const workbook = isRecord(value) ? value.workbook : null;
  if (
    !isRecord(value) || value.engine !== "spreadsheet" || value.mediaType !== mediaType ||
    value.status !== "complete" && value.status !== "partial" ||
    typeof value.text !== "string" || !Number.isSafeInteger(value.pageCount) ||
    Number(value.pageCount) < 1 || !isRecord(value.quality) ||
    !everyRecord(value.blocks, (block) => typeof block.text === "string") ||
    !everyRecord(value.attempts) || !Array.isArray(value.assets) ||
    !Array.isArray(value.fieldGroups) || !everyString(value.languages) ||
    !everyString(value.warnings) || !isRecord(workbook) ||
    !everyRecord(workbook.sheets, (sheet) => Array.isArray(sheet.cells) &&
      Array.isArray(sheet.regions) && Array.isArray(sheet.merges)) ||
    !everyString(workbook.warnings)
  ) throw new DocumentParserError("parser_invalid_output", "spreadsheet");
  return deepFreeze(value) as ParsedDocument;
}

/**
 * Parses CSV, XLS, XLSX and ODS in a disposable, resource-limited process so
 * hostile workbooks cannot exhaust the application's memory or event loop.
 */
export async function parseSpreadsheetInIsolation(
  input: Readonly<{
    bytes: Buffer;
    format: StructuredDocumentFormat;
    maxCharacters?: number;
    mediaType: string;
    signal?: AbortSignal;
  }>,
  options: IsolatedParserOptions = {}
): Promise<ParsedDocument> {
  const maxCharacters = Math.max(1, Math.floor(
    input.maxCharacters ?? SPREADSHEET_DEFAULT_MAX_CHARACTERS
  ));
  const value = await isolatedParse({
    bytes: input.bytes,
    engine: "spreadsheet",
    maxOutputBytes: OUTPUT_BASE_BYTES + OUTPUT_BYTES_PER_CHARACTER * maxCharacters,
    request: {
      byteLength: input.bytes.byteLength,
      format: input.format,
      maxCharacters,
      mediaType: input.mediaType,
      op: "spreadsheet"
    },
    ...(input.signal ? { signal: input.signal } : {})
  }, options);
  return spreadsheetDocument(value, input.mediaType);
}

/** Extracts inline HTML text in the same disposable, resource-limited process. */
export async function extractHtmlTextInIsolation(
  input: Readonly<{ bytes: Buffer; maxChars: number; signal?: AbortSignal }>,
  options: IsolatedParserOptions = {}
): Promise<TextDocumentExtractionResult> {
  const maxChars = Math.max(1, Math.floor(input.maxChars));
  const value = await isolatedParse({
    bytes: input.bytes,
    engine: "inline",
    maxOutputBytes: OUTPUT_BASE_BYTES + OUTPUT_BYTES_PER_CHARACTER * maxChars,
    request: { byteLength: input.bytes.byteLength, maxChars, op: "html" },
    ...(input.signal ? { signal: input.signal } : {})
  }, options);
  if (
    !isRecord(value) || value.kind !== "html" || typeof value.text !== "string" ||
    value.text.length > maxChars || typeof value.truncated !== "boolean"
  ) throw new DocumentParserError("parser_invalid_output", "inline");
  return { kind: "html", text: value.text, truncated: value.truncated };
}
