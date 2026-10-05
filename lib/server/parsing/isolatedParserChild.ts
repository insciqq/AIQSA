/**
 * Disposable parser process started by isolatedParser.ts. It receives no IPC,
 * secrets or file name: stdin carries a length-prefixed JSON header and the
 * document, and fd 3 carries one JSON result. Imports stay limited to pure
 * parsers so the process never loads configuration, database or provider code.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, writeSync } from "node:fs";
import { extractTextDocument } from "../uploads/textDocuments";
import { extractPage } from "../webFetch/extract";
import { FETCH_URL_MAX_LENGTH } from "../webFetch/urls";
import { isDocumentParserError } from "./errors";
import { parseSpreadsheetDocument } from "./spreadsheet";

const SETUP_FAILURE_EXIT_CODE = 78;
const PROTOCOL_FAILURE_EXIT_CODE = 65;
const RESULT_FD = 3;
const MAX_HEADER_BYTES = 4_096;
const MAX_MEDIA_TYPE_LENGTH = 255;
/** A fetched page's Content-Type header value, charset parameter included. */
const MAX_PAGE_CONTENT_TYPE_LENGTH = 512;
const SPREADSHEET_FORMATS: ReadonlySet<string> = new Set(["csv", "ods", "xls", "xlsx"]);

type ChildRequest =
  | Readonly<{ format: string; maxCharacters: number; mediaType: string; op: "spreadsheet" }>
  | Readonly<{ maxChars: number; op: "html" }>
  | Readonly<{ contentType: string; finalUrl: string; maxCharacters: number; op: "page" }>;

type DecodedRequest = Readonly<{ bytes: Buffer; request: ChildRequest }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function limitValues(limits: string, label: string): readonly [number, number] | null {
  const line = limits.split("\n").find((candidate) => candidate.startsWith(label));
  const values = line?.slice(label.length).trim().split(/\s+/u) ?? [];
  const soft = Number(values[0]);
  const hard = Number(values[1]);
  return Number.isSafeInteger(soft) && Number.isSafeInteger(hard) ? [soft, hard] : null;
}

/**
 * Applies the address-space and CPU limits to this process before any input is
 * read, and proves them from /proc. Failure exits before parsing (fail closed).
 */
function confineProcess(): void {
  const [memoryBudgetBytes, cpuSeconds] = process.argv.slice(2).map(Number);
  if (!positiveInteger(memoryBudgetBytes) || !positiveInteger(cpuSeconds)) {
    process.exit(SETUP_FAILURE_EXIT_CODE);
  }
  try {
    // Prefer this process over the application when the container runs out of memory.
    writeFileSync("/proc/self/oom_score_adj", "1000");
  } catch {
    // Best effort: the address-space limit below remains mandatory.
  }
  const dataKiB = /^VmData:\s+(\d+) kB$/mu.exec(readFileSync("/proc/self/status", "utf8"))?.[1];
  if (!dataKiB) process.exit(SETUP_FAILURE_EXIT_CODE);
  // The runtime baseline differs across Node versions, so the budget is relative.
  const dataLimit = Number(dataKiB) * 1_024 + memoryBudgetBytes;
  const applied = spawnSync("prlimit", [
    "--pid", String(process.pid),
    `--data=${dataLimit}:${dataLimit}`,
    `--cpu=${cpuSeconds}:${cpuSeconds + 1}`,
    "--core=0:0"
  ], { stdio: "ignore", timeout: 10_000 });
  const limits = readFileSync("/proc/self/limits", "utf8");
  const data = limitValues(limits, "Max data size");
  const cpu = limitValues(limits, "Max cpu time");
  const core = limitValues(limits, "Max core file size");
  if (
    applied.status !== 0 || !data || !cpu || !core ||
    data[1] > dataLimit || cpu[0] > cpuSeconds || cpu[1] > cpuSeconds + 1 || core[1] !== 0
  ) process.exit(SETUP_FAILURE_EXIT_CODE);
}

