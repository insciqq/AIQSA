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

export type MemorySecretConfidence = "HIGH" | "LOW" | "MEDIUM";
export type MemorySecretDetectorClass =
  | "CHECKSUM"
  | "HEURISTIC_ENTROPY"
  | "KNOWN_FORMAT"
  | "STRUCTURAL_FORMAT";
export type MemorySecretPolicyAction = "AUDIT_ONLY" | "REDACT";

export type MemorySecretParseResult = Readonly<{
  containsSecret: boolean;
  findings: readonly MemorySecretFinding[];
  spans: readonly MemorySecretSpan[];
}>;

export type MemorySecretSpan = Readonly<{
  action: MemorySecretPolicyAction;
  confidence: MemorySecretConfidence;
  detectorClass: MemorySecretDetectorClass;
  end: number;
  finding: MemorySecretFinding;
  placeholder: string;
  start: number;
}>;

export type MemorySecretSourceMapEntry = Readonly<{
  kind: "REDACTION" | "SOURCE";
  outputEnd: number;
  outputStart: number;
  sourceEnd: number;
  sourceStart: number;
}>;

export type MemorySecretRedactionResult = Readonly<{
  containsSecret: boolean;
  detections: readonly MemorySecretSpan[];
  findings: readonly MemorySecretFinding[];
  redactedText: string;
  sourceMap: readonly MemorySecretSourceMapEntry[];
  spans: readonly MemorySecretSpan[];
}>;

/** Redacts a JSON/object key and assigns a deterministic collision suffix.
 * The suffix loop must advance: a prior literal key can already occupy the
 * first generated suffix after two distinct secrets collapse to one key. */
export function memorySecretSafeObjectKey(
  key: string,
  usedKeys: Set<string>
): string {
  const baseKey = redactMemorySecrets(key).redactedText;
  let safeKey = baseKey;
  let suffix = 2;
  while (usedKeys.has(safeKey)) {
    safeKey = `${baseKey}#${suffix}`;
    suffix += 1;
  }
  usedKeys.add(safeKey);
  return safeKey;
}

/** Recursive last-line check for JSON/provider structures. Generic entropy is
 * still audit-only because the scalar parser reports containsSecret only for
 * v1 REDACT findings. Cycles are ignored after their first visit so defensive
 * callers can inspect arbitrary decoded objects without recursing forever. */
export function memoryValueContainsRecognizedSecret(
  value: unknown,
  seen: WeakSet<object> = new WeakSet()
): boolean {
  if (typeof value === "string") return redactMemorySecrets(value).containsSecret;
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => memoryValueContainsRecognizedSecret(entry, seen));
  }
  return Object.entries(value).some(([key, entry]) =>
    redactMemorySecrets(key).containsSecret ||
    memoryValueContainsRecognizedSecret(entry, seen));
}

export const MEMORY_SECRET_REDACTION_PLACEHOLDER = "[REDACTED_SECRET]" as const;

type MemorySecretCandidateSpan = Readonly<{
  end: number;
  finding: MemorySecretFinding;
  start: number;
}>;

