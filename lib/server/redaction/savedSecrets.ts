import { workspaceActivitySecretValues } from "../workspace/activityText";
import type { AcceptedWorkspaceSecret } from "../workspace/secrets/store";
import { redactSecrets } from "./secrets";

/**
 * How derived text recognizes the values of the owner's saved secrets
 * (Settings > Secrets): writes repeating one are refused, and indexing
 * replaces them with a marker before anything is stored, embedded or recalled
 * (the memory note and past-chat search; `./savedSecretLoader.ts` loads the
 * values). Matching is exact and literal, on
 * each value and its trimmed form, so it behaves the same in every language.
 *
 * Only values that look like secrets are screened (review 2026-10-23): at
 * least 20 characters of any kind, or at least 8 characters with one that is
 * neither a letter nor whitespace (a digit, punctuation or a symbol). Plain
 * words such as `localhost` or `production`, which settings often hold, stay
 * ordinary text, so a fact or chat turn that mentions them is kept. Lengths
 * count Unicode code points.
 */
const SCREENED_ANY_MIN_LENGTH = 20;
const SCREENED_MIXED_MIN_LENGTH = 8;

/** Replaces a saved value in derived text; a redaction marker, so secret screening treats it as removed text. */
export const SAVED_SECRET_MARKER = "[REDACTED:SAVED_SECRET]";
/** Reason code of a history text that had a saved value redacted. */
export const SAVED_SECRET_REDACTION_REASON = "SECRET_REDACTED_SAVED_SECRET";

export function savedSecretValueIsScreened(value: string): boolean {
  const length = [...value].length;
  return length >= SCREENED_ANY_MIN_LENGTH ||
    (length >= SCREENED_MIXED_MIN_LENGTH && /[^\p{L}\p{M}\s]/u.test(value));
}

/** Text with every CRLF and lone CR as LF, as derived text and most clients write line breaks. */
export function savedSecretLineFeeds(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

/**
 * The values beside the form each takes with LF line endings, once each: a multi-line value saved with CRLF still
 * matches text whose client or normalization wrote LF (review 2026-11-23). A form that is blank is left out, since
 * it would match ordinary line breaks.
 */
export function savedSecretLineEndingForms(values: readonly string[]): readonly string[] {
  const forms = new Set(values);
  for (const value of values) {
    const lineFeeds = savedSecretLineFeeds(value);
    if (lineFeeds !== value && lineFeeds.trim()) forms.add(lineFeeds);
  }
  return [...forms];
}

/** Last name parts that mark an env variable as an identifier the answer may name: a login, an email, a region. */
const IDENTIFIER_NAME_PARTS = new Set(["ACCOUNT", "BUCKET", "DOMAIN", "EMAIL", "HOST", "HOSTNAME", "LOGIN", "MAIL", "PORT", "PROJECT", "REGION", "USER", "USERNAME"]);
/** Anywhere in a name, these keep the value masked, as in AWS_ACCESS_KEY_ID, DB_USER_PASSWORD or MAIL_URL. */
const SECRET_NAME_PATTERN = /AUTH|BEARER|CERT|CODE|CONN|COOKIE|CRED|DSN|HASH|KEY|LICENSE|MFA|OTP|PASS|PIN|PRIVATE|PW|SALT|SECRET|SEED|SESSION|TOKEN|URI|URL/u;
/** A host name or IPv4 address: letters, digits and hyphens in dot-separated labels. */
const HOST_NAME = String.raw`[\p{L}\p{M}\p{N}-]+(?:\.[\p{L}\p{M}\p{N}-]+)*`;
/** A username, a host name, a region, a bucket, a project, an account number or a port: one word with no `:`, `@` or `/`. */
const PLAIN_IDENTIFIER = /^[\p{L}\p{M}\p{N}._-]+$/u;
/** An email address: a local part without `:`, so `user:password@host` is not one. */
const EMAIL_ADDRESS = new RegExp(String.raw`^[\p{L}\p{M}\p{N}._%+-]+@${HOST_NAME}$`, "u");
/** A host and its port, which only a host variable holds: elsewhere `name:digits` may be a login and a PIN. */
const HOST_AND_PORT = new RegExp(String.raw`^${HOST_NAME}:\d{1,5}$`, "u");
/** An http(s) address that is only an origin: a host and a port, with no user, path, query or fragment that could carry a token. */
const BARE_ORIGIN = new RegExp(String.raw`^https?://(?:${HOST_NAME}|\[[0-9a-f:.]+\])(?::\d{1,5})?/?$`, "iu");

/**
 * Whether a value has the shape of the identifier its variable names: a plain username, host name or region, an
 * email, a bare http(s) origin, or for a host variable a host and port. A value with a password part
 * (`user:password`, `:password@`), a user in a URL, or a URL with a path, a query or another scheme never has it,
 * whatever the name says (review 2026-11-23): `SERVICE_LOGIN=demo:password` is a Basic-auth pair, and
 * `REDIS_HOST=redis://:password@host/0` a connection string.
 */
function identifierValueShape(lastNamePart: string, value: string): boolean {
  const trimmed = value.trim();
  return PLAIN_IDENTIFIER.test(trimmed) || EMAIL_ADDRESS.test(trimmed) || BARE_ORIGIN.test(trimmed) ||
    ((lastNamePart === "HOST" || lastNamePart === "HOSTNAME") && HOST_AND_PORT.test(trimmed));
}

/** A word: letters, digits, `_` and `-`, as a username, a host label or a token is written. */
const WORD = /[\p{L}\p{M}\p{N}_-]+/gu;
/** A word this long that mixes letters and digits reads as a token, not a name. */
const TOKEN_WORD_MIN_LENGTH = 20;
/** A run this long of hex, base64 or base64url characters reads as a token, whatever it mixes. */
const TOKEN_RUN = /[A-Za-z0-9+/=_-]{32,}/u;
/** Prefixes that open a credential in common formats: code hosts, code quality, chat, payments, cloud and package registries. */
const TOKEN_PREFIXES = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "glpat-", "gldt-", "glrt-", "glsa_", "squ_",
  "sqp_", "sqa_", "xoxa-", "xoxb-", "xoxp-", "xoxr-", "xoxs-", "xapp-", "sk-", "sk_live_", "sk_test_", "rk_live_", "rk_test_",
  "AKIA", "ASIA", "AIza", "ya29.", "npm_", "pypi-", "hf_", "dop_v1_", "shpat_", "shpss_"];
