import { clipPastChatLine, PAST_CHATS_LIMITS } from "../../../contracts/pastChats";
import { redactSavedSecretValues, savedSecretLineEndingForms, savedSecretLineFeeds } from "../../redaction/savedSecrets";
import { redactSearchQuery, SEARCH_QUERY_MAX_CODE_UNITS } from "../../redaction/searchQuery";
import { redactSecrets } from "../../redaction/secrets";
import { chatSearchSavedSecretValues, type ChatSearchSavedSecretReader } from "../index/savedSecrets";

/**
 * What past-chat search and reading show is redacted at the read, whatever
 * the index already did: a past message is read from the messages themselves,
 * a title was never redacted, and a secret saved after a turn was indexed
 * still sits in its passage. The owner's saved secret values that look like
 * secrets go (`lib/server/redaction/savedSecrets.ts`, read as the index reads
 * them), and so do recognized secrets (`lib/server/redaction/secrets.ts`).
 *
 * One order holds for what is shown and for the query alike: saved values are
 * matched in the original text first, then recognized secrets are replaced.
 * The other way round, a recognized token inside a saved value is replaced
 * first and the rest of the value, no longer whole, is never matched (review
 * 2026-11-23).
 */

/** Text longer than this is cut before it is scanned; nothing past it is ever shown. */
const SCAN_MAX_CODE_UNITS = 100_000;
/** The markers `lib/server/redaction/` puts in place of a secret (`[REDACTED:TOKEN]`, `[REDACTED_SECRET]`, `[REDACTED:SAVED_SECRET]`). */
const REDACTION_MARKER = /\[REDACTED[:_][A-Z0-9_:]*\]/gu;

export type SavedSecretValuesReader = (userId: string) => Promise<readonly string[]>;

export function createSavedSecretValuesReader(db: ChatSearchSavedSecretReader): SavedSecretValuesReader {
  return (userId) => chatSearchSavedSecretValues(db, userId);
}

/**
 * The text with saved secret values replaced, matched as written and again
 * once its line breaks are LF, so CRLF text and an LF value (or the reverse)
 * still match; the result's line breaks are LF.
 */
function withoutSavedValues(text: string, savedValues: readonly string[]): string {
  const forms = savedSecretLineEndingForms(savedValues);
  return redactSavedSecretValues(savedSecretLineFeeds(redactSavedSecretValues(text, forms).text), forms).text;
}

/**
 * The text with saved secret values, then recognized secrets, replaced by
 * markers: saved values first, so a recognized secret inside one cannot leave
 * the rest of the value behind.
 */
export function redactPastChatText(text: string, savedValues: readonly string[]): string {
  const bounded = text.length > SCAN_MAX_CODE_UNITS ? text.slice(0, SCAN_MAX_CODE_UNITS) : text;
  return redactSecrets(withoutSavedValues(bounded, savedValues)).redactedText;
}

/**
 * The query every search stage receives (word statistics and hits, the
 * embedding model, the reranker): bounded first, saved values matched in the
 * original query, then recognized secrets (`redactSearchQuery`), and the
 * markers dropped, since a marker searched for would find other redacted text.
 * Empty when nothing searchable is left or the query is too long to scan.
 */
export function pastChatSearchQuery(query: string, savedValues: readonly string[]): string {
  if (query.length > SEARCH_QUERY_MAX_CODE_UNITS) return "";
  const redacted = redactSearchQuery(withoutSavedValues(query, savedValues));
  return redacted.eligible ? redacted.safeText.replace(REDACTION_MARKER, " ").replace(/\s+/gu, " ").trim() : "";
}

/** A chat's title as a result names it: redacted, one line, clipped; "Untitled chat" when nothing is left. */
export function pastChatTitle(title: string, savedValues: readonly string[]): string {
  return clipPastChatLine(redactPastChatText(title, savedValues), PAST_CHATS_LIMITS.titleChars) || "Untitled chat";
}
