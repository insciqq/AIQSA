import { clipPastChatLine, PAST_CHATS_LIMITS } from "../../../contracts/pastChats";
import { redactSecretsAndSavedValues } from "../../redaction/screen";
import { redactSearchQuery, SEARCH_QUERY_MAX_CODE_UNITS } from "../../redaction/searchQuery";
import { chatSearchSavedSecretValues, type ChatSearchSavedSecretReader } from "../index/savedSecrets";

/**
 * What past-chat search and reading show is redacted at the read, whatever
 * the index already did: a past message is read from the messages themselves,
 * a title was never redacted, and a secret saved after a turn was indexed
 * still sits in its passage. The owner's saved secret values that look like
 * secrets go (`lib/server/redaction/savedSecrets.ts`, read as the index reads
 * them), and so do recognized secrets (`lib/server/redaction/secrets.ts`).
 *
 * What is shown, what is indexed and the query are screened by one helper
 * (`lib/server/redaction/screen.ts`): both kinds are found in the original
 * text and replaced together, since replacing either first can break the
 * other and leave part of a secret behind (review 2026-11-23).
 */

/** Text is scanned in windows this long; what lies past them is withheld behind a marker, never shown. */
const SCAN_WINDOWS = Object.freeze({ maxCodeUnits: 100_000, windowCodeUnits: 100_000 });
/** The markers `lib/server/redaction/` puts in place of a secret (`[REDACTED:TOKEN]`, `[REDACTED_SECRET]`, `[REDACTED:SAVED_SECRET]`). */
const REDACTION_MARKER = /\[REDACTED[:_][A-Z0-9_:]*\]/gu;

export type SavedSecretValuesReader = (userId: string) => Promise<readonly string[]>;

export function createSavedSecretValuesReader(db: ChatSearchSavedSecretReader): SavedSecretValuesReader {
  return (userId) => chatSearchSavedSecretValues(db, userId);
}

/** The text with saved secret values and recognized secrets replaced by markers, line breaks as LF. */
export function redactPastChatText(text: string, savedValues: readonly string[]): string {
  return redactSecretsAndSavedValues(text, savedValues, SCAN_WINDOWS).text;
}

/**
 * The query every search stage receives (word statistics and hits, the
 * embedding model, the reranker): bounded first, screened like any text, held
 * to the provider boundary (`redactSearchQuery`), and the markers dropped,
 * since a marker searched for would find other redacted text. Empty when
 * nothing searchable is left or the query is too long to scan.
 */
export function pastChatSearchQuery(query: string, savedValues: readonly string[]): string {
  if (query.length > SEARCH_QUERY_MAX_CODE_UNITS) return "";
  const redacted = redactSearchQuery(redactSecretsAndSavedValues(query, savedValues).text);
  return redacted.eligible ? redacted.safeText.replace(REDACTION_MARKER, " ").replace(/\s+/gu, " ").trim() : "";
}

/** A chat's title as a result names it: redacted, one line, clipped; "Untitled chat" when nothing is left. */
export function pastChatTitle(title: string, savedValues: readonly string[]): string {
  return clipPastChatLine(redactPastChatText(title, savedValues), PAST_CHATS_LIMITS.titleChars) || "Untitled chat";
}
