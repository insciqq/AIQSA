/**
 * Local, format-aware secret screening for Memory text.
 *
 * This parser deliberately does not inspect semantic labels (for example,
 * words such as "password" or "token").  It only recognizes syntax with a
 * documented format/checksum or a conservative structural entropy rule.  The
 * result is used before any Memory derivative or provider request is created.
 */

export const MEMORY_SECRET_FINDINGS = [
  "CREDENTIAL_URL",
  "HIGH_ENTROPY_TOKEN",
  "JSON_WEB_TOKEN",
  "KNOWN_TOKEN",
  "PAYMENT_CARD",
  "PEM_PRIVATE_KEY",
  "RECOVERY_CODE"
] as const;

export type MemorySecretFinding = (typeof MEMORY_SECRET_FINDINGS)[number];

export type MemorySecretParseResult = Readonly<{
  containsSecret: boolean;
  findings: readonly MemorySecretFinding[];
}>;

export type MemorySecretSpan = Readonly<{
  end: number;
  finding: MemorySecretFinding;
  start: number;
}>;

export type MemorySecretRedactionResult = Readonly<{
  containsSecret: boolean;
  findings: readonly MemorySecretFinding[];
  redactedText: string;
  spans: readonly MemorySecretSpan[];
}>;

export const MEMORY_SECRET_REDACTION_PLACEHOLDER = "[REDACTED_SECRET]" as const;

const ASCII_DIGITS = "0123456789";
const ASCII_LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const TOKEN_CHARACTERS = `${ASCII_DIGITS}${ASCII_LETTERS}+/_=-.`;
const BASE64URL_CHARACTERS = `${ASCII_DIGITS}${ASCII_LETTERS}_-`;
const ASCII_HEXADECIMAL = `${ASCII_DIGITS}abcdefABCDEF`;
const PEM_BEGIN = "-----BEGIN ";
const PEM_PRIVATE_KEY_SUFFIX = "PRIVATE KEY";

function hasCharacter(value: string, characters: string): boolean {
  for (const character of value) {
    if (characters.includes(character)) return true;
  }
  return false;
}

function everyCharacter(value: string, characters: string): boolean {
  if (!value) return false;
  for (const character of value) {
    if (!characters.includes(character)) return false;
  }
  return true;
}

function isCanonicalUuid(value: string): boolean {
  if (value.length !== 36) return false;
  const hyphenOffsets = new Set([8, 13, 18, 23]);
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (hyphenOffsets.has(index)) {
      if (character !== "-") return false;
    } else if (!ASCII_HEXADECIMAL.includes(character)) {
      return false;
    }
  }
  return true;
}

function isAsciiDigit(character: string | undefined): boolean {
  return character !== undefined && ASCII_DIGITS.includes(character);
}

function isAsciiAlphanumeric(character: string | undefined): boolean {
  return character !== undefined &&
    (ASCII_DIGITS.includes(character) || ASCII_LETTERS.includes(character));
}

function isRecoveryGroup(value: string): boolean {
  if (value.length !== 4) return false;
  let hasLetter = false;
  for (const character of value) {
    if (!ASCII_DIGITS.includes(character) && !ASCII_LETTERS.includes(character)) {
      return false;
    }
    hasLetter ||= ASCII_LETTERS.includes(character);
  }
  return hasLetter;
}

function tokenRuns(value: string): string[] {
  const runs: string[] = [];
  let start = -1;
  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index];
    const allowed = character !== undefined && TOKEN_CHARACTERS.includes(character);
    if (allowed && start < 0) start = index;
    if ((!allowed || index === value.length) && start >= 0) {
      runs.push(value.slice(start, index));
      start = -1;
    }
  }
  return runs;
}

function tokenRunSpans(value: string): readonly Readonly<{
  end: number;
  start: number;
  text: string;
}>[] {
  const runs: Array<Readonly<{ end: number; start: number; text: string }>> = [];
  let start = -1;
  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index];
    const allowed = character !== undefined && TOKEN_CHARACTERS.includes(character);
    if (allowed && start < 0) start = index;
    if ((!allowed || index === value.length) && start >= 0) {
      runs.push({ end: index, start, text: value.slice(start, index) });
      start = -1;
    }
  }
  return runs;
}

