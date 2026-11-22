import { clipPastChatLine, PAST_CHATS_LIMITS } from "../../../contracts/pastChats";
import { redactSavedSecretValues } from "../../redaction/savedSecrets";
import { redactSecrets } from "../../redaction/secrets";
import { chatSearchSavedSecretValues, type ChatSearchSavedSecretReader } from "../index/savedSecrets";

/**
 * What past-chat search and reading show is redacted at the read, whatever
 * the index already did: a past message is read from the messages themselves,
 * a title was never redacted, and a secret saved after a turn was indexed
 * still sits in its passage. The owner's saved secret values that look like
 * secrets go (`lib/server/redaction/savedSecrets.ts`, read as the index reads
 * them), and so do recognized secrets (`lib/server/redaction/secrets.ts`).
 */

/** Text longer than this is cut before it is scanned; nothing past it is ever shown. */
const SCAN_MAX_CODE_UNITS = 100_000;

export type SavedSecretValuesReader = (userId: string) => Promise<readonly string[]>;

export function createSavedSecretValuesReader(db: ChatSearchSavedSecretReader): SavedSecretValuesReader {
  return (userId) => chatSearchSavedSecretValues(db, userId);
}

/**
 * The text with saved secret values, then recognized secrets, replaced by
 * markers: saved values first, so a recognized secret inside one cannot leave
 * the rest of the value behind.
 */
export function redactPastChatText(text: string, savedValues: readonly string[]): string {
  const bounded = text.length > SCAN_MAX_CODE_UNITS ? text.slice(0, SCAN_MAX_CODE_UNITS) : text;
  return redactSecrets(redactSavedSecretValues(bounded, savedValues).text).redactedText;
}

/** A chat's title as a result names it: redacted, one line, clipped; "Untitled chat" when nothing is left. */
export function pastChatTitle(title: string, savedValues: readonly string[]): string {
  return clipPastChatLine(redactPastChatText(title, savedValues), PAST_CHATS_LIMITS.titleChars) || "Untitled chat";
}
