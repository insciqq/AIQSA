import { notImportedNote, appendNotes, type ImportSkipKind } from "./converterTypes";

/**
 * Message text of a ChatGPT export: text parts, transcriptions, legacy code
 * and execution output, with citation markers resolved into Markdown links
 * and every media part reduced to a counted "not imported" note.
 */
export type SkipCounts = Partial<Record<ImportSkipKind, number>>;

export type ChatGptMessageText = Readonly<{ role: "assistant" | "user"; text: string }>;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(counts: SkipCounts, kind: ImportSkipKind, amount = 1): void {
  if (amount > 0) counts[kind] = (counts[kind] ?? 0) + amount;
}

/** ChatGPT's citation and entity markers live in this private-use block. */
const PRIVATE_USE = /[\ue200-\ue2ff]/u;
const PRIVATE_USE_ALL = /[\ue200-\ue2ff]/gu;
/** A whole marker: start U+E200, payload, end U+E201 (fields split by U+E202). */
const MARKER = /\ue200([^\ue200\ue201]{0,4096})\ue201/gu;
const LEGACY_MARKER = /^【[^【】]{0,256}】$/u;

/** Hidden reasoning and custom-instruction context: not conversation text, never counted. */
const SILENT_CONTENT_TYPES = new Set([
  "model_editable_context",
  "reasoning_recap",
  "thoughts",
  "user_editable_context"
]);
const LINK_REFERENCE_TYPES = new Set([
  "grouped_webpages",
  "grouped_webpages_model_predicted_fallback",
  "nav_list",
  "product",
  "products",
  "url",
  "webpage",
  "webpage_extended"
]);
const MAX_LINKS_PER_REFERENCE = 10;
const LABEL_MAX_LENGTH = 200;

function oneLine(value: string): string {
  return value.replace(PRIVATE_USE_ALL, "").replace(/[\u0000-\u001f\u007f\s]+/gu, " ").trim();
}

function boundedLabel(value: string): string {
  const points = Array.from(oneLine(value));
  return points.length > LABEL_MAX_LENGTH ? `${points.slice(0, LABEL_MAX_LENGTH - 1).join("")}…` : points.join("");
}