function hasPemPrivateKey(value: string): boolean {
  let offset = 0;
  while (offset < value.length) {
    const begin = value.indexOf(PEM_BEGIN, offset);
    if (begin < 0) return false;
    const labelStart = begin + PEM_BEGIN.length;
    const labelEnd = value.indexOf("-----", labelStart);
    if (labelEnd > labelStart) {
      const label = value.slice(labelStart, labelEnd);
      if (label === PEM_PRIVATE_KEY_SUFFIX || label.endsWith(` ${PEM_PRIVATE_KEY_SUFFIX}`)) {
        return true;
      }
    }
    offset = labelStart;
  }
  return false;
}

function whitespaceTokens(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  const flush = () => {
    if (current) tokens.push(current);
    current = "";
  };
  for (const character of value) {
    if (character === " " || character === "\t" || character === "\n" || character === "\r") {
      flush();
    } else {
      current += character;
    }
  }
  flush();
  return tokens;
}

function trimDelimiters(value: string): string {
  const delimiters = "\t\n\r,.;:!?()[]{}<>\"'";
  let start = 0;
  let end = value.length;
  while (start < end && delimiters.includes(value[start] ?? "")) start += 1;
  while (end > start && delimiters.includes(value[end - 1] ?? "")) end -= 1;
  return value.slice(start, end);
}

function hasCredentialUrl(value: string): boolean {
  // URL parsing is intentionally used instead of a broad text pattern.  A
  // credential is present only when the parsed URI has both user and password
  // components in its authority section.
  for (const rawToken of whitespaceTokens(value)) {
    const token = trimDelimiters(rawToken);
    if (!token.includes("://")) continue;
    try {
      const parsed = new URL(token);
      if (parsed.username.length > 0 && parsed.password.length > 0) return true;
    } catch {
      // Malformed text is not treated as a credential format by this parser.
    }
  }
  return false;
}

function base64UrlSegment(value: string, minimumLength: number): boolean {
  return value.length >= minimumLength && everyCharacter(value, BASE64URL_CHARACTERS);
}

function looksLikeJsonObject(value: string): boolean {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8").trim();
    if (!decoded.startsWith("{") || !decoded.endsWith("}")) return false;
    const parsed: unknown = JSON.parse(decoded);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function hasJsonWebToken(value: string): boolean {
  for (const token of tokenRuns(value)) {
    const segments = token.split(".");
    if (segments.length !== 3) continue;
    if (!base64UrlSegment(segments[0] ?? "", 8) ||
      !base64UrlSegment(segments[1] ?? "", 8) ||
      !base64UrlSegment(segments[2] ?? "", 8)) continue;
    if (looksLikeJsonObject(segments[0] ?? "") && looksLikeJsonObject(segments[1] ?? "")) {
      return true;
    }
  }
  return false;
}

function knownToken(value: string): boolean {
  for (const token of tokenRuns(value)) {
    if (token.startsWith("AKIA") && token.length === 20 &&
      everyCharacter(token.slice(4), `${ASCII_DIGITS}ABCDEFGHIJKLMNOPQRSTUVWXYZ`)) {
      return true;
    }
    if (token.startsWith("sk-") && token.length >= 20 &&
      everyCharacter(token.slice(3), TOKEN_CHARACTERS)) {
      return true;
    }
    if (token.startsWith("gh") && token.length >= 24 &&
      "pousr".includes(token[2] ?? "") && token[3] === "_" &&
      everyCharacter(token.slice(4), TOKEN_CHARACTERS)) {
      return true;
    }
  }
  return false;
}

function hasRecoveryCode(value: string): boolean {
  // Four arbitrary four-letter prose words are not a recognizable recovery
  // code. Require the explicit grouped format instead of discarding ordinary
  // text such as "user said they were" as secret-tainted.
  for (let start = 0; start < value.length; start += 1) {
    if (isAsciiAlphanumeric(value[start - 1])) continue;
    let cursor = start;
    let valid = true;
    for (let ordinal = 0; ordinal < 4; ordinal += 1) {
      if (!isRecoveryGroup(value.slice(cursor, cursor + 4))) {
        valid = false;
        break;
      }
      cursor += 4;
      if (ordinal < 3) {
        if (value[cursor] !== "-") {
          valid = false;
          break;
        }
        cursor += 1;
      }
    }
    if (valid && !isAsciiAlphanumeric(value[cursor])) return true;
  }
  return false;
}

function digitsOnly(value: string): string {
  let digits = "";
  for (const character of value) {
    if (isAsciiDigit(character)) digits += character;
  }
  return digits;
}

function luhnValid(value: string): boolean {
  const digits = digitsOnly(value);
  if (digits.length < 13 || digits.length > 19) return false;
  let allEqual = true;
  for (let index = 1; index < digits.length; index += 1) {
    if (digits[index] !== digits[0]) {
      allEqual = false;
      break;
    }
  }
  if (allEqual) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function hasPaymentCard(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!isAsciiDigit(value[index]) || isAsciiDigit(value[index - 1])) continue;
    let end = index;
    let separators = 0;
    while (end < value.length) {
      const character = value[end];
      if (isAsciiDigit(character)) {
        end += 1;
        continue;
      }
      if ((character === " " || character === "-") && separators < 8 &&
        isAsciiDigit(value[end + 1])) {
        separators += 1;
        end += 1;
        continue;
      }
      break;
    }
    const candidate = value.slice(index, end);
    const digits = digitsOnly(candidate);
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(candidate)) return true;
  }
  return false;
}

