import { redactMemorySecrets } from "../memory/explicit/secretParser";

/**
 * Secret redaction for everything Discord Connect sends out (PRD D-22, O-12):
 * answers, status lines, thread names, file names and the text of Discord
 * chats' share snapshots. It takes the Memory parser's redacting classes
 * (known token formats, JWTs, credential URLs, private keys, recovery codes,
 * payment cards) and adds what the answer of an agent reading cluster state
 * shows: values assigned to secret-named keys (`DB_PASSWORD=...`,
 * `api_key: ...`, a Kubernetes `name`/`value` env pair), bearer tokens, and
 * high-entropy values in an assignment. The Memory parser stays label-free;
 * the label rules live here because they only ever remove outgoing text.
 * Found text becomes `[redacted]`; the result carries only a count, never
 * what was found.
 */

export const DISCORD_REDACTION_PLACEHOLDER = "[redacted]";

export type DiscordRedaction = Readonly<{ text: string; count: number }>;

type Range = { start: number; end: number };

/** Word parts of a key name that mark its value as a secret. */
const SECRET_PARTS = new Set([
  "AUTHORIZATION", "CREDENTIAL", "CREDENTIALS", "PASS", "PASSPHRASE", "PASSWD", "PASSWORD", "PWD", "SECRET",
  "SECRETS", "TOKEN", "APIKEY", "PRIVATEKEY", "COOKIE"
]);
/** Two adjacent parts that mark a secret (`API_KEY`, `accessKey`, `SIGNING_KEY`). */
const SECRET_PAIR_FIRSTS = new Set(["API", "ACCESS", "PRIVATE", "SECRET", "SIGNING", "ENCRYPTION", "MASTER", "CLIENT", "SESSION"]);
const SECRET_PAIR_SECONDS = new Set(["KEY", "SECRET"]);

const KEY_PATTERN = "[A-Za-z_][A-Za-z0-9_.-]{0,63}";
/** `KEY=value` anywhere, `"KEY": value` anywhere, `KEY: value` at a line start (YAML, env dumps). */
const ASSIGNMENT = new RegExp(
  `(^|[^A-Za-z0-9_.-])(?:(${KEY_PATTERN})[ \\t]*=|"(${KEY_PATTERN})"[ \\t]*:|'(${KEY_PATTERN})'[ \\t]*:)[ \\t]*`, "gu"
);
const LINE_ASSIGNMENT = new RegExp(`^([ \\t]*(?:[-*>][ \\t]+)*)(${KEY_PATTERN})[ \\t]*:[ \\t]*`, "u");
const ENV_NAME_LINE = new RegExp(`^[ \\t]*(?:-[ \\t]+)?"?name"?[ \\t]*:[ \\t]*["']?(${KEY_PATTERN})["']?[ \\t]*,?[ \\t]*$`, "u");
const ENV_VALUE_LINE = /^([ \t]*"?value"?[ \t]*:[ \t]*)(\S.*)$/u;
const ENV_JSON_PAIR = new RegExp(`"name"[ \\t]*:[ \\t]*"(${KEY_PATTERN})"[ \\t]*,[ \\t]*"value"[ \\t]*:[ \\t]*"((?:[^"\\\\\\n]|\\\\.){1,512})"`, "gu");
const BEARER = /\b(?:Bearer|Basic|Token)[ \t]+([A-Za-z0-9._~+/-]{12,512}=*)/gu;

export function isSecretKeyName(key: string): boolean {
  const parts = key.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toUpperCase().split(/[_.-]+/u).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (SECRET_PARTS.has(part)) return true;
    if (SECRET_PAIR_FIRSTS.has(part) && SECRET_PAIR_SECONDS.has(parts[index + 1] ?? "")) return true;
  }
  return false;
}

