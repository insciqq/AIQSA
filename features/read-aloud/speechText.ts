import {
  parseMarkdown,
  type MarkdownBlock,
  type MarkdownInline
} from "@/components/chat/markdownParser";

/**
 * Pure helpers that turn an answer's Markdown into what the browser's speech
 * synthesis reads: prose as sentences, non-prose blocks as one short spoken
 * placeholder, links as their text, citations dropped. The input is only the
 * answer body; the process disclosure and status lines never belong to it.
 */

/** Chrome silently stops an utterance after roughly fifteen seconds of speech. */
export const MAX_UTTERANCE_CHARACTERS = 220;

type Placeholder = "code" | "formula" | "image" | "table";
type Segment = Readonly<{ kind: "text"; value: string }> | Readonly<{ kind: "placeholder"; value: Placeholder }>;

const PLACEHOLDERS: Readonly<Record<"en" | "ru", Readonly<Record<Placeholder, string>>>> = {
  en: {
    code: "code block skipped",
    formula: "formula skipped",
    image: "image skipped",
    table: "table skipped"
  },
  ru: {
    code: "блок кода пропущен",
    formula: "формула пропущена",
    image: "изображение пропущено",
    table: "таблица пропущена"
  }
};

const URL_PATTERN = /\bhttps?:\/\/[^\s<>()]+/giu;
/** `[1]`, `1`, `^1`: a numbered source marker read as noise. */
const NUMBERED_MARKER = /^\s*[[(^]?\d{1,3}[\])]?\s*$/u;
const SENTENCE_END = /[.!?…:;]["'»”)\]]*$/u;

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return "";
  }
}

function speakableText(value: string): string {
  return value.replace(URL_PATTERN, (url) => hostnameOf(url));
}

function inlineSegments(nodes: readonly MarkdownInline[], out: Segment[]): void {
  const pushText = (value: string) => {
    if (value) out.push({ kind: "text", value });
  };
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        pushText(speakableText(node.value));
        break;
      case "break":
        pushText(" ");
        break;
      case "inlineCode":
        pushText(node.value);
        break;
      case "inlineMath":
        // Short inline formulas read as their symbols; TeX markup is noise.
        pushText(node.source.replace(/\\[a-z]+|[\\{}$^_]/giu, " "));
        break;
      case "citation":
        break;
      case "strong":
      case "emphasis":
      case "delete":
        inlineSegments(node.children, out);
        break;
      case "link": {
        // Image syntax is disabled in the chat dialect: `![alt](url)` arrives
        // as a trailing "!" followed by a link.
        const previous = out.at(-1);
        if (previous?.kind === "text" && previous.value.endsWith("!")) {
          out[out.length - 1] = { kind: "text", value: previous.value.slice(0, -1) };
          out.push({ kind: "placeholder", value: "image" });
          break;
        }
        const label: Segment[] = [];
        inlineSegments(node.children, label);
        const text = label.map((segment) => segment.kind === "text" ? segment.value : "").join("");
        if (NUMBERED_MARKER.test(text)) break;
        pushText(text.trim() === node.url ? hostnameOf(node.url) : text);
        break;
      }
    }
  }
}

function sentence(nodes: readonly MarkdownInline[], out: Segment[][]): void {
  const segments: Segment[] = [];
  inlineSegments(nodes, segments);
  if (segments.length) out.push(segments);
}

function blockSegments(blocks: readonly MarkdownBlock[], out: Segment[][]): void {
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
      case "heading":
        sentence(block.children, out);
        break;
      case "blockquote":
        blockSegments(block.children, out);
        break;
      case "list":
        for (const item of block.items) blockSegments(item, out);
        break;
      case "code":
        out.push([{ kind: "placeholder", value: "code" }]);
        break;
      case "math":
        out.push([{ kind: "placeholder", value: "formula" }]);
        break;
      case "table":
        out.push([{ kind: "placeholder", value: "table" }]);
        break;
      case "literal":
        out.push([{ kind: "text", value: speakableText(block.value) }]);
        break;
      case "thematicBreak":
        break;
    }
  }
}

/** Fenced code stays out of the fallback text, even without the parser. */
function fallbackSegments(markdown: string): Segment[][] {
  const lines: Segment[][] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/u.test(line)) {
      if (!inFence) lines.push([{ kind: "placeholder", value: "code" }]);
      inFence = !inFence;
      continue;
    }
    if (!inFence && line.trim()) lines.push([{ kind: "text", value: speakableText(line) }]);
  }
  return lines;
}

function capitalize(value: string): string {
  return value.charAt(0).toLocaleUpperCase() + value.slice(1);
}