function shannonEntropy(value: string): number {
  const frequencies = new Map<string, number>();
  for (const character of value) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function highEntropy(value: string): boolean {
  // UUIDs are public structural identifiers throughout AIQSA. Their random
  // hex distribution can cross the generic entropy threshold, but that does
  // not make a canonical UUID a credential. Keep this exclusion exact so an
  // opaque token merely containing or extending a UUID remains screened.
  if (isCanonicalUuid(value)) return false;
  let compact = "";
  for (const character of value) {
    if (character !== "-" && character !== "_" && character !== "=" && character !== ".") {
      compact += character;
    }
  }
  return compact.length >= 28 && hasCharacter(compact, ASCII_LETTERS) &&
    hasCharacter(compact, ASCII_DIGITS) && shannonEntropy(compact) >= 3.5;
}

function hasHighEntropyToken(value: string): boolean {
  return tokenRuns(value).some((token) => highEntropy(token));
}

function findingList(value: string): MemorySecretFinding[] {
  const findings: MemorySecretFinding[] = [];
  const checks: readonly [MemorySecretFinding, () => boolean][] = [
    ["PEM_PRIVATE_KEY", () => hasPemPrivateKey(value)],
    ["CREDENTIAL_URL", () => hasCredentialUrl(value)],
    ["JSON_WEB_TOKEN", () => hasJsonWebToken(value)],
    ["KNOWN_TOKEN", () => knownToken(value)],
    ["RECOVERY_CODE", () => hasRecoveryCode(value)],
    ["PAYMENT_CARD", () => hasPaymentCard(value)],
    ["HIGH_ENTROPY_TOKEN", () => hasHighEntropyToken(value)]
  ];
  for (const [finding, check] of checks) {
    if (check()) findings.push(finding);
  }
  return findings;
}

function privateKeySpans(value: string): readonly MemorySecretSpan[] {
  const spans: MemorySecretSpan[] = [];
  let offset = 0;
  while (offset < value.length) {
    const start = value.indexOf(PEM_BEGIN, offset);
    if (start < 0) break;
    const labelStart = start + PEM_BEGIN.length;
    const labelEnd = value.indexOf("-----", labelStart);
    if (labelEnd <= labelStart) {
      offset = labelStart;
      continue;
    }
    const label = value.slice(labelStart, labelEnd);
    if (label !== PEM_PRIVATE_KEY_SUFFIX &&
      !label.endsWith(` ${PEM_PRIVATE_KEY_SUFFIX}`)) {
      offset = labelEnd + 5;
      continue;
    }
    const beginEnd = labelEnd + 5;
    const closing = `-----END ${label}-----`;
    const closingStart = value.indexOf(closing, beginEnd);
    // Without a trustworthy END marker there is no safe local boundary for
    // the key body, including malformed single-line PEM. Redact the remainder
    // rather than letting possible private material cross provider egress.
    const end = closingStart >= 0 ? closingStart + closing.length : value.length;
    spans.push({ end, finding: "PEM_PRIVATE_KEY", start });
    offset = Math.max(end, beginEnd);
  }
  return spans;
}

function whitespaceTokenSpans(value: string): readonly Readonly<{
  end: number;
  start: number;
  text: string;
}>[] {
  const spans: Array<Readonly<{ end: number; start: number; text: string }>> = [];
  let start = -1;
  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index];
    const whitespace = character === undefined || character === " " ||
      character === "\t" || character === "\n" || character === "\r";
    if (!whitespace && start < 0) start = index;
    if (whitespace && start >= 0) {
      spans.push({ end: index, start, text: value.slice(start, index) });
      start = -1;
    }
  }
  return spans;
}

