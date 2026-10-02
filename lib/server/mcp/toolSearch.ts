import type { McpCapabilityCatalog } from "./runPlan";

/**
 * Deterministic in-process tool search over a frozen Auto catalog. It reads
 * only schema-free catalog text, performs no I/O and never calls a model:
 * `select:` resolves exact names from the connected tool index, any other
 * query is ranked with field-weighted BM25 over names and descriptions.
 */
export type McpToolSearchMatch = Readonly<{ namespacedName: string; score: number; exact: boolean }>;
export type McpToolSearchResult = Readonly<{
  mode: "select" | "keywords";
  matches: readonly McpToolSearchMatch[];
  unknownNames: readonly string[];
  candidateCount: number;
}>;

const K1 = 1.2;
const B = 0.75;
/** Original name, title, description, argument names, argument descriptions, server name, server description. */
const FIELD_WEIGHTS = [3, 2, 1, 1, 0.5, 1.5, 0.5] as const;
const FIELD_COUNT = FIELD_WEIGHTS.length;
const MAX_UNKNOWN_NAMES = 16;
const MAX_UNKNOWN_NAME_CHARACTERS = 120;

const STOP_WORDS = new Set([
  "a", "about", "all", "an", "and", "any", "are", "as", "at", "be", "by", "can", "could", "do", "does", "for",
  "from", "how", "in", "into", "is", "it", "its", "me", "my", "of", "on", "or", "our", "please", "some", "that",
  "the", "their", "these", "this", "those", "to", "us", "via", "we", "what", "which", "with", "you", "your",
  "в", "во", "все", "для", "до", "же", "за", "и", "из", "или", "как", "ко", "ли", "мне", "мой", "моя", "мои",
  "мою", "на", "надо", "не", "но", "нужно", "о", "об", "от", "по", "пожалуйста", "с", "со", "то", "у", "что", "это"
]);

/** Longest first; one ending is removed while the stem keeps three letters. */
const RUSSIAN_ENDINGS = [
  "иями", "ями", "ами", "ией", "иях", "его", "ого", "ему", "ому", "ыми", "ими", "ешь", "ете", "ите",
  "ия", "ие", "ии", "ий", "ью", "ья", "ье", "ей", "ой", "ый", "ая", "яя", "ое", "ее", "ые", "ым", "им",
  "ом", "ем", "ую", "юю", "ах", "ях", "ов", "ев", "ам", "ям", "ть", "ет", "ит", "ют", "ут", "ат", "ят",
  "ла", "ло", "ли", "а", "я", "о", "е", "ы", "и", "у", "ю", "ь", "й"
];

function stemEnglish(word: string): string {
  let stem = word;
  if (stem.length > 4 && stem.endsWith("ies")) stem = `${stem.slice(0, -3)}y`;
  else if (stem.length > 4 && /(?:ches|shes|sses|xes|zes)$/u.test(stem)) stem = stem.slice(0, -2);
  else if (stem.length > 3 && stem.endsWith("s") && !/(?:ss|us|is)$/u.test(stem)) stem = stem.slice(0, -1);
  // Conservative suffixes keep at least four letters: "string" and "embed" stay intact.
  if (stem.length > 4 && stem.endsWith("ied")) stem = `${stem.slice(0, -3)}y`;
  else if (stem.length >= 7 && stem.endsWith("ing")) stem = undouble(stem.slice(0, -3));
  else if (stem.length >= 6 && stem.endsWith("ed") && !stem.endsWith("eed")) stem = undouble(stem.slice(0, -2));
  // "create", "creating" and "created" share one stem.
  if (stem.length > 4 && stem.endsWith("e") && !stem.endsWith("ee")) stem = stem.slice(0, -1);
  return stem;
}

function undouble(stem: string): string {
  const last = stem.at(-1);
  return last && last === stem.at(-2) && /[b-df-hj-km-npqrtv-y]/u.test(last) ? stem.slice(0, -1) : stem;
}

function stemRussian(word: string): string {
  for (const ending of RUSSIAN_ENDINGS) {
    if (word.endsWith(ending) && word.length - ending.length >= 3) return word.slice(0, -ending.length);
  }
  return word;
}

function stem(word: string): string {
  if (/^[a-z]+$/u.test(word)) return stemEnglish(word);
  if (/^[а-я]+$/u.test(word)) return stemRussian(word);
  return word;
}

/** NFKC, camelCase/snake/kebab/path splitting, lowercase, ё→е, stop words and light stemming. */
export function mcpToolSearchTokens(text: string): string[] {
  const separated = text.normalize("NFKC")
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .toLowerCase()
    .replace(/ё/gu, "е");
  const tokens: string[] = [];
  for (const [token] of separated.matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
    if (token.length === 1 && !/\p{N}/u.test(token)) continue;
    if (STOP_WORDS.has(token)) continue;
    tokens.push(stem(token));
  }
  return tokens;
}

