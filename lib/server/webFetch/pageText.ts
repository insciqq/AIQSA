import { extractWebPageInIsolation } from "../parsing/isolatedParser";
import { pageContentKind, PAGE_TEXT_MAX_CHARACTERS, type ExtractedPage } from "./pageKinds";

/**
 * Where a fetched body becomes page text: only in the disposable,
 * resource-limited parser process, never in the application. Hostile markup
 * makes the HTML parsers quadratic, and one boundary for every kind leaves no
 * in-process parsing of page bytes. The application only refuses unreadable
 * kinds from the header and the first 4 KB. One deadline covers the wait for
 * the shared parser slot and the parse itself.
 */
export const PAGE_PROCESSING_DEADLINE_MS = 30_000;
/** Fits the parser protocol's header; real Content-Type values are far shorter. */
const CONTENT_TYPE_MAX_LENGTH = 512;

export type FetchedPageInput = Readonly<{
  body: Uint8Array;
  contentType: string | null;
  finalUrl: string;
  signal: AbortSignal;
}>;

export type PageTextDeps = Readonly<{
  deadlineMs?: number;
  isolate?: typeof extractWebPageInIsolation;
}>;

/**
 * The bounded text of one fetched body, or null when it is no readable kind.
 * Rejects with the caller's abort reason when the run stopped, a
 * `TimeoutError` when the deadline passed, or the parser process's
 * `DocumentParserError`.
 */
export async function extractFetchedPage(input: FetchedPageInput, deps: PageTextDeps = {}): Promise<ExtractedPage | null> {
  if (pageContentKind(input.body, input.contentType) === null) return null;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(deps.deadlineMs ?? PAGE_PROCESSING_DEADLINE_MS)]);
  return (deps.isolate ?? extractWebPageInIsolation)({
    body: input.body,
    contentType: input.contentType === null ? null : input.contentType.slice(0, CONTENT_TYPE_MAX_LENGTH),
    finalUrl: input.finalUrl,
    maxCharacters: PAGE_TEXT_MAX_CHARACTERS,
    signal
  });
}