function credentialUrlSpans(value: string): readonly MemorySecretSpan[] {
  const delimiters = "\t\n\r,.;:!?()[]{}<>\"'";
  return whitespaceTokenSpans(value).flatMap((raw) => {
    let start = raw.start;
    let end = raw.end;
    while (start < end && delimiters.includes(value[start] ?? "")) start += 1;
    while (end > start && delimiters.includes(value[end - 1] ?? "")) end -= 1;
    const token = value.slice(start, end);
    if (!token.includes("://")) return [];
    try {
      const parsed = new URL(token);
      return parsed.username.length > 0 && parsed.password.length > 0
        ? [{ end, finding: "CREDENTIAL_URL" as const, start }]
        : [];
    } catch {
      return [];
    }
  });
}

function jwtSpans(value: string): readonly MemorySecretSpan[] {
  return tokenRunSpans(value).flatMap((run) => {
    const segments = run.text.split(".");
    if (segments.length !== 3 ||
      !base64UrlSegment(segments[0] ?? "", 8) ||
      !base64UrlSegment(segments[1] ?? "", 8) ||
      !base64UrlSegment(segments[2] ?? "", 8) ||
      !looksLikeJsonObject(segments[0] ?? "") ||
      !looksLikeJsonObject(segments[1] ?? "")) return [];
    return [{ end: run.end, finding: "JSON_WEB_TOKEN" as const, start: run.start }];
  });
}

function knownTokenSpans(value: string): readonly MemorySecretSpan[] {
  return tokenRunSpans(value).flatMap((run) => {
    const token = run.text;
    const aws = token.startsWith("AKIA") && token.length === 20 &&
      everyCharacter(token.slice(4), `${ASCII_DIGITS}ABCDEFGHIJKLMNOPQRSTUVWXYZ`);
    const openAi = token.startsWith("sk-") && token.length >= 20 &&
      everyCharacter(token.slice(3), TOKEN_CHARACTERS);
    const github = token.startsWith("gh") && token.length >= 24 &&
      "pousr".includes(token[2] ?? "") && token[3] === "_" &&
      everyCharacter(token.slice(4), TOKEN_CHARACTERS);
    return aws || openAi || github
      ? [{ end: run.end, finding: "KNOWN_TOKEN" as const, start: run.start }]
      : [];
  });
}

function recoveryCodeSpans(value: string): readonly MemorySecretSpan[] {
  const spans: MemorySecretSpan[] = [];
  for (let start = 0; start < value.length; start += 1) {
    if (isAsciiAlphanumeric(value[start - 1])) continue;
    let cursor = start;
    let valid = true;
    for (let ordinal = 0; ordinal < 4; ordinal += 1) {
      if (!isRecoveryGroup(value.slice(cursor, cursor + 4))) {
        valid = false;
        break;
      }
      cursor += 4;
      if (ordinal < 3) {
        if (value[cursor] !== "-") {
          valid = false;
          break;
        }
        cursor += 1;
      }
    }
    if (valid && !isAsciiAlphanumeric(value[cursor])) {
      spans.push({ end: cursor, finding: "RECOVERY_CODE", start });
      start = cursor - 1;
    }
  }
  return spans;
}