const MEMORY_SECRET_POLICY = Object.freeze({
  CREDENTIAL_URL: Object.freeze({
    action: "REDACT",
    confidence: "HIGH",
    detectorClass: "STRUCTURAL_FORMAT",
    placeholder: "[REDACTED:CREDENTIAL_URL]"
  }),
  HIGH_ENTROPY_TOKEN: Object.freeze({
    action: "AUDIT_ONLY",
    confidence: "LOW",
    detectorClass: "HEURISTIC_ENTROPY",
    placeholder: "[REDACTED:HIGH_ENTROPY_TOKEN]"
  }),
  JSON_WEB_TOKEN: Object.freeze({
    action: "REDACT",
    confidence: "HIGH",
    detectorClass: "STRUCTURAL_FORMAT",
    placeholder: "[REDACTED:JWT]"
  }),
  KNOWN_TOKEN: Object.freeze({
    action: "REDACT",
    confidence: "HIGH",
    detectorClass: "KNOWN_FORMAT",
    placeholder: "[REDACTED:TOKEN]"
  }),
  PAYMENT_CARD: Object.freeze({
    action: "REDACT",
    confidence: "HIGH",
    detectorClass: "CHECKSUM",
    placeholder: "[REDACTED:PAYMENT_CARD]"
  }),
  PEM_PRIVATE_KEY: Object.freeze({
    action: "REDACT",
    confidence: "HIGH",
    detectorClass: "STRUCTURAL_FORMAT",
    placeholder: "[REDACTED:PRIVATE_KEY]"
  }),
  RECOVERY_CODE: Object.freeze({
    action: "REDACT",
    confidence: "MEDIUM",
    detectorClass: "STRUCTURAL_FORMAT",
    placeholder: "[REDACTED:RECOVERY_CODE]"
  })
} satisfies Readonly<Record<MemorySecretFinding, Readonly<{
  action: MemorySecretPolicyAction;
  confidence: MemorySecretConfidence;
  detectorClass: MemorySecretDetectorClass;
  placeholder: string;
}>>>);

const NON_MEANINGFUL_REDACTION_LABELS = new Set([
  "api",
  "card",
  "code",
  "credential",
  "credentials",
  "is",
  "key",
  "my",
  "password",
  "private",
  "recovery",
  "secret",
  "the",
  "token",
  "карта",
  "ключ",
  "код",
  "мой",
  "моя",
  "пароль",
  "секрет",
  "токен"
]);

const MEMORY_MUTATION_WRAPPER_WORDS = new Set([
  ...NON_MEANINGFUL_REDACTION_LABELS,
  "across",
  "all",
  "chat",
  "chats",
  "conversation",
  "conversations",
  "for",
  "future",
  "in",
  "keep",
  "please",
  "remember",
  "save",
  "store",
  "use",
  "будущих",
  "будущее",
  "в",
  "все",
  "диалогах",
  "диалоги",
  "запомни",
  "пожалуйста",
  "сохрани",
  "храни"
]);

const MEMORY_REDACTION_PLACEHOLDER_PATTERN = /\[REDACTED:[A-Z_]+\]/gu;

const ASCII_DIGITS = "0123456789";
const ASCII_LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
// '=' is a common assignment delimiter around credentials (for example
// api_key=sk-...). Treating it as part of the surrounding run would hide a
// known-format prefix behind an ordinary label. Padding itself is not needed
// by any v1 known-token detector.
const TOKEN_CHARACTERS = `${ASCII_DIGITS}${ASCII_LETTERS}+/_-.`;
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

function characterRunSpans(
  value: string,
  characters: string
): readonly Readonly<{
  end: number;
  start: number;
  text: string;
}>[] {
  const runs: Array<Readonly<{ end: number; start: number; text: string }>> = [];
  let start = -1;
  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index];
    const allowed = character !== undefined && characters.includes(character);
    if (allowed && start < 0) start = index;
    if ((!allowed || index === value.length) && start >= 0) {
      runs.push({ end: index, start, text: value.slice(start, index) });
      start = -1;
    }
  }
  return runs;
}