/** A value that names no secret: empty, a placeholder, a reference or a mask. */
function placeholderValue(value: string): boolean {
  const bare = value.replace(/^["'`]|["'`,;]+$/gu, "").trim();
  return !bare || bare === DISCORD_REDACTION_PLACEHOLDER || /^[*x•.\-_]+$/iu.test(bare) || /^[$<{]/u.test(bare) ||
    /^(?:null|none|true|false|undefined|""|'')$/iu.test(bare);
}

/** The value's extent from `start`: a quoted string, or up to whitespace (to the line end when `toLineEnd`). */
function valueRange(text: string, start: number, toLineEnd: boolean): Range | null {
  const quote = text[start];
  let end: number;
  if (quote === "\"" || quote === "'" || quote === "`") {
    end = start + 1;
    while (end < text.length && text[end] !== quote && text[end] !== "\n") end += text[end] === "\\" ? 2 : 1;
    end = Math.min(end, text.length);
    const range = { start: start + 1, end };
    return range.end > range.start ? range : null;
  }
  end = start;
  const stop = toLineEnd ? /[\n\r]/u : /[\s,;&)\]}>"'`]/u;
  while (end < text.length && !stop.test(text[end]!)) end += 1;
  while (toLineEnd && end > start && /[ \t]/u.test(text[end - 1]!)) end -= 1;
  return end > start ? { start, end } : null;
}

function labelRanges(text: string): Range[] {
  const ranges: Range[] = [];
  const add = (range: Range | null) => {
    if (range && !placeholderValue(text.slice(range.start, range.end))) ranges.push(range);
  };
  for (const match of text.matchAll(ASSIGNMENT)) {
    const key = match[2] ?? match[3] ?? match[4] ?? "";
    if (isSecretKeyName(key)) add(valueRange(text, match.index + match[0].length, false));
  }
  for (const match of text.matchAll(ENV_JSON_PAIR)) {
    if (!isSecretKeyName(match[1]!)) continue;
    const end = match.index + match[0].length - 1;
    add({ start: end - match[2]!.length, end });
  }
  for (const match of text.matchAll(BEARER)) {
    if (!/[0-9]/u.test(match[1]!)) continue;
    const end = match.index + match[0].length;
    add({ start: end - match[1]!.length, end });
  }
  let offset = 0;
  let pendingEnvSecret = false;
  for (const line of text.split("\n")) {
    const lineAssignment = LINE_ASSIGNMENT.exec(line);
    if (pendingEnvSecret) {
      const value = ENV_VALUE_LINE.exec(line);
      if (value) add(valueRange(text, offset + value[1]!.length, true));
    }
    const envName = ENV_NAME_LINE.exec(line);
    if (envName) pendingEnvSecret = isSecretKeyName(envName[1]!);
    else if (line.trim()) pendingEnvSecret = false;
    if (lineAssignment && isSecretKeyName(lineAssignment[2]!)) {
      add(valueRange(text, offset + lineAssignment[0].length, true));
    }
    offset += line.length + 1;
  }
  return ranges;
}

/** Whether `start` sits right after a URL scheme (`https:` or `https://`), so its colon starts no value. */
function afterUrlScheme(text: string, start: number): boolean {
  const lead = text.slice(Math.max(0, start - 16), start);
  return /(?:^|[^A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{1,15}:(?:\/\/)?$/u.test(lead) &&
    (lead.endsWith("://") || text.startsWith("//", start));
}

/** Spans worth removing: the Memory parser's redacting spans, its high-entropy runs right after `=` or `:`, the label rules. */
function secretRanges(text: string): Range[] {
  const parsed = redactMemorySecrets(text);
  const ranges: Range[] = parsed.spans.map(span => ({ start: span.start, end: span.end }));
  for (const span of parsed.detections) {
    if (span.finding !== "HIGH_ENTROPY_TOKEN") continue;
    // A URL's scheme colon is no assignment: a long link path reads as high entropy, and cutting it removed every
    // GitLab merge request link from answers (production, 2026-11-12). Secrets in a URL are still caught by the
    // label rules (`?token=...`) and by the parser's credential and known-format spans.
    if (afterUrlScheme(text, span.start)) continue;
    const before = text.slice(Math.max(0, span.start - 3), span.start).replace(/["'` \t]+$/u, "");
    if (before.endsWith("=") || before.endsWith(":")) ranges.push({ start: span.start, end: span.end });
  }
  ranges.push(...labelRanges(text));
  return ranges;
}

function merged(ranges: Range[]): Range[] {
  const sorted = ranges.filter(range => range.end > range.start).sort((left, right) => left.start - right.start);
  const out: Range[] = [];
  for (const range of sorted) {
    const last = out.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else out.push({ ...range });
  }
  return out;
}

/** Replaces every found secret with `[redacted]` and counts the replacements. */
export function redactOutgoing(text: string): DiscordRedaction {
  if (typeof text !== "string" || !text) return { text: typeof text === "string" ? text : "", count: 0 };
  const ranges = merged(secretRanges(text));
  if (!ranges.length) return { text, count: 0 };
  let out = "";
  let cursor = 0;
  for (const range of ranges) {
    out += text.slice(cursor, range.start) + DISCORD_REDACTION_PLACEHOLDER;
    cursor = range.end;
  }
  return { text: out + text.slice(cursor), count: ranges.length };
}

/** True when a server-provided address carries a recognized secret (a token, a JWT, credentials). */
export function containsOutgoingSecret(text: string): boolean {
  return redactMemorySecrets(text).containsSecret;
}
