export const MEMORY_ACTION_ADMISSION_VERSION =
  "memory-action-admission-v1" as const;

export const MEMORY_ACTION_ADMISSION_STATES = [
  "EXPLICIT_CANDIDATE",
  "ORDINARY"
] as const;

export type MemoryActionAdmissionState =
  (typeof MEMORY_ACTION_ADMISSION_STATES)[number];

export type MemoryActionAdmission = Readonly<{
  reason: "MEMORY_COMMAND" | "NATURAL_LANGUAGE_DIRECTIVE" | "NO_DIRECTIVE";
  state: MemoryActionAdmissionState;
  version: typeof MEMORY_ACTION_ADMISSION_VERSION;
}>;

const MAXIMUM_ACTION_ADMISSION_CHARACTERS = 2_000;

const politePrefixes = [
  ["please"],
  ["please", "can", "you"],
  ["please", "could", "you"],
  ["can", "you", "please"],
  ["could", "you", "please"],
  ["i", "want", "you", "to"],
  ["i", "need", "you", "to"],
  ["пожалуйста"],
  ["пожалуйста", "можешь"],
  ["я", "хочу", "чтобы", "ты"],
  ["я", "прошу", "тебя"],
  ["por", "favor"],
  ["quiero", "que"],
  ["necesito", "que"],
  ["molim", "te"],
  ["želim", "da"],
  ["zelim", "da"],
  ["молим", "те"],
  ["желим", "да"]
] as const;

const unambiguousDirectivePrefixes = [
  // English.
  ["memorize"],
  ["forget"],
  ["save", "this"],
  ["save", "that"],
  ["save", "it"],
  ["save", "my"],
  ["save", "to", "memory"],
  ["store", "this"],
  ["store", "that"],
  ["store", "it"],
  ["store", "my"],
  ["update", "my"],
  ["update", "the", "saved"],
  ["change", "my"],
  ["change", "the", "saved"],
  ["correct", "my"],
  ["correct", "the", "saved"],
  ["replace", "my"],
  ["replace", "the", "saved"],
  ["this", "is", "no", "longer", "accurate"],
  ["this", "is", "no", "longer", "current"],
  ["this", "is", "no", "longer", "true"],
  ["that", "is", "no", "longer", "accurate"],
  ["that", "is", "no", "longer", "current"],
  ["that", "is", "no", "longer", "true"],
  // Russian.
  ["запомни"],
  ["сохрани", "это"],
  ["сохрани", "в", "памяти"],
  ["забудь"],
  ["обнови", "мою"],
  ["обнови", "моё"],
  ["измени", "мою"],
  ["измени", "моё"],
  ["исправь", "мою"],
  ["исправь", "моё"],
  ["это", "больше", "не", "актуально"],
  ["это", "больше", "не", "верно"],
  // Spanish.
  ["memoriza"],
  ["guarda", "esto"],
  ["guarda", "eso"],
  ["guarda", "en", "la", "memoria"],
  ["olvida"],
  ["actualiza", "mi"],
  ["cambia", "mi"],
  ["corrige", "mi"],
  ["esto", "ya", "no", "es", "correcto"],
  ["eso", "ya", "no", "es", "correcto"],
  // Serbian, Latin and Cyrillic.
  ["zapamti"],
  ["sačuvaj", "ovo"],
  ["sacuvaj", "ovo"],
  ["zaboravi"],
  ["ažuriraj", "moj"],
  ["azuriraj", "moj"],
  ["izmeni", "moj"],
  ["ispravi", "moj"],
  ["ovo", "više", "nije", "tačno"],
  ["ovo", "vise", "nije", "tacno"],
  ["запамти"],
  ["сачувај", "ово"],
  ["заборави"],
  ["ажурирај", "мој"],
  ["измени", "мој"],
  ["исправи", "мој"],
  ["ово", "више", "није", "тачно"]
] as const;

const memoryNouns = new Set([
  "memories", "memory", "recuerdos", "memoria", "memorias",
  "memoriji", "memoriju", "pamćenja", "pamćenje", "памяти", "память",
  "меморији", "меморију", "памћења", "памћење"
]);

const savedNouns = new Set([
  "remembered", "saved", "guardados", "guardadas", "sačuvane", "sacuvane",
  "sačuvanih", "sacuvanih", "сохранённые", "сохраненные", "сохранённых",
  "сохраненных", "сачуване", "сачуваних"
]);

const scopedUseVerbs = new Set([
  "apply", "carry", "keep", "use", "aplica", "conserva", "guarda", "usa",
  "koristi", "sačuvaj", "sacuvaj", "используй", "применяй", "сохрани",
  "користи", "сачувај"
]);

