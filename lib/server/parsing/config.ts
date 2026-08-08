import { DEFAULT_UPLOAD_MAX_BYTES, MAX_UPLOAD_MAX_BYTES } from "../uploads/validation";
import type { SidecarParserEngine } from "./types";

export const PARSER_RESPONSE_MAX_BYTES_CEILING = 64 * 1_024 * 1_024;
export const PARSER_TIMEOUT_MS_CEILING = 15 * 60_000;

export type ParserEngineConfig = Readonly<{
  baseUrl: URL;
  requestMaxBytes: number;
  responseMaxBytes: number;
  timeoutMs: number;
}>;

export type DocumentParserConfig = Readonly<{
  docling?: ParserEngineConfig;
  tika?: ParserEngineConfig;
}>;

const defaults = Object.freeze({
  docling: Object.freeze({
    requestMaxBytes: DEFAULT_UPLOAD_MAX_BYTES,
    responseMaxBytes: 32 * 1_024 * 1_024,
    timeoutMs: 5 * 60_000
  }),
  tika: Object.freeze({
    requestMaxBytes: DEFAULT_UPLOAD_MAX_BYTES,
    responseMaxBytes: 16 * 1_024 * 1_024,
    timeoutMs: 2 * 60_000
  })
} satisfies Record<SidecarParserEngine, Omit<ParserEngineConfig, "baseUrl">>);

export const DEFAULT_DOCUMENT_PARSER_LIMITS = defaults;

const environmentNames = Object.freeze({
  docling: Object.freeze({
    baseUrl: "AIQSA_DOCLING_URL",
    requestMaxBytes: "AIQSA_DOCLING_REQUEST_MAX_BYTES",
    responseMaxBytes: "AIQSA_DOCLING_RESPONSE_MAX_BYTES",
    timeoutMs: "AIQSA_DOCLING_TIMEOUT_MS"
  }),
  tika: Object.freeze({
    baseUrl: "AIQSA_TIKA_URL",
    requestMaxBytes: "AIQSA_TIKA_REQUEST_MAX_BYTES",
    responseMaxBytes: "AIQSA_TIKA_RESPONSE_MAX_BYTES",
    timeoutMs: "AIQSA_TIKA_TIMEOUT_MS"
  })
} satisfies Record<SidecarParserEngine, Record<keyof ParserEngineConfig, string>>);

function boundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  ceiling: number
): number {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= ceiling
    ? parsed
    : fallback;
}

function parserBaseUrl(value: string | undefined): URL | undefined {
  const candidate = value?.trim();
  if (!candidate || Buffer.byteLength(candidate, "utf8") > 2_048) {
    return undefined;
  }

  try {
    const url = new URL(candidate);
    if (
      !["http:", "https:"].includes(url.protocol)
      || url.username
      || url.password
      || url.search
      || url.hash
    ) {
      return undefined;
    }

    if (!url.pathname.endsWith("/")) {
      url.pathname += "/";
    }
    return url;
  } catch {
    return undefined;
  }
}

function engineConfig(
  engine: SidecarParserEngine,
  environment: Readonly<Record<string, string | undefined>>
): ParserEngineConfig | undefined {
  const names = environmentNames[engine];
  const baseUrl = parserBaseUrl(environment[names.baseUrl]);
  if (!baseUrl) return undefined;

  return Object.freeze({
    baseUrl,
    requestMaxBytes: boundedPositiveInteger(
      environment[names.requestMaxBytes],
      defaults[engine].requestMaxBytes,
      MAX_UPLOAD_MAX_BYTES
    ),
    responseMaxBytes: boundedPositiveInteger(
      environment[names.responseMaxBytes],
      defaults[engine].responseMaxBytes,
      PARSER_RESPONSE_MAX_BYTES_CEILING
    ),
    timeoutMs: boundedPositiveInteger(
      environment[names.timeoutMs],
      defaults[engine].timeoutMs,
      PARSER_TIMEOUT_MS_CEILING
    )
  });
}

export function getDocumentParserConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env
): DocumentParserConfig {
  return Object.freeze({
    docling: engineConfig("docling", environment),
    tika: engineConfig("tika", environment)
  });
}
