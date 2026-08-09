import type { ParserEngineConfig } from "./config";
import { DocumentParserError, isDocumentParserError } from "./errors";
import { normalizeDoclingResponse, normalizeTikaResponse } from "./normalization";
import { normalizedFileExtension } from "./routing";
import type {
  DocumentParserEngineAdapter,
  ParsedDocument,
  ParserProbeResult,
  SidecarParseInput,
  SidecarParserEngine
} from "./types";

const PROBE_MAX_BYTES = 4 * 1_024;
const PROBE_TIMEOUT_MS = 3_000;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function endpoint(baseUrl: URL, path: string): URL {
  return new URL(path.replace(/^\/+/, ""), baseUrl);
}

function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();

  return {
    clear: () => clearTimeout(timer),
    didTimeOut: () => timedOut,
    signal: parent ? AbortSignal.any([parent, controller.signal]) : controller.signal
  };
}

async function readBoundedBytes(
  response: Response,
  maxBytes: number,
  engine: SidecarParserEngine
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new DocumentParserError("parser_output_too_large", engine);
  }
  if (!response.body) {
    throw new DocumentParserError("parser_invalid_output", engine);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DocumentParserError("parser_output_too_large", engine);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
  engine: SidecarParserEngine
): Promise<unknown> {
  const bytes = await readBoundedBytes(response, maxBytes, engine);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new DocumentParserError("parser_invalid_output", engine);
  }
}

function httpError(status: number, engine: SidecarParserEngine): DocumentParserError {
  if (status === 408 || status === 504) {
    return new DocumentParserError("parser_timeout", engine);
  }
  return new DocumentParserError(status >= 500 ? "parser_unavailable" : "parser_rejected", engine);
}

function requestBody(input: SidecarParseInput, engine: SidecarParserEngine): BodyInit {
  const bytes = new Uint8Array(input.bytes);
  if (engine === "tika") return new Blob([bytes], { type: input.mediaType });

  const form = new FormData();
  form.append("files", new Blob([bytes], { type: input.mediaType }), sidecarFileName(input.fileName));
  form.append("to_formats", "json");
  form.append("image_export_mode", "placeholder");
  form.append("table_mode", "fast");
  form.append("abort_on_error", "true");
  form.append("do_ocr", "true");
  form.append("force_ocr", "false");
  form.append("ocr_preset", "easyocr");
  form.append("ocr_lang", "ru");
  form.append("ocr_lang", "en");
  return form;
}

function sidecarFileName(fileName: string): string {
  const extension = normalizedFileExtension(fileName);
  return `document${extension ?? ""}`;
}

function parseRequest(input: SidecarParseInput, engine: SidecarParserEngine, signal: AbortSignal): RequestInit {
  if (engine === "docling") {
    return {
      body: requestBody(input, engine),
      cache: "no-store",
      headers: { accept: "application/json" },
      method: "POST",
      redirect: "error",
      signal
    };
  }

  return {
    body: requestBody(input, engine),
    cache: "no-store",
    headers: {
      accept: "application/json",
      "content-disposition": `attachment; filename="${sidecarFileName(input.fileName)}"`,
      "content-type": input.mediaType,
      maxEmbeddedResources: "0",
      "x-tika-skip-embedded": "true"
    },
    method: "PUT",
    redirect: "error",
    signal
  };
}

export class HttpDocumentParserEngineAdapter implements DocumentParserEngineAdapter {
  readonly #config: ParserEngineConfig;
  readonly #engine: SidecarParserEngine;
  readonly #fetch: typeof fetch;

  constructor(input: Readonly<{
    config: ParserEngineConfig;
    engine: SidecarParserEngine;
    fetch?: typeof fetch;
  }>) {
    this.#config = input.config;
    this.#engine = input.engine;
    this.#fetch = input.fetch ?? ((url, init) => fetch(url, init));
  }

  async parse(input: SidecarParseInput): Promise<ParsedDocument> {
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > this.#config.requestMaxBytes) {
      throw new DocumentParserError("parser_rejected", this.#engine);
    }

    const timeout = timeoutSignal(input.signal, this.#config.timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(
        endpoint(
          this.#config.baseUrl,
          this.#engine === "docling" ? "v1/convert/file" : "rmeta"
        ),
        parseRequest(input, this.#engine, timeout.signal)
      );
    } catch {
      timeout.clear();
      if (input.signal?.aborted) throw abortReason(input.signal);
      throw new DocumentParserError(
        timeout.didTimeOut() ? "parser_timeout" : "parser_unavailable",
        this.#engine
      );
    }

    try {
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw httpError(response.status, this.#engine);
      }

      const value = await readBoundedJson(
        response,
        this.#config.responseMaxBytes,
        this.#engine
      );
      const parsed = this.#engine === "docling"
        ? normalizeDoclingResponse(value, input.mediaType)
        : normalizeTikaResponse(value, input.mediaType);

      if (Buffer.byteLength(parsed.text, "utf8") > this.#config.responseMaxBytes) {
        throw new DocumentParserError("parser_output_too_large", this.#engine);
      }
      return parsed;
    } catch (error) {
      if (input.signal?.aborted) throw abortReason(input.signal);
      if (timeout.didTimeOut()) {
        throw new DocumentParserError("parser_timeout", this.#engine);
      }
      if (isDocumentParserError(error)) throw error;
      throw new DocumentParserError("parser_invalid_output", this.#engine);
    } finally {
      timeout.clear();
    }
  }

  async probe(signal?: AbortSignal): Promise<ParserProbeResult> {
    const timeout = timeoutSignal(signal, Math.min(PROBE_TIMEOUT_MS, this.#config.timeoutMs));
    try {
      const response = await this.#fetch(
        endpoint(this.#config.baseUrl, this.#engine === "docling" ? "health" : "tika"),
        {
          cache: "no-store",
          headers: { accept: this.#engine === "docling" ? "application/json" : "text/plain" },
          method: "GET",
          redirect: "error",
          signal: timeout.signal
        }
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { available: false, configured: true, engine: this.#engine, error: "parser_unavailable" };
      }

      const bytes = await readBoundedBytes(response, PROBE_MAX_BYTES, this.#engine);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const valid = this.#engine === "docling"
        ? isRecordWithOkStatus(text)
        : text.includes("Tika Server");
      return valid
        ? { available: true, configured: true, engine: this.#engine }
        : { available: false, configured: true, engine: this.#engine, error: "parser_invalid_output" };
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      return {
        available: false,
        configured: true,
        engine: this.#engine,
        error: timeout.didTimeOut()
          ? "parser_timeout"
          : isDocumentParserError(error) && error.code === "parser_invalid_output"
            ? "parser_invalid_output"
            : "parser_unavailable"
      };
    } finally {
      timeout.clear();
    }
  }
}

function isRecordWithOkStatus(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object"
      && value !== null
      && !Array.isArray(value)
      && (value as Record<string, unknown>).status === "ok";
  } catch {
    return false;
  }
}