function tokenRunSpans(value: string): ReturnType<typeof characterRunSpans> {
  return characterRunSpans(value, TOKEN_CHARACTERS);
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

function privateKeySpans(value: string): readonly MemorySecretCandidateSpan[] {
  const spans: MemorySecretCandidateSpan[] = [];
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

function credentialUrlSpans(value: string): readonly MemorySecretCandidateSpan[] {
  const spans: MemorySecretCandidateSpan[] = [];
  const schemeCharacters = `${ASCII_DIGITS}${ASCII_LETTERS}+.-`;
  const terminalDelimiters = "\t\n\r ,;!?()[]{}<>\"'";
  let searchFrom = 0;
  while (searchFrom < value.length) {
    const separator = value.indexOf("://", searchFrom);
    if (separator < 0) break;
    let start = separator;
    while (start > 0 && schemeCharacters.includes(value[start - 1] ?? "")) {
      start -= 1;
    }
    let end = separator + 3;
    while (end < value.length &&
      !terminalDelimiters.includes(value[end] ?? "")) end += 1;
    while (end > separator + 3 && ".:".includes(value[end - 1] ?? "")) end -= 1;
    const token = value.slice(start, end);
    try {
      const parsed = new URL(token);
      if (parsed.username.length > 0 && parsed.password.length > 0) {
        spans.push({ end, finding: "CREDENTIAL_URL", start });
      }
    } catch {
      // A malformed candidate has no trustworthy local URL boundary and is
      // not promoted by this exact-format detector.
    }
    searchFrom = Math.max(separator + 3, end);
  }
  return spans;
}

function jwtSpans(value: string): readonly MemorySecretCandidateSpan[] {
  return characterRunSpans(value, `${BASE64URL_CHARACTERS}.`).flatMap((run) => {
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

function knownTokenSpans(value: string): readonly MemorySecretCandidateSpan[] {
  const spans: MemorySecretCandidateSpan[] = [];
  for (let start = 0; start < value.length; start += 1) {
    const previous = value[start - 1];
    if (isAsciiAlphanumeric(previous) || previous === "_") continue;
    if (value.startsWith("AKIA", start)) {
      const end = start + 20;
      if (end <= value.length && everyCharacter(
        value.slice(start + 4, end),
        `${ASCII_DIGITS}ABCDEFGHIJKLMNOPQRSTUVWXYZ`
      ) && !isAsciiAlphanumeric(value[end])) {
        spans.push({ end, finding: "KNOWN_TOKEN", start });
        start = end - 1;
      }
      continue;
    }
    const openAi = value.startsWith("sk-", start);
    const github = value.startsWith("gh", start) &&
      "pousr".includes(value[start + 2] ?? "") && value[start + 3] === "_";
    if (!openAi && !github) continue;
    let end = start + (openAi ? 3 : 4);
    while (end < value.length && TOKEN_CHARACTERS.includes(value[end] ?? "")) end += 1;
    const minimumLength = openAi ? 20 : 24;
    if (end - start >= minimumLength) {
      spans.push({ end, finding: "KNOWN_TOKEN", start });
      start = end - 1;
    }
  }
  return spans;
}

function recoveryCodeSpans(value: string): readonly MemorySecretCandidateSpan[] {
  const spans: MemorySecretCandidateSpan[] = [];
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

function paymentCardSpans(value: string): readonly MemorySecretCandidateSpan[] {
  const spans: MemorySecretCandidateSpan[] = [];
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

function highEntropySpans(value: string): readonly MemorySecretCandidateSpan[] {
  return tokenRunSpans(value).flatMap((run) => highEntropy(run.text)
    ? [{ end: run.end, finding: "HIGH_ENTROPY_TOKEN" as const, start: run.start }]
    : []);
}

function secretSpans(value: string): readonly MemorySecretSpan[] {
  const candidates = [
    ...privateKeySpans(value),
    ...credentialUrlSpans(value),
    ...jwtSpans(value),
    ...knownTokenSpans(value),
    ...recoveryCodeSpans(value),
    ...paymentCardSpans(value),
    ...highEntropySpans(value)
  ];
  const seen = new Set<string>();
  return Object.freeze(candidates.filter((span) => {
    if (span.start < 0 || span.end <= span.start || span.end > value.length) return false;
    const key = `${span.finding}:${span.start}:${span.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((span): MemorySecretSpan => Object.freeze({
    ...span,
    ...MEMORY_SECRET_POLICY[span.finding]
  })).sort((left, right) => left.start - right.start || right.end - left.end ||
    left.finding.localeCompare(right.finding)));
}

function normalizedRedactionSpans(
  detections: readonly MemorySecretSpan[]
): readonly MemorySecretSpan[] {
  const longestFirst = detections.filter((span) => span.action === "REDACT")
    .sort((left, right) =>
      (right.end - right.start) - (left.end - left.start) ||
      left.start - right.start || left.finding.localeCompare(right.finding));
  const selected: MemorySecretSpan[] = [];
  for (const candidate of longestFirst) {
    const overlaps = selected.some((span) =>
      candidate.start < span.end && candidate.end > span.start);
    if (!overlaps) selected.push(candidate);
  }
  return Object.freeze(selected.sort((left, right) => left.start - right.start ||
    left.end - right.end || left.finding.localeCompare(right.finding)));
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
      detections: Object.freeze([]),
      findings: Object.freeze([]),
      redactedText: typeof value === "string" ? value : "",
      sourceMap: Object.freeze([]),
      spans: Object.freeze([])
    };
  }
  const detections = secretSpans(value);
  const spans = normalizedRedactionSpans(detections);
  const findings = MEMORY_SECRET_FINDINGS.filter((finding) =>
    detections.some((span) => span.finding === finding));
  if (spans.length === 0) {
    return {
      containsSecret: false,
      detections,
      findings: Object.freeze(findings),
      redactedText: value,
      sourceMap: Object.freeze([{
        kind: "SOURCE",
        outputEnd: value.length,
        outputStart: 0,
        sourceEnd: value.length,
        sourceStart: 0
      }]),
      spans
    };
  }
  let cursor = 0;
  let redactedText = "";
  const sourceMap: MemorySecretSourceMapEntry[] = [];
  for (const span of spans) {
    if (cursor < span.start) {
      const outputStart = redactedText.length;
      redactedText += value.slice(cursor, span.start);
      sourceMap.push({
        kind: "SOURCE",
        outputEnd: redactedText.length,
        outputStart,
        sourceEnd: span.start,
        sourceStart: cursor
      });
    }
    const outputStart = redactedText.length;
    redactedText += span.placeholder;
    sourceMap.push({
      kind: "REDACTION",
      outputEnd: redactedText.length,
      outputStart,
      sourceEnd: span.end,
      sourceStart: span.start
    });
    cursor = span.end;
  }
  if (cursor < value.length) {
    const outputStart = redactedText.length;
    redactedText += value.slice(cursor);
    sourceMap.push({
      kind: "SOURCE",
      outputEnd: redactedText.length,
      outputStart,
      sourceEnd: value.length,
      sourceStart: cursor
    });
  }
  return {
    containsSecret: true,
    detections,
    findings: Object.freeze(findings),
    redactedText,
    sourceMap: Object.freeze(sourceMap),
    spans
  };
}

/** True when copied source characters retain information beyond a label for
 * the removed value. Placeholders never make a secret-only projection
 * eligible on their own. */
export function memoryRedactionHasMeaningfulRemainder(
  value: string,
  result: MemorySecretRedactionResult = redactMemorySecrets(value)
): boolean {
  const retained = result.sourceMap
    .filter((entry) => entry.kind === "SOURCE")
    .map((entry) => value.slice(entry.sourceStart, entry.sourceEnd))
    .join(" ");
  const tokens = retained.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.some((token) => !NON_MEANINGFUL_REDACTION_LABELS.has(token));
}

/** Determines whether an already-redacted projection still carries content
 * beyond a secret label or Memory-command wrapper. */
export function memoryProjectionHasMeaningfulText(value: string): boolean {
  const tokens = value.replace(MEMORY_REDACTION_PLACEHOLDER_PATTERN, " ")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.some((token) => !MEMORY_MUTATION_WRAPPER_WORDS.has(token));
}

export function parseMemorySecret(value: string): MemorySecretParseResult {
  if (typeof value !== "string" || value.length === 0) {
    return {
      containsSecret: false,
      findings: Object.freeze([]),
      spans: Object.freeze([])
    };
  }
  const spans = secretSpans(value);
  const findings = MEMORY_SECRET_FINDINGS.filter((finding) =>
    spans.some((span) => span.finding === finding));
  return {
    containsSecret: spans.some((span) => span.action === "REDACT"),
    findings: Object.freeze(findings),
    spans
  };
}