/** Plain text that renders literally inside Markdown. */
function markdownText(value: string): string {
  return boundedLabel(value).replace(/[\\`*_[\]<>#|~]/gu, (character) => `\\${character}`);
}

function httpUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 4_096) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

type Link = Readonly<{ label: string; url: URL }>;

function markdownLink(link: Link): string {
  const href = link.url.href.replace(/[()]/gu, (character) => (character === "(" ? "%28" : "%29"));
  return `[${markdownText(link.label) || markdownText(link.url.hostname)}](${href})`;
}

function stringField(record: JsonRecord, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/** A reference item as a link: title, else site name, else host. */
function itemLink(item: unknown): Link | null {
  if (!isRecord(item)) return null;
  const url = httpUrl(item.url);
  if (!url) return null;
  return { label: stringField(item, "title", "attribution", "name") ?? url.hostname, url };
}

/** The links a web, navigation or product reference points to, deduplicated and bounded. */
function referenceLinks(reference: JsonRecord): Link[] {
  const links: Link[] = [];
  const own = itemLink(reference);
  if (own) links.push(own);
  for (const key of ["items", "sources", "products"]) {
    const items = reference[key];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const link = itemLink(item);
      if (link) links.push(link);
    }
  }
  if (links.length === 0 && Array.isArray(reference.safe_urls)) {
    for (const value of reference.safe_urls) {
      const url = httpUrl(value);
      if (url) links.push({ label: url.hostname, url });
    }
  }
  const seen = new Set<string>();
  return links.filter((link) => !seen.has(link.url.href) && Boolean(seen.add(link.url.href))).slice(0, MAX_LINKS_PER_REFERENCE);
}

/** The display name inside an entity marker payload: `entity` U+E202 `["kind","Name",...]`. */
function entityName(payload: string): string | undefined {
  const [kind, data] = payload.split("\ue202");
  if (kind !== "entity" || data === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(data);
    return Array.isArray(value) && typeof value[1] === "string" && value[1].trim() ? value[1] : undefined;
  } catch {
    return undefined;
  }
}

/** What replaces an inline reference's marker: links, an entity's name, a file name, or nothing. */
function referenceReplacement(reference: JsonRecord, matched: string): string {
  const type = reference.type;
  if (typeof type === "string" && LINK_REFERENCE_TYPES.has(type)) {
    const links = referenceLinks(reference);
    return links.length ? `(${links.map(markdownLink).join(", ")})` : "";
  }
  if (type === "entity") {
    const payload = /\ue200([^\ue200\ue201]*)\ue201/u.exec(matched)?.[1];
    const name = stringField(reference, "name", "alt") ?? (payload === undefined ? undefined : entityName(payload));
    return name ? markdownText(name) : "";
  }
  if (type === "file") {
    const name = stringField(reference, "name", "title");
    return name ? `(${markdownText(name)})` : "";
  }
  // hidden, image_inline, sources_footnote markers and unknown types.
  return "";
}

type Span = Readonly<{ start: number; end: number; replacement: string }>;

/**
 * Replaces non-overlapping spans in order. A removed marker takes the space
 * before it when punctuation or the line end follows; inserted links are
 * separated from the preceding word.
 */
function replaceSpans(text: string, spans: readonly Span[]): string {
  const pieces: string[] = [];
  let last = "";
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue;
    let before = text.slice(cursor, span.start);
    let replacement = span.replacement;
    const next = text.charAt(span.end);
    const preceding = before ? before.slice(-1) : last;
    if (!replacement) {
      if (/[ \t]$/u.test(before) && (next === "" || /[\s.,;:!?)\]]/u.test(next))) before = before.replace(/[ \t]+$/u, "");
    } else if (preceding && !/[\s([]/u.test(preceding)) {
      replacement = ` ${replacement}`;
    }
    pieces.push(before, replacement);
    const joined = before + replacement;
    if (joined) last = joined.slice(-1);
    cursor = span.end;
  }
  pieces.push(text.slice(cursor));
  return pieces.join("");
}

/**
 * Resolves the private-use citation markers through `content_references`
 * (matched in order of their position), then removes whatever marker is
 * left: an unreferenced entity keeps its name, anything else disappears,
 * and no private-use character survives. Footnote references append a
 * sources list.
 */
export function resolveCitations(text: string, references: unknown): string {
  const list = Array.isArray(references) ? references.filter(isRecord) : [];
  const inline = list
    .map((reference, index) => ({ index, reference }))
    .filter(({ reference }) => typeof reference.matched_text === "string" && PRIVATE_USE.test(reference.matched_text))
    .sort((left, right) => {
      const leftStart = typeof left.reference.start_idx === "number" ? left.reference.start_idx : Number.MAX_SAFE_INTEGER;
      const rightStart = typeof right.reference.start_idx === "number" ? right.reference.start_idx : Number.MAX_SAFE_INTEGER;
      return leftStart - rightStart || left.index - right.index;
    });
  const spans: Span[] = [];
  let cursor = 0;
  for (const { reference } of inline) {
    const matched = reference.matched_text as string;
    const start = text.indexOf(matched, cursor);
    if (start < 0) continue;
    spans.push({ end: start + matched.length, replacement: referenceReplacement(reference, matched), start });
    cursor = start + matched.length;
  }
  let resolved = replaceSpans(text, spans);
  const leftovers: Span[] = [];
  for (const match of resolved.matchAll(MARKER)) {
    const name = entityName(match[1] ?? "");
    leftovers.push({ end: match.index + match[0].length, replacement: name ? markdownText(name) : "", start: match.index });
  }
  resolved = replaceSpans(resolved, leftovers).replace(PRIVATE_USE_ALL, "");

  const footnote: Link[] = [];
  for (const reference of list) {
    if (reference.type === "sources_footnote") footnote.push(...referenceLinks(reference));
  }
  const seen = new Set<string>();
  const sources = footnote.filter((link) => !seen.has(link.url.href) && Boolean(seen.add(link.url.href)));
  if (sources.length === 0) return resolved;
  const body = resolved.trimEnd();
  const block = `Sources:\n${sources.map((link) => `- ${markdownLink(link)}`).join("\n")}`;
  return body ? `${body}\n\n${block}` : block;
}

/** Legacy browsing citations: `【n†source】` spans located by `start_ix`/`end_ix`. */
export function resolveLegacyCitations(text: string, citations: unknown): string {
  if (!Array.isArray(citations)) return text;
  const points = Array.from(text);
  const spans: Span[] = [];
  for (const citation of citations) {
    if (!isRecord(citation) || !Number.isSafeInteger(citation.start_ix) || !Number.isSafeInteger(citation.end_ix)) continue;
    const start = citation.start_ix as number;
    const end = citation.end_ix as number;
    const metadata = isRecord(citation.metadata) ? citation.metadata : {};
    const link = itemLink(metadata);
    const replacement = link ? `(${markdownLink(link)})` : "";
    if (LEGACY_MARKER.test(text.slice(start, end))) {
      spans.push({ end, replacement, start });
    } else if (LEGACY_MARKER.test(points.slice(start, end).join(""))) {
      // Indices counted in code points: convert to string offsets.
      const offset = points.slice(0, start).join("").length;
      spans.push({ end: offset + points.slice(start, end).join("").length, replacement, start: offset });
    }
  }
  spans.sort((left, right) => left.start - right.start);
  return replaceSpans(text, spans);
}

function fenced(code: string, language: unknown): string {
  const longest = Math.max(2, ...Array.from(code.matchAll(/`+/gu), (match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  const label = typeof language === "string" && /^[A-Za-z0-9_+.#-]{1,32}$/u.test(language) && language !== "unknown" ? language : "";
  return `${fence}${label}\n${code.replace(/\n+$/u, "")}\n${fence}`;
}

function quoted(output: string): string {
  return output.replace(/\n+$/u, "").split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
}

type MediaKind = "attachment" | "audio" | "image";

function mediaKind(contentType: string): MediaKind {
  if (contentType.includes("image")) return "image";
  if (contentType.includes("audio") || contentType.includes("video")) return "audio";
  return "attachment";
}

/** The file id an asset pointer names (`file-service://file-x`, `sediment://file_x`). */
function assetId(part: JsonRecord): string | undefined {
  const pointer = part.asset_pointer;
  if (typeof pointer !== "string") return undefined;
  const id = pointer.slice(pointer.lastIndexOf("/") + 1);
  return id || undefined;
}

type Parts = { texts: string[]; media: Record<MediaKind, number>; assetIds: Set<string> };

/** String parts, transcriptions and other text-bearing parts; media parts are only counted. */
function readParts(parts: unknown): Parts {
  const result: Parts = { assetIds: new Set(), media: { attachment: 0, audio: 0, image: 0 }, texts: [] };
  if (!Array.isArray(parts)) return result;
  for (const part of parts) {
    if (typeof part === "string") {
      if (part.trim()) result.texts.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    const type = typeof part.content_type === "string" ? part.content_type : "";
    if (typeof part.text === "string" && !type.endsWith("asset_pointer")) {
      if (part.text.trim()) result.texts.push(part.text);
      continue;
    }
    result.media[mediaKind(type)] += 1;
    const id = assetId(part);
    if (id) result.assetIds.add(id);
  }
  return result;
}

function mediaNote(amount: number, one: string, many: string): string {
  return notImportedNote(amount === 1 ? one : `${amount} ${many}`);
}

const PYTHON_RECIPIENT = /^(?:python|jupyter)\b/u;

/**
 * The importable text of one ChatGPT message, or null for a message that is
 * skipped: system and hidden messages, reasoning, custom instructions, tool
 * traffic (calls, browsing results, errors) and messages without text or
 * notes. Tool output the user saw stays as answer text: execution output as
 * a quote and generated images or audio as notes.
 */
export function chatGptMessageText(message: unknown, counts: SkipCounts): ChatGptMessageText | null {
  if (!isRecord(message)) return null;
  const metadata = isRecord(message.metadata) ? message.metadata : {};
  if (metadata.is_visually_hidden_from_conversation === true) return null;
  const author = isRecord(message.author) ? message.author : {};
  const role = author.role;
  const content = isRecord(message.content) ? message.content : {};
  const type = typeof content.content_type === "string" ? content.content_type : "";
  if (role !== "user" && role !== "assistant" && role !== "tool") return null;
  if (SILENT_CONTENT_TYPES.has(type)) return null;
  // An assistant message addressed to a tool is a call; only code for the interpreter is shown.
  const toTool = role === "assistant" && typeof message.recipient === "string" && message.recipient !== "all";

  let body = "";
  let parts: Parts = readParts([]);
  if (type === "execution_output") {
    body = typeof content.text === "string" && content.text.trim() ? quoted(content.text) : "";
  } else if (type === "code" && role === "assistant") {
    if (toTool && !PYTHON_RECIPIENT.test(message.recipient as string)) return null;
    body = typeof content.text === "string" && content.text.trim() ? fenced(content.text, content.language) : "";
  } else if (type === "multimodal_text" && role === "tool") {
    // Generated media: the notes stand for it; tool text parts are not conversation text.
    parts = { ...readParts(content.parts), texts: [] };
    if (parts.media.image + parts.media.audio === 0) return null;
  } else if ((type === "text" || type === "multimodal_text") && role !== "tool" && !toTool) {
    parts = readParts(content.parts);
    body = resolveLegacyCitations(resolveCitations(parts.texts.join("\n\n"), metadata.content_references), metadata.citations);
  } else {
    return null;
  }

  const notes: string[] = [];
  if (parts.media.image) notes.push(mediaNote(parts.media.image, "Image", "images"));
  if (parts.media.audio) notes.push(mediaNote(parts.media.audio, "Audio recording", "audio recordings"));
  const files = (Array.isArray(metadata.attachments) ? metadata.attachments : [])
    .filter(isRecord)
    .filter((attachment) => typeof attachment.id !== "string" || !parts.assetIds.has(attachment.id));
  const attachments = parts.media.attachment + files.length;
  if (attachments) {
    const names = files.map((file) => stringField(file, "name")).filter((name): name is string => Boolean(name));
    notes.push(notImportedNote(attachments === 1 ? "Attachment" : "Attachments", names));
  }
  count(counts, "image", parts.media.image);
  count(counts, "audio", parts.media.audio);
  count(counts, "attachment", attachments);

  const text = appendNotes(body, notes).replace(PRIVATE_USE_ALL, "");
  if (!text.trim()) return null;
  return { role: role === "user" ? "user" : "assistant", text };
}