/** Names compare case- and whitespace-insensitively. */
function nameKey(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/ё/gu, "е").replace(/\s+/gu, "");
}

type IndexedTool = Readonly<{
  namespacedName: string;
  originalName: string;
  serverName: string;
  nameSequence: readonly string[];
}>;

type SearchIndex = Readonly<{
  tools: readonly IndexedTool[];
  postings: ReadonlyMap<string, readonly Readonly<{ tool: number; weight: number }>[]>;
  byNamespacedName: ReadonlyMap<string, number>;
  byNamespacedKey: ReadonlyMap<string, number>;
  byServerTool: ReadonlyMap<string, readonly number[]>;
  byName: ReadonlyMap<string, readonly number[]>;
  byFirstNameToken: ReadonlyMap<string, readonly number[]>;
}>;

const indexes = new WeakMap<McpCapabilityCatalog, SearchIndex>();

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function appendTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (!values) map.set(key, [value]);
  // One tool appends its entries consecutively (name, then an equal title).
  else if (values.at(-1) !== value) values.push(value);
}

function buildIndex(catalog: McpCapabilityCatalog): SearchIndex {
  const tools: IndexedTool[] = [];
  const frequencies: Map<string, number>[][] = [];
  const lengths: number[][] = [];
  const totals = new Array<number>(FIELD_COUNT).fill(0);
  const byNamespacedName = new Map<string, number>();
  const byNamespacedKey = new Map<string, number>();
  const byServerTool = new Map<string, number[]>();
  const byName = new Map<string, number[]>();
  const byFirstNameToken = new Map<string, number[]>();
  for (const server of catalog.servers) {
    const serverTokens = mcpToolSearchTokens(server.serverName);
    const serverDescriptionTokens = mcpToolSearchTokens(server.description);
    const serverKey = nameKey(server.serverName);
    for (const tool of server.tools) {
      if (byNamespacedName.has(tool.namespacedName)) continue;
      const index = tools.length;
      const nameSequence = mcpToolSearchTokens(tool.originalName);
      const fields = [
        nameSequence,
        mcpToolSearchTokens(tool.title ?? ""),
        mcpToolSearchTokens(tool.description ?? ""),
        (tool.arguments ?? []).flatMap((argument) => mcpToolSearchTokens(argument.name)),
        (tool.arguments ?? []).flatMap((argument) => mcpToolSearchTokens(argument.description ?? "")),
        serverTokens,
        serverDescriptionTokens
      ];
      frequencies.push(fields.map((tokens) => {
        const counts = new Map<string, number>();
        for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
        return counts;
      }));
      lengths.push(fields.map((tokens) => tokens.length));
      fields.forEach((tokens, field) => { totals[field] += tokens.length; });
      tools.push({ namespacedName: tool.namespacedName, originalName: tool.originalName,
        serverName: server.serverName, nameSequence });
      byNamespacedName.set(tool.namespacedName, index);
      if (!byNamespacedKey.has(nameKey(tool.namespacedName))) byNamespacedKey.set(nameKey(tool.namespacedName), index);
      for (const name of [tool.originalName, tool.title].filter((value): value is string => Boolean(value?.trim()))) {
        appendTo(byServerTool, `${serverKey}/${nameKey(name)}`, index);
        appendTo(byName, nameKey(name), index);
      }
      if (nameSequence.length > 0) appendTo(byFirstNameToken, nameSequence[0]!, index);
    }
  }
  const averages = totals.map((total) => tools.length ? total / tools.length : 0);
  const postings = new Map<string, { tool: number; weight: number }[]>();
  frequencies.forEach((fields, tool) => {
    const weights = new Map<string, number>();
    fields.forEach((counts, field) => {
      const average = averages[field]!;
      const norm = average > 0 ? 1 - B + B * lengths[tool]![field]! / average : 1;
      for (const [term, count] of counts) {
        weights.set(term, (weights.get(term) ?? 0) + FIELD_WEIGHTS[field]! * count / norm);
      }
    });
    for (const [term, weight] of weights) {
      const list = postings.get(term);
      if (list) list.push({ tool, weight });
      else postings.set(term, [{ tool, weight }]);
    }
  });
  const byServerThenName = (left: number, right: number) =>
    compareText(tools[left]!.serverName, tools[right]!.serverName) ||
    compareText(tools[left]!.originalName, tools[right]!.originalName) ||
    compareText(tools[left]!.namespacedName, tools[right]!.namespacedName);
  for (const values of byName.values()) values.sort(byServerThenName);
  for (const values of byServerTool.values()) values.sort(byServerThenName);
  return { tools, postings, byNamespacedName, byNamespacedKey, byServerTool, byName, byFirstNameToken };
}

function searchIndex(catalog: McpCapabilityCatalog): SearchIndex {
  let index = indexes.get(catalog);
  if (!index) {
    index = buildIndex(catalog);
    indexes.set(catalog, index);
  }
  return index;
}

