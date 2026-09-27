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

const MEMORY_REDACTION_PLACEHOLDER_PATTERN = /\[REDACTED(?::[A-Z_]+|_SECRET)\]/gu;

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
// Credential-URL terminators. None belongs to a token, JWT, recovery-code or
// card alphabet (a card may only span one space between digits), and every
// left/right context check treats them like a text edge. Windowed redaction
// and the join check rely on this; a detector matching across them must
// update both and their equivalence tests.
const URL_TERMINAL_DELIMITERS = "\t\n\r ,;!?()[]{}<>\"'";
const HARD_BREAK_DELIMITERS = URL_TERMINAL_DELIMITERS.replace(" ", "");

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
      !URL_TERMINAL_DELIMITERS.includes(value[end] ?? "")) end += 1;
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

/** Detectors whose matches never cross URL_TERMINAL_DELIMITERS. */
function singleLineCandidateSpans(value: string): readonly MemorySecretCandidateSpan[] {
  return [
    ...credentialUrlSpans(value),
    ...jwtSpans(value),
    ...knownTokenSpans(value),
    ...recoveryCodeSpans(value),
    ...paymentCardSpans(value),
    ...highEntropySpans(value)
  ];
}

function secretSpans(value: string): readonly MemorySecretSpan[] {
  return policySpans([
    ...privateKeySpans(value),
    ...singleLineCandidateSpans(value)
  ], 0, value.length);
}

