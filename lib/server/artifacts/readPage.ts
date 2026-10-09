import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ARTIFACT_LIMITS, normalizedArtifactPath } from "@/lib/contracts/artifacts";
import { getAuthConfig } from "../auth/config";
import type { ArtifactBundle } from "./bundle";
import { ArtifactToolError } from "./errors";

type Fragment = { path: string; mimeType: string; bytes: number; offset: number; text?: string; binary?: true; length?: number; note?: string };
type Match = { index: number; path: string; offset: number; context_offset: number; context: string };
const KIB = 1024;
const invalid = (): never => { throw new ArtifactToolError("artifact_read_cursor_invalid", { hint: "Use the unchanged next_cursor with the same artifact and paths from the previous read_artifact result." }); };
const lowSurrogate = (text: string, index: number) => { const code = text.charCodeAt(index); return code >= 0xdc00 && code <= 0xdfff; };
/**
 * Text over the authored limit was supplied by reference (a page, an unpacked
 * site, an edited blob) and may be 24 MiB of mostly embedded data: its pages
 * stay small so one read cannot fill a model's context window.
 */
const largeNote = (bytes: number, length: number) => `Large file supplied by reference: ${bytes} bytes, ${length} UTF-16 characters in total. ` +
  `Pages of files over ${ARTIFACT_LIMITS.maxTextFileBytes / KIB} KiB hold at most ${ARTIFACT_LIMITS.maxLargeReadBytes / KIB} KiB. Do not read it whole: ` +
  "find text with query, and change it with create_artifact edits using a short distinctive old_string.";