function selectionEntries(query: string): string[] | null {
  const match = /^select:/iu.exec(query.trim());
  if (!match) return null;
  return query.trim().slice(match[0].length).split(",")
    .map((entry) => entry.trim().replace(/^["'`]+|["'`]+$/gu, "").trim())
    .filter(Boolean);
}

function boundedName(value: string): string {
  const characters = [...value.replace(/\s+/gu, " ")];
  return characters.length > MAX_UNKNOWN_NAME_CHARACTERS
    ? `${characters.slice(0, MAX_UNKNOWN_NAME_CHARACTERS - 1).join("")}…`
    : characters.join("");
}

function resolveEntry(index: SearchIndex, entry: string): readonly number[] {
  const exact = index.byNamespacedName.get(entry);
  if (exact !== undefined) return [exact];
  const key = nameKey(entry);
  const namespaced = index.byNamespacedKey.get(key);
  if (namespaced !== undefined) return [namespaced];
  return index.byServerTool.get(key) ?? index.byName.get(key) ?? [];
}

function containsSequence(haystack: readonly string[], needle: readonly string[], start: number): boolean {
  if (start + needle.length > haystack.length) return false;
  return needle.every((token, offset) => haystack[start + offset] === token);
}

/**
 * Searches the frozen catalog. `eligible` narrows the candidates (current
 * access); excluded tools are reported exactly like absent names.
 */
export function searchMcpCatalog(
  catalog: McpCapabilityCatalog,
  input: Readonly<{ query: string; limit: number; eligible?(namespacedName: string): boolean }>
): McpToolSearchResult {
  const index = searchIndex(catalog);
  const eligible = (tool: number) => input.eligible?.(index.tools[tool]!.namespacedName) ?? true;
  let candidateCount = 0;
  for (let tool = 0; tool < index.tools.length; tool++) if (eligible(tool)) candidateCount++;
  const limit = Number.isSafeInteger(input.limit) && input.limit > 0 ? input.limit : 0;
  const entries = selectionEntries(input.query);
  if (entries) {
    const matches: McpToolSearchMatch[] = [];
    const seen = new Set<number>();
    const unknownNames: string[] = [];
    for (const entry of entries) {
      const resolved = resolveEntry(index, entry).filter(eligible);
      if (resolved.length === 0) {
        if (unknownNames.length < MAX_UNKNOWN_NAMES) unknownNames.push(boundedName(entry));
        continue;
      }
      for (const tool of resolved) {
        if (seen.has(tool) || matches.length >= limit) continue;
        seen.add(tool);
        matches.push({ namespacedName: index.tools[tool]!.namespacedName, score: 1, exact: true });
      }
    }
    return { mode: "select", matches, unknownNames, candidateCount };
  }

  const sequence = mcpToolSearchTokens(input.query);
  const terms = [...new Set(sequence)].sort(compareText);
  const toolCount = index.tools.length;
  const scores = new Map<number, number>();
  let ceiling = 0;
  for (const term of terms) {
    const postings = index.postings.get(term);
    if (!postings) continue;
    const idf = Math.log(1 + (toolCount - postings.length + 0.5) / (postings.length + 0.5));
    ceiling += idf * (K1 + 1);
    for (const { tool, weight } of postings) {
      if (!eligible(tool)) continue;
      scores.set(tool, (scores.get(tool) ?? 0) + idf * weight * (K1 + 1) / (weight + K1));
    }
  }
  // A query that spells a tool's complete name outranks every lexical score
  // for that query; a longer spelled name outranks a shorter one. A one-word
  // name earns the bonus only as the whole query, so generic verbs such as
  // "search" or "list" cannot capture multi-word keyword queries.
  const exact = new Set<number>();
  for (let start = 0; start < sequence.length; start++) {
    for (const tool of index.byFirstNameToken.get(sequence[start]!) ?? []) {
      const name = index.tools[tool]!.nameSequence;
      if (exact.has(tool) || !eligible(tool) || name.length === 1 && sequence.length !== 1 ||
        !containsSequence(sequence, name, start)) continue;
      exact.add(tool);
      scores.set(tool, (scores.get(tool) ?? 0) + (ceiling + 1) * name.length);
    }
  }
  const matches = [...scores].filter(([, score]) => score > 0)
    .sort(([left, leftScore], [right, rightScore]) => rightScore - leftScore ||
      compareText(index.tools[left]!.serverName, index.tools[right]!.serverName) ||
      compareText(index.tools[left]!.originalName, index.tools[right]!.originalName) ||
      compareText(index.tools[left]!.namespacedName, index.tools[right]!.namespacedName))
    .slice(0, limit)
    .map(([tool, score]) => ({ namespacedName: index.tools[tool]!.namespacedName, score, exact: exact.has(tool) }));
  return { mode: "keywords", matches, unknownNames: [], candidateCount };
}