/** Characters after a prefix before it opens a credential, so a short name that happens to start like one stays a name. */
const TOKEN_PREFIX_MIN_TAIL = 8;
const TOKEN_TAIL = /^[A-Za-z0-9+/=._-]+/u;

function opensWithTokenPrefix(value: string): boolean {
  for (const prefix of TOKEN_PREFIXES) {
    for (let start = value.indexOf(prefix); start !== -1; start = value.indexOf(prefix, start + 1)) {
      // Only at the start of a word: `task-ghp_...` opens one, `bask-key` does not hold `sk-`.
      if (start > 0 && /[A-Za-z0-9]/u.test(value[start - 1] ?? "")) continue;
      const tail = TOKEN_TAIL.exec(value.slice(start + prefix.length))?.[0] ?? "";
      if (tail.length >= TOKEN_PREFIX_MIN_TAIL) return true;
    }
  }
  return false;
}

/**
 * Whether a value reads as a credential whatever its variable is called (review 2026-11-23): one the recognized-secret
 * detector flags, a word of 20 or more characters that mixes letters and digits, 32 or more characters of a token
 * alphabet, or a known token prefix. A login variable may hold a token (a code-quality server's login field holds a
 * user token), so the format wins over the name; usernames, emails, dotted host names, regions, ports, IPv4 addresses
 * and bare origins keep their exemption. Screening too much only hides a word; too little leaks a credential.
 */
function credentialShapedValue(value: string): boolean {
  const trimmed = value.trim();
  if (TOKEN_RUN.test(trimmed) || opensWithTokenPrefix(trimmed)) return true;
  for (const [word] of trimmed.matchAll(WORD)) {
    if ([...word].length >= TOKEN_WORD_MIN_LENGTH && /\p{L}/u.test(word) && /\p{N}/u.test(word)) return true;
  }
  return redactSecrets(trimmed).containsSecret;
}

/**
 * Whether an env variable is an identifier, not a credential: its name's last part names a login, an email, a host
 * or a region (DB_USER, AWS_DEFAULT_REGION), no part of it names a secret (USER_PW, LOGIN_CODE stay secrets), its
 * value has that identifier's shape (`identifierValueShape`) and does not read as a credential
 * (`credentialShapedValue`). `manage_secret` lets an answer name these (operator decision 2026-10-27), and derived
 * text keeps them as ordinary text.
 */
