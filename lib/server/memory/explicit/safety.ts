const privateKeyPattern = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/u;
const credentialUrlPattern = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/iu;
const jwtPattern = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u;
const knownTokenPattern = /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,})\b/u;
const assignedSecretPattern = /\b(?:api[_ -]?key|access[_ -]?token|authorization|bearer|client[_ -]?secret|cookie|credential|pass(?:word|phrase)?|private[_ -]?key|recovery[_ -]?code|secret|session[_ -]?token|token)\b\s*(?:is|=|:|—|-)\s*\S{6,}/iu;
const assignedRussianSecretPattern = /(?:^|[^\p{L}\p{N}_])(?:api[_ -]*ключ|ключ[_ -]*api|парол(?:ь|я)|секрет|токен)(?=$|[^\p{L}\p{N}_])\s*(?:это|=|:|—|-)\s*\S{6,}/iu;
const recoveryCodePattern = /\b[A-Z0-9]{4}(?:[- ][A-Z0-9]{4}){3,}\b/iu;
const longTokenPattern = /\b[A-Za-z0-9+/_=-]{32,}\b/gu;
const cardCandidatePattern = /(?:\d[ -]?){13,19}/gu;

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

function highEntropyToken(value: string): boolean {
  const compact = value.replace(/[-_=]/gu, "");
  return compact.length >= 28 &&
    /[A-Za-z]/u.test(compact) &&
    /\d/u.test(compact) &&
    shannonEntropy(compact) >= 3.5;
}

function luhnValid(value: string): boolean {
  const digits = value.replace(/\D/gu, "");
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/u.test(digits)) {
    return false;
  }
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

export function memoryExplicitStatementContainsSecret(statement: string): boolean {
  if (
    privateKeyPattern.test(statement) ||
    credentialUrlPattern.test(statement) ||
    jwtPattern.test(statement) ||
    knownTokenPattern.test(statement) ||
    assignedSecretPattern.test(statement) ||
    assignedRussianSecretPattern.test(statement) ||
    recoveryCodePattern.test(statement)
  ) {
    return true;
  }
  for (const match of statement.matchAll(cardCandidatePattern)) {
    if (luhnValid(match[0])) return true;
  }
  for (const match of statement.matchAll(longTokenPattern)) {
    if (highEntropyToken(match[0])) return true;
  }
  return false;
}