function paymentCardSpans(value: string): readonly MemorySecretSpan[] {
  const spans: MemorySecretSpan[] = [];
  for (let start = 0; start < value.length; start += 1) {
    if (!isAsciiDigit(value[start]) || isAsciiDigit(value[start - 1])) continue;
    let end = start;
    let separators = 0;
    while (end < value.length) {
      const character = value[end];
      if (isAsciiDigit(character)) {
        end += 1;
        continue;
      }
      if ((character === " " || character === "-") && separators < 8 &&
        isAsciiDigit(value[end + 1])) {
        separators += 1;
        end += 1;
        continue;
      }
      break;
    }
    const candidate = value.slice(start, end);
    const digits = digitsOnly(candidate);
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(candidate)) {
      spans.push({ end, finding: "PAYMENT_CARD", start });
      start = end - 1;
    }
  }
  return spans;
}

function highEntropySpans(value: string): readonly MemorySecretSpan[] {
  return tokenRunSpans(value).flatMap((run) => highEntropy(run.text)
    ? [{ end: run.end, finding: "HIGH_ENTROPY_TOKEN" as const, start: run.start }]
    : []);
}

function secretSpans(value: string): readonly MemorySecretSpan[] {
  const spans = [
    ...privateKeySpans(value),
    ...credentialUrlSpans(value),
    ...jwtSpans(value),
    ...knownTokenSpans(value),
    ...recoveryCodeSpans(value),
    ...paymentCardSpans(value),
    ...highEntropySpans(value)
  ];
  const seen = new Set<string>();
  return Object.freeze(spans.filter((span) => {
    if (span.start < 0 || span.end <= span.start || span.end > value.length) return false;
    const key = `${span.finding}:${span.start}:${span.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => left.start - right.start || right.end - left.end ||
    left.finding.localeCompare(right.finding)));
}

/**
 * Redacts only locally recognized secret-shaped spans while retaining the
 * surrounding query or statement verbatim. The richer cross-path Safety Lite
 * policy owns detector actions; this primitive deliberately mirrors the
 * current conservative parser so callers can create a provider-safe boundary
 * without weakening existing write-path rejection.
 */
export function redactMemorySecrets(value: string): MemorySecretRedactionResult {
  if (typeof value !== "string" || value.length === 0) {
    return {
      containsSecret: false,
      findings: Object.freeze([]),
      redactedText: typeof value === "string" ? value : "",
      spans: Object.freeze([])
    };
  }
  const spans = secretSpans(value);
  const findings = MEMORY_SECRET_FINDINGS.filter((finding) =>
    spans.some((span) => span.finding === finding));
  if (spans.length === 0) {
    return {
      containsSecret: false,
      findings: Object.freeze([]),
      redactedText: value,
      spans
    };
  }
  const merged: Array<{ end: number; start: number }> = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    if (previous && span.start < previous.end) {
      previous.end = Math.max(previous.end, span.end);
    } else {
      merged.push({ end: span.end, start: span.start });
    }
  }
  let cursor = 0;
  let redactedText = "";
  for (const span of merged) {
    redactedText += value.slice(cursor, span.start) + MEMORY_SECRET_REDACTION_PLACEHOLDER;
    cursor = span.end;
  }
  redactedText += value.slice(cursor);
  return {
    containsSecret: true,
    findings: Object.freeze(findings),
    redactedText,
    spans
  };
}

export function parseMemorySecret(value: string): MemorySecretParseResult {
  if (typeof value !== "string" || value.length === 0) {
    return { containsSecret: false, findings: Object.freeze([]) };
  }
  const findings = findingList(value);
  return {
    containsSecret: findings.length > 0,
    findings: Object.freeze(findings)
  };
}