export function savedSecretIdentifierVariable(name: unknown, value: unknown): boolean {
  if (typeof name !== "string" || typeof value !== "string") return false;
  const upper = name.toUpperCase();
  const last = upper.split("_").at(-1) ?? "";
  return !SECRET_NAME_PATTERN.test(upper) && IDENTIFIER_NAME_PARTS.has(last) && identifierValueShape(last, value) &&
    !credentialShapedValue(value);
}

/**
 * Whether derived text may hold an env variable's value as ordinary text: an identifier (`savedSecretIdentifierVariable`),
 * or an address variable (JIRA_URL) whose value is a bare origin, with no part of the rest of its name naming a secret
 * (review 2026-11-23). A login, an email, a host or a link to a team's tracker is what users keep in their note and
 * search their chats for; passwords, tokens, keys and addresses with a path stay screened.
 */
function savedSecretEntryIsPlain(name: string, value: string): boolean {
  if (savedSecretIdentifierVariable(name, value)) return true;
  const parts = name.toUpperCase().split("_");
  const last = parts.pop() ?? "";
  return (last === "URL" || last === "URI") && BARE_ORIGIN.test(value.trim()) && !SECRET_NAME_PATTERN.test(parts.join("_")) &&
    !credentialShapedValue(value);
}

function extractedValues(secrets: readonly Pick<AcceptedWorkspaceSecret, "name" | "value">[]): string[] {
  return secrets.flatMap((secret) => secret.value.kind === "env"
    ? secret.value.entries.filter((entry) => !savedSecretEntryIsPlain(entry.name, entry.value)).map((entry) => entry.value)
    : workspaceActivitySecretValues([secret as AcceptedWorkspaceSecret]));
}

/**
 * The screened values of saved secrets: each typed value and its trimmed form, with their LF forms, once. Env
 * variables that hold identifiers or bare addresses are left out (`savedSecretEntryIsPlain`).
 */
export function savedSecretScreenedValues(
  secrets: readonly Pick<AcceptedWorkspaceSecret, "name" | "value">[]
): readonly string[] {
  let extracted: readonly string[];
  try {
    extracted = extractedValues(secrets);
  } catch {
    extracted = [];
  }
  const values = new Set<string>();
  for (const value of extracted) {
    for (const candidate of [value, value.trim()]) {
      if (savedSecretValueIsScreened(candidate)) values.add(candidate);
    }
  }
  return savedSecretLineEndingForms([...values]);
}

/** Whether any string in a value, object keys included, contains one of the saved values. */
export function valueContainsSavedSecret(
  value: unknown,
  savedValues: readonly string[],
  seen: WeakSet<object> = new WeakSet()
): boolean {
  if (savedValues.length === 0) return false;
  if (typeof value === "string") return savedValues.some((saved) => value.includes(saved));
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => valueContainsSavedSecret(entry, savedValues, seen));
  }
  return Object.entries(value).some(([entryKey, entry]) =>
    savedValues.some((saved) => entryKey.includes(saved)) ||
    valueContainsSavedSecret(entry, savedValues, seen));
}

/**
 * The text with every occurrence of the saved values replaced by the marker.
 * Occurrences are found in the original text, the longest first, so a value
 * inside a longer one or inside the marker itself never splits a replacement.
 */
export function redactSavedSecretValues(
  text: string,
  savedValues: readonly string[]
): Readonly<{ redacted: boolean; text: string }> {
  const found: Array<Readonly<{ end: number; start: number }>> = [];
  for (const value of savedValues) {
    if (!value) continue;
    for (let start = text.indexOf(value); start !== -1; start = text.indexOf(value, start + 1)) {
      found.push({ end: start + value.length, start });
    }
  }
  if (found.length === 0) return { redacted: false, text };
  found.sort((left, right) =>
    (right.end - right.start) - (left.end - left.start) || left.start - right.start);
  const selected: Array<Readonly<{ end: number; start: number }>> = [];
  for (const span of found) {
    if (!selected.some((kept) => span.start < kept.end && span.end > kept.start)) selected.push(span);
  }
  selected.sort((left, right) => left.start - right.start);
  let output = "";
  let cursor = 0;
  for (const span of selected) {
    output += text.slice(cursor, span.start) + SAVED_SECRET_MARKER;
    cursor = span.end;
  }
  return { redacted: true, text: output + text.slice(cursor) };
}
