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

const ASCII_DIGITS = "0123456789";
const ASCII_LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const TOKEN_CHARACTERS = `${ASCII_DIGITS}${ASCII_LETTERS}+/_=-.`;
const BASE64URL_CHARACTERS = `${ASCII_DIGITS}${ASCII_LETTERS}_-`;
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

function isAsciiDigit(character: string | undefined): boolean {
  return character !== undefined && ASCII_DIGITS.includes(character);
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
  const words: string[] = [];
  let current = "";
  const flush = () => {
    if (current) words.push(current);
    current = "";
  };
  for (const character of value) {
    if (ASCII_DIGITS.includes(character) || ASCII_LETTERS.includes(character)) {
      current += character;
    } else {
      flush();
    }
  }
  flush();
  for (let index = 0; index + 3 < words.length; index += 1) {
    if (isRecoveryGroup(words[index] ?? "") &&
      isRecoveryGroup(words[index + 1] ?? "") &&
      isRecoveryGroup(words[index + 2] ?? "") &&
      isRecoveryGroup(words[index + 3] ?? "")) {
      return true;
    }
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