const futureScopeWords = new Set([
  "across", "chat", "chats", "conversation", "conversations", "future", "later",
  "memory", "next", "futuras", "futuros", "memoria", "próximas", "proximas",
  "ubuduće", "ubuduce", "memoriji", "будущих", "будущем", "дальше", "памяти",
  "убудуће", "меморији"
]);

const managementVerbs = new Set([
  "change", "clear", "correct", "delete", "erase", "find", "list", "open",
  "remove", "replace", "reset", "search", "show", "update", "actualiza",
  "borra", "busca", "cambia", "corrige", "elimina", "lista", "muestra",
  "reemplaza", "restablece", "ažuriraj", "azuriraj", "ispravi", "izmeni",
  "obriši", "obrisi", "pretraži", "pretrazi", "prikaži", "prikazi",
  "resetuj", "ukloni", "zameni", "измени", "исправь", "найди", "обнови",
  "очисти", "покажи", "сбрось", "удали", "замени", "ажурирај", "измени",
  "исправи", "обриши", "претражи", "прикажи", "ресетуј", "уклони"
]);

const recallQuestionFollowers = new Set([
  "how", "what", "when", "where", "which", "who", "why",
  "cómo", "como", "cuál", "cual", "cuándo", "cuando", "dónde", "donde",
  "por", "qué", "quién", "quien"
]);

const personalMemoryQualifiers = new Set([
  "all", "my", "saved", "the", "mi", "mis", "todas", "todos", "мою", "мои",
  "моих", "сохраненные", "сохранённые", "всю", "moj", "moja", "moje",
  "moju", "mojih", "sve", "мој", "моја", "моје", "моју", "мојих", "све"
]);

function semanticTokens(value: string): readonly string[] {
  return value.normalize("NFKC").toLocaleLowerCase("und")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function startsWithTokens(
  tokens: readonly string[],
  prefix: readonly string[]
): boolean {
  return prefix.length <= tokens.length &&
    prefix.every((token, index) => tokens[index] === token);
}

function stripPolitePrefix(tokens: readonly string[]): readonly string[] {
  const matched = politePrefixes
    .filter((prefix) => startsWithTokens(tokens, prefix))
    .sort((left, right) => right.length - left.length)[0];
  return matched ? tokens.slice(matched.length) : tokens;
}

function naturalLanguageDirective(tokens: readonly string[]): boolean {
  const command = stripPolitePrefix(tokens);
  if (command.length === 0) return false;
  if (command[0] === "remember") {
    return !recallQuestionFollowers.has(command[1] ?? "");
  }
  if (command[0] === "recuerda") {
    return !recallQuestionFollowers.has(command[1] ?? "");
  }
  if (unambiguousDirectivePrefixes.some((prefix) =>
    startsWithTokens(command, prefix))) return true;
  if (scopedUseVerbs.has(command[0]!) &&
    command.slice(1).some((token) => futureScopeWords.has(token))) return true;
  if (!managementVerbs.has(command[0]!)) return false;
  if (command.slice(1).some((token) => savedNouns.has(token))) return true;
  return command.slice(1).some((token, offset) => memoryNouns.has(token) &&
    personalMemoryQualifiers.has(command[offset] ?? ""));
}

/**
 * Provider-free dispatch gate for the strict Memory action classifier.
 *
 * This gate grants no action, target, or mutation authority. A positive result
 * only permits one forced-structured System Model call; that call and the
 * existing server-side ownership/evidence checks remain authoritative. A
 * negative result always stays on the ordinary read-only path. `/memory` is a
 * language-neutral explicit escape hatch for commands outside the bounded
 * natural-language directive grammar.
 */
export function admitMemoryAction(text: string): MemoryActionAdmission {
  const bounded = text.slice(0, MAXIMUM_ACTION_ADMISSION_CHARACTERS).trimStart();
  if (/^\/memory(?:\s|$)/iu.test(bounded)) {
    return Object.freeze({
      reason: "MEMORY_COMMAND",
      state: "EXPLICIT_CANDIDATE",
      version: MEMORY_ACTION_ADMISSION_VERSION
    });
  }
  const state = naturalLanguageDirective(semanticTokens(bounded))
    ? "EXPLICIT_CANDIDATE"
    : "ORDINARY";
  return Object.freeze({
    reason: state === "EXPLICIT_CANDIDATE"
      ? "NATURAL_LANGUAGE_DIRECTIVE"
      : "NO_DIRECTIVE",
    state,
    version: MEMORY_ACTION_ADMISSION_VERSION
  });
}