function policySpans(
  candidates: readonly MemorySecretCandidateSpan[],
  lowerBound: number,
  upperBound: number
): readonly MemorySecretSpan[] {
  const seen = new Set<string>();
  return Object.freeze(candidates.filter((span) => {
    if (span.start < lowerBound || span.end <= span.start || span.end > upperBound) {
      return false;
    }
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

/** Replaces source text that was withheld without a scan. It is a marker,
 * not a secret finding, and never carries any withheld character. */
export const MEMORY_UNPROCESSED_TEXT_PLACEHOLDER = "[REDACTED:UNPROCESSED_TEXT]" as const;

export type MemorySecretSourceRange = Readonly<{ end: number; start: number }>;

export type MemorySecretWindowOptions = Readonly<{
  /** Scanned code units after which the remaining text is withheld. */
  maxCodeUnits: number;
  /** Largest source window one detector pass scans. */
  windowCodeUnits: number;
}>;

export type MemorySecretWindowedRedactionResult = Readonly<{
  containsSecret: boolean;
  redactedText: string;
  sourceMap: readonly MemorySecretSourceMapEntry[];
  spans: readonly MemorySecretSpan[];
  /** Unscanned source ranges, each replaced by the unprocessed placeholder. */
  withheld: readonly MemorySecretSourceRange[];
}>;

type WindowedOutput = {
  outputLength: number;
  parts: string[];
  sourceMap: MemorySecretSourceMapEntry[];
  spans: MemorySecretSpan[];
  withheld: MemorySecretSourceRange[];
};

function emitSource(
  output: WindowedOutput,
  value: string,
  start: number,
  end: number
): void {
  if (end <= start) return;
  const text = value.slice(start, end);
  const previous = output.sourceMap.at(-1);
  // Canonical maps merge contiguous copied source, as a single pass does.
  if (previous?.kind === "SOURCE" && previous.sourceEnd === start) {
    output.sourceMap[output.sourceMap.length - 1] = {
      ...previous,
      outputEnd: previous.outputEnd + text.length,
      sourceEnd: end
    };
  } else {
    output.sourceMap.push({
      kind: "SOURCE",
      outputEnd: output.outputLength + text.length,
      outputStart: output.outputLength,
      sourceEnd: end,
      sourceStart: start
    });
  }
  output.parts.push(text);
  output.outputLength += text.length;
}

function emitReplacement(
  output: WindowedOutput,
  placeholder: string,
  start: number,
  end: number
): void {
  output.sourceMap.push({
    kind: "REDACTION",
    outputEnd: output.outputLength + placeholder.length,
    outputStart: output.outputLength,
    sourceEnd: end,
    sourceStart: start
  });
  output.parts.push(placeholder);
  output.outputLength += placeholder.length;
}

function emitWindow(
  output: WindowedOutput,
  value: string,
  start: number,
  end: number,
  spans: readonly MemorySecretSpan[]
): void {
  let cursor = start;
  for (const span of spans) {
    emitSource(output, value, cursor, span.start);
    emitReplacement(output, span.placeholder, span.start, span.end);
    output.spans.push(span);
    cursor = span.end;
  }
  emitSource(output, value, cursor, end);
}

function emitWithheld(output: WindowedOutput, start: number, end: number): void {
  const previous = output.withheld.at(-1);
  if (previous?.end === start) {
    output.withheld[output.withheld.length - 1] = { end, start: previous.start };
    const entry = output.sourceMap.at(-1)!;
    output.sourceMap[output.sourceMap.length - 1] = { ...entry, sourceEnd: end };
    return;
  }
  output.withheld.push({ end, start });
  emitReplacement(output, MEMORY_UNPROCESSED_TEXT_PLACEHOLDER, start, end);
}

/**
 * Yields the window cuts in (from, to] in order. A cut after a URL terminator
 * keeps every single-line detector unchanged, except between card digit
 * groups; so does a cut after a complete non-ASCII code point unless a
 * credential URL may still continue ("://" since the last terminator). No cut
 * falls inside a multi-line span. `from` is itself a cut, so no URL
 * candidate is open there.
 */
function* windowCuts(
  value: string,
  multiline: readonly MemorySecretCandidateSpan[],
  multilineIndex: number,
  from: number,
  to: number
): Generator<number, void, undefined> {
  let urlOpen = false;
  let spanIndex = multilineIndex;
  for (let index = from; index < to; index += 1) {
    const character = value[index] ?? "";
    let candidate: boolean;
    if (URL_TERMINAL_DELIMITERS.includes(character)) {
      urlOpen = false;
      candidate = character !== " " ||
        !(isAsciiDigit(value[index - 1]) && isAsciiDigit(value[index + 1]));
    } else {
      if (character === ":" && value.startsWith("://", index)) urlOpen = true;
      const code = value.charCodeAt(index);
      candidate = code > 0x7f && !(code >= 0xd800 && code <= 0xdbff) && !urlOpen;
    }
    if (!candidate) continue;
    const cut = index + 1;
    while (spanIndex < multiline.length && multiline[spanIndex]!.end <= cut) {
      spanIndex += 1;
    }
    const containing = multiline[spanIndex];
    if (containing && containing.start < cut) continue;
    yield cut;
  }
}

/**
 * Redacts text of any length in bounded windows. Windows end only at cuts
 * that no detector can cross, and multi-line spans come from the whole text,
 * so a secret on a window boundary stays whole and every scanned window
 * equals one full pass (`redactMemorySecrets`) over the same range, including
 * overlap normalization. What cannot be scanned that way is withheld behind
 * the unprocessed placeholder, never passed on unscanned: a stretch longer
 * than a window without a cut (for example one opaque run, or an oversized
 * multi-line span), and everything after `maxCodeUnits` of scanned text.
 */
export function redactMemorySecretsInWindows(
  value: string,
  options: MemorySecretWindowOptions
): MemorySecretWindowedRedactionResult {
  const { maxCodeUnits, windowCodeUnits } = options;
  if (!Number.isSafeInteger(windowCodeUnits) || windowCodeUnits < 1 ||
    !(maxCodeUnits === Number.POSITIVE_INFINITY || Number.isSafeInteger(maxCodeUnits)) ||
    maxCodeUnits < windowCodeUnits) {
    throw new Error("memory_secret_window_options_invalid");
  }
  if (typeof value !== "string" || value.length <= windowCodeUnits) {
    const single = redactMemorySecrets(value);
    return {
      containsSecret: single.containsSecret,
      redactedText: single.redactedText,
      sourceMap: single.sourceMap,
      spans: single.spans,
      withheld: Object.freeze([])
    };
  }
  const multiline = privateKeySpans(value);
  const output: WindowedOutput = {
    outputLength: 0,
    parts: [],
    sourceMap: [],
    spans: [],
    withheld: []
  };
  let multilineIndex = 0;
  let scanned = 0;
  let start = 0;
  while (start < value.length) {
    while (multilineIndex < multiline.length &&
      multiline[multilineIndex]!.end <= start) multilineIndex += 1;
    if (scanned >= maxCodeUnits) {
      emitWithheld(output, start, value.length);
      break;
    }
    const limit = Math.min(value.length, start + windowCodeUnits);
    let end = limit;
    if (limit < value.length) {
      end = start;
      for (const cut of windowCuts(value, multiline, multilineIndex, start, limit)) {
        end = cut;
      }
    }
    if (end === start) {
      let resume = value.length;
      for (const cut of windowCuts(value, multiline, multilineIndex, start, value.length)) {
        if (cut <= limit) continue;
        resume = cut;
        break;
      }
      emitWithheld(output, start, resume);
      start = resume;
      continue;
    }
    const windowStart = start;
    const windowCandidates: MemorySecretCandidateSpan[] = singleLineCandidateSpans(
      value.slice(windowStart, end)
    ).map((span) => ({
      end: span.end + windowStart,
      finding: span.finding,
      start: span.start + windowStart
    }));
    for (let index = multilineIndex; index < multiline.length; index += 1) {
      const span = multiline[index]!;
      if (span.start >= end) break;
      windowCandidates.push(span);
    }
    emitWindow(output, value, windowStart, end,
      normalizedRedactionSpans(policySpans(windowCandidates, windowStart, end)));
    scanned += end - windowStart;
    start = end;
  }
  return {
    containsSecret: output.spans.length > 0,
    redactedText: output.parts.join(""),
    sourceMap: Object.freeze(output.sourceMap),
    spans: Object.freeze(output.spans),
    withheld: Object.freeze(output.withheld)
  };
}

/**
 * Two texts that were each redacted on their own, joined by hard breaks,
 * cannot form a new single-line match (see URL_TERMINAL_DELIMITERS). Only a
 * multi-line span of the joined text can reveal a secret split between them;
 * any such span also marks one that neither redaction removed. This is a
 * boundary scan, not a length gate.
 */
export function memorySecretJoinIsSafe(
  left: string,
  separator: string,
  right: string
): boolean {
  if (!everyCharacter(separator, HARD_BREAK_DELIMITERS)) {
    throw new Error("memory_secret_join_separator_invalid");
  }
  return privateKeySpans(`${left}${separator}${right}`).length === 0;
}

/** Whether exact copied source retains letters or numbers after redaction.
 * This is a structural check, not a judgment of meaning or usefulness. */
export function memoryRedactionHasSourceText(
  value: string,
  result: Readonly<{ sourceMap: readonly MemorySecretSourceMapEntry[] }> =
    redactMemorySecrets(value)
): boolean {
  const retained = result.sourceMap
    .filter((entry) => entry.kind === "SOURCE")
    .map((entry) => value.slice(entry.sourceStart, entry.sourceEnd))
    .join(" ");
  return memoryProjectionHasSourceText(retained);
}

/** Literal markers carry no source text, including when supplied as input. */
export function memoryProjectionHasSourceText(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(
    value.replace(MEMORY_REDACTION_PLACEHOLDER_PATTERN, " ")
  );
}

export function memoryProjectionContainsRedaction(value: string): boolean {
  return value.search(MEMORY_REDACTION_PLACEHOLDER_PATTERN) !== -1;
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