export function artifactReadPage(input: { artifactId: string; versionId: string; ownerUserId: string; bundle: ArtifactBundle; args: Record<string, unknown>; secret?: string; maxBytes?: number }) {
  const maxBytes = Math.min(ARTIFACT_LIMITS.maxReadBytes, input.maxBytes ?? ARTIFACT_LIMITS.maxReadBytes);
  if (Object.keys(input.args).some(key => !["artifact_id", "paths", "cursor", "query"].includes(key))) invalid();
  const query = input.args.query;
  if (query !== undefined && (typeof query !== "string" || !query.length || query.length > ARTIFACT_LIMITS.maxReadQueryLength || /\p{Cs}/u.test(query))) {
    throw new ArtifactToolError("artifact_read_query_invalid", { hint: `query must be literal text of 1 to ${ARTIFACT_LIMITS.maxReadQueryLength} characters, matched case-sensitively.` });
  }
  const paths = input.args.paths;
  if (paths !== undefined && (!Array.isArray(paths) || !paths.length || paths.length > ARTIFACT_LIMITS.maxFiles || paths.some(path => normalizedArtifactPath(path) !== path))) invalid();
  const selected = paths as string[] | undefined;
  if (selected && (new Set(selected).size !== selected.length || selected.some(path => !input.bundle.files.some(file => file.path === path)))) invalid();
  const files = input.bundle.files.filter(file => !selected || selected.includes(file.path));
  const identity = createHash("sha256").update(JSON.stringify([input.ownerUserId, input.artifactId, input.versionId, files.map(file => file.path)])).digest("hex");
  const secret = input.secret ?? getAuthConfig().sessionSecret;
  if (!secret) throw new Error("artifact_read_unavailable");
  const sign = (body: string) => createHmac("sha256", secret).update(`aiqsa:artifact-read:v1\0${body}`).digest("base64url");
  const cursor = (index: number, offset: number) => {
    const body = Buffer.from(JSON.stringify({ identity, index, offset })).toString("base64url");
    return `${body}.${sign(body)}`;
  };
  let index = 0;
  let offset = 0;
  const receivedCursor = input.args.cursor;
  if (receivedCursor !== undefined && receivedCursor !== null) {
    if (typeof receivedCursor !== "string" || receivedCursor.length > 1024) return invalid();
    const parts = receivedCursor.split(".");
    const body = parts[0]!;
    const supplied = Buffer.from(parts[1] ?? "");
    const expected = Buffer.from(sign(body));
    if (parts.length !== 2 || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) invalid();
    let value: unknown;
    try { value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { invalid(); }
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
    const decoded = value as Record<string, unknown>;
    if (decoded.identity !== identity || !Number.isSafeInteger(decoded.index) || Number(decoded.index) < 0 || Number(decoded.index) >= files.length ||
      !Number.isSafeInteger(decoded.offset) || Number(decoded.offset) < 0) invalid();
    index = Number(decoded.index); offset = Number(decoded.offset);
    const text = files[index]!.text;
    if (offset > (text?.length ?? 0) || text && offset > 0 && lowSurrogate(text, offset)) invalid();
  }
  if (typeof query === "string") return queryPage(index, offset, query);
  const fragments: Fragment[] = [];
  const result = (nextIndex: number, nextOffset: number) => ({ artifact_id: input.artifactId, version_id: input.versionId, files: fragments,
    truncated: nextIndex < files.length, ...(nextIndex < files.length ? { next_cursor: cursor(nextIndex, nextOffset) } : {}) });
  while (index < files.length) {
    const file = files[index]!;
    const bytes = file.text !== undefined ? Buffer.byteLength(file.text) : file.byteSize ?? Buffer.from(file.base64 ?? "", "base64").byteLength;
    const large = file.text !== undefined && bytes > ARTIFACT_LIMITS.maxTextFileBytes;
    const fragment: Fragment = { path: file.path, mimeType: file.mimeType, bytes, offset,
      ...(file.text === undefined ? { binary: true as const } : { text: "" }),
      ...(large ? { length: file.text!.length, note: largeNote(bytes, file.text!.length) } : {}) };
    fragments.push(fragment);
    if (Buffer.byteLength(JSON.stringify(result(index, offset))) > maxBytes) { fragments.pop(); break; }
    if (file.text === undefined) { index++; offset = 0; continue; }
    const textBudget = large ? ARTIFACT_LIMITS.maxLargeReadBytes : maxBytes;
    // Every UTF-16 code unit serializes to at least one byte, so the budget also bounds the search.
    let low = offset;
    let high = Math.min(file.text.length, offset + textBudget);
    while (low < high) {
      const end = Math.ceil((low + high) / 2);
      fragment.text = file.text.slice(offset, end);
      if (Buffer.byteLength(JSON.stringify(result(index, end))) <= maxBytes && (!large || Buffer.byteLength(JSON.stringify(fragment.text)) <= textBudget)) low = end;
      else high = end - 1;
    }
    if (low < file.text.length && low > offset && lowSurrogate(file.text, low)) low--;
    fragment.text = file.text.slice(offset, low);
    if (low < file.text.length) { if (low === offset) fragments.pop(); offset = low; break; }
    index++; offset = 0;
    // A page carries at most one large-file page, even when that file just ended.
    if (large) break;
  }
  if (!fragments.length && index < files.length) throw new Error("artifact_read_page_too_large");
  return result(index, offset);

  /** Literal occurrences from the cursor position on, each with context and a cursor that reads from the context start. */
  function queryPage(fromIndex: number, fromOffset: number, needle: string) {
    const matches: Match[] = [];
    let next: { index: number; offset: number } | undefined;
    for (let fileIndex = fromIndex, from = fromOffset; fileIndex < files.length && !next; fileIndex++, from = 0) {
      const text = files[fileIndex]!.text;
      if (text === undefined) continue;
      for (let at = text.indexOf(needle, from); at >= 0; at = text.indexOf(needle, at + needle.length)) {
        if (matches.length === ARTIFACT_LIMITS.maxReadQueryMatches) { next = { index: fileIndex, offset: at }; break; }
        let start = Math.max(0, at - ARTIFACT_LIMITS.readQueryContextChars);
        if (start > 0 && lowSurrogate(text, start)) start--;
        let end = Math.min(text.length, at + needle.length + ARTIFACT_LIMITS.readQueryContextChars);
        if (end < text.length && lowSurrogate(text, end)) end++;
        matches.push({ index: fileIndex, path: files[fileIndex]!.path, offset: at, context_offset: start, context: text.slice(start, end) });
      }
    }
    const page = () => ({ artifact_id: input.artifactId, version_id: input.versionId, query: needle,
      matches: matches.map(({ index: fileIndex, ...match }) => ({ ...match, cursor: cursor(fileIndex, match.context_offset) })),
      truncated: next !== undefined, ...(next ? { next_cursor: cursor(next.index, next.offset) } : {}) });
    // A small tool-result budget keeps fewer occurrences; the cursor resumes at the first one left out.
    while (matches.length && Buffer.byteLength(JSON.stringify(page())) > maxBytes) {
      const dropped = matches.pop()!;
      next = { index: dropped.index, offset: dropped.offset };
    }
    if (!matches.length && next) throw new Error("artifact_read_page_too_large");
    return page();
  }
}