/** Collapses whitespace and the empty brackets a dropped citation leaves. */
function normalizeSpace(value: string): string {
  return value.replace(/\[\s*\]|\(\s*\)/gu, " ").replace(/\s+/gu, " ").replace(/\s+([,.;:!?])/gu, "$1").trim();
}

/** BCP 47 tag of the dominant script: Cyrillic reads as Russian, the rest uses the fallback. */
export function detectSpeechLanguage(text: string, fallback: string): string {
  const cyrillic = text.match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  return cyrillic > latin ? "ru-RU" : fallback;
}

/**
 * The document language, refined by the browser's own regional variant of it
 * (`en` + `en-GB` → `en-GB`), or the browser language when the page has none.
 */
export function resolveFallbackLanguage(
  documentLanguage: string | null | undefined,
  browserLanguages: readonly string[]
): string {
  const page = documentLanguage?.trim();
  if (!page) return browserLanguages.find((language) => language.trim())?.trim() ?? "en-US";
  const primary = page.split("-")[0]!.toLowerCase();
  return browserLanguages.find((language) => language.toLowerCase().split("-")[0] === primary) ?? page;
}

export type AnswerSpeech = Readonly<{
  lang: string;
  /** One entry per block-level sentence group, each ending in punctuation. */
  sentences: readonly string[];
}>;

/** Speech text and language of one answer; empty `sentences` means nothing to read. */
export function answerSpeech(markdown: string, fallbackLanguage: string): AnswerSpeech {
  const parsed = parseMarkdown(markdown);
  const groups: Segment[][] = [];
  if (parsed) {
    blockSegments(parsed.blocks, groups);
    if (parsed.overflow) groups.push(...fallbackSegments(parsed.overflow));
  } else {
    groups.push(...fallbackSegments(markdown));
  }
  const prose = groups.flatMap((group) => group.flatMap((segment) => segment.kind === "text" ? [segment.value] : []));
  const lang = detectSpeechLanguage(prose.join(" "), fallbackLanguage);
  const placeholders = PLACEHOLDERS[lang.toLowerCase().startsWith("ru") ? "ru" : "en"];
  const sentences: string[] = [];
  for (const group of groups) {
    // A block placeholder is its own sentence; one inside a sentence ("see
    // ![chart](…) below") stays a parenthesized phrase of it.
    const text = group.length === 1 && group[0]!.kind === "placeholder"
      ? capitalize(placeholders[group[0]!.value])
      : normalizeSpace(group.map((segment) => segment.kind === "text"
        ? segment.value
        : ` (${placeholders[segment.value]}) `).join(""));
    if (!/[\p{L}\p{N}]/u.test(text)) continue;
    sentences.push(SENTENCE_END.test(text) ? text : `${text}.`);
  }
  return { lang, sentences };
}

function splitLong(sentence: string, limit: number): string[] {
  if (sentence.length <= limit) return [sentence];
  const parts: string[] = [];
  let rest = sentence;
  while (rest.length > limit) {
    const head = rest.slice(0, limit + 1);
    // Prefer a clause boundary, then a word boundary, then a hard cut.
    const clause = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "), head.lastIndexOf(" — "));
    const space = head.lastIndexOf(" ");
    const cut = clause > limit / 3 ? clause + 1 : space > limit / 3 ? space : limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Bounded utterance texts in reading order: sentences are packed together up
 * to `limit` characters, and a longer sentence splits at clauses or words.
 */
export function chunkSpeech(sentences: readonly string[], limit = MAX_UTTERANCE_CHARACTERS): string[] {
  const pieces = sentences.flatMap((group) =>
    group.split(/(?<=[.!?…])\s+/u).flatMap((part) => splitLong(part.trim(), limit))
  ).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + 1 + piece.length > limit) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current} ${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

type VoiceLike = Readonly<{ default?: boolean; lang: string; localService?: boolean }>;

function normalizeTag(tag: string): string {
  return tag.replace(/_/gu, "-").toLowerCase();
}

/**
 * A voice for `lang`: the exact tag first, then the same primary language;
 * the browser's default voice wins ties, then on-device voices. `null` leaves
 * the choice to the browser.
 */
export function pickVoice<V extends VoiceLike>(voices: readonly V[], lang: string): V | null {
  const wanted = normalizeTag(lang);
  const primary = wanted.split("-")[0];
  const rank = (voice: V) => (voice.default ? 2 : 0) + (voice.localService ? 1 : 0);
  const best = (candidates: V[]) => candidates.sort((left, right) => rank(right) - rank(left))[0] ?? null;
  return best(voices.filter((voice) => normalizeTag(voice.lang) === wanted)) ??
    best(voices.filter((voice) => normalizeTag(voice.lang).split("-")[0] === primary));
}