async function readInput(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function decodeRequest(input: Buffer): DecodedRequest {
  const headerLength = input.byteLength >= 4 ? input.readUInt32BE(0) : 0;
  if (headerLength < 2 || headerLength > MAX_HEADER_BYTES || 4 + headerLength > input.byteLength) {
    throw new Error("isolated_parser_protocol_invalid");
  }
  const header: unknown = JSON.parse(input.toString("utf8", 4, 4 + headerLength));
  const bytes = input.subarray(4 + headerLength);
  if (!isRecord(header) || header.byteLength !== bytes.byteLength) {
    throw new Error("isolated_parser_protocol_invalid");
  }
  if (
    header.op === "spreadsheet" && typeof header.format === "string" &&
    SPREADSHEET_FORMATS.has(header.format) && positiveInteger(header.maxCharacters) &&
    typeof header.mediaType === "string" && header.mediaType.length <= MAX_MEDIA_TYPE_LENGTH
  ) {
    return {
      bytes,
      request: {
        format: header.format,
        maxCharacters: header.maxCharacters,
        mediaType: header.mediaType,
        op: "spreadsheet"
      }
    };
  }
  if (header.op === "html" && positiveInteger(header.maxChars)) {
    return { bytes, request: { maxChars: header.maxChars, op: "html" } };
  }
  if (
    header.op === "page" && positiveInteger(header.maxCharacters) &&
    typeof header.contentType === "string" && header.contentType.length <= MAX_PAGE_CONTENT_TYPE_LENGTH &&
    typeof header.finalUrl === "string" && header.finalUrl.length <= FETCH_URL_MAX_LENGTH
  ) {
    return {
      bytes,
      request: {
        contentType: header.contentType,
        finalUrl: header.finalUrl,
        maxCharacters: header.maxCharacters,
        op: "page"
      }
    };
  }
  throw new Error("isolated_parser_protocol_invalid");
}

function execute({ bytes, request }: DecodedRequest): unknown {
  if (request.op === "spreadsheet") {
    // The format selects the same parser branches as the original extension.
    return parseSpreadsheetDocument({
      bytes,
      fileName: `document.${request.format}`,
      mimeType: request.mediaType
    }, { maxCharacters: request.maxCharacters });
  }
  if (request.op === "page") {
    // An empty Content-Type stands for a missing header: the body is sniffed.
    return {
      page: extractPage({
        body: bytes,
        contentType: request.contentType || null,
        finalUrl: request.finalUrl,
        maxCharacters: request.maxCharacters
      })
    };
  }
  return extractTextDocument(bytes, {
    fileName: "document.html",
    maxChars: request.maxChars,
    mimeType: "text/html"
  });
}

function failureCode(error: unknown): "parser_output_too_large" | "parser_rejected" {
  if (isDocumentParserError(error)) {
    return error.code === "parser_output_too_large" ? "parser_output_too_large" : "parser_rejected";
  }
  // Allocation, array and string-length exhaustion surface as RangeError.
  return error instanceof RangeError ? "parser_output_too_large" : "parser_rejected";
}

function respond(message: unknown): void {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  let offset = 0;
  while (offset < payload.byteLength) offset += writeSync(RESULT_FD, payload, offset);
}

async function main(): Promise<void> {
  try {
    confineProcess();
  } catch {
    process.exit(SETUP_FAILURE_EXIT_CODE);
  }
  let decoded: DecodedRequest;
  try {
    decoded = decodeRequest(await readInput());
  } catch {
    process.exit(PROTOCOL_FAILURE_EXIT_CODE);
  }
  let message: unknown;
  try {
    message = { ok: true, result: execute(decoded) };
  } catch (error) {
    message = { code: failureCode(error), ok: false };
  }
  try {
    respond(message);
  } catch (error) {
    respond({ code: failureCode(error), ok: false });
  }
  process.exit(0);
}

void main();
