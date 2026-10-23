/*
 * The `apply_patch` format: parsing and applying hunks to file text.
 *
 * A TypeScript reimplementation of the patch format and matching rules of
 * OpenAI Codex (https://github.com/openai/codex, codex-rs/apply-patch:
 * parser.rs, seek_sequence.rs, file_update.rs, and the grammar
 * codex-rs/core/assets/tools/apply_patch.lark; commit
 * 334527705c4a2d077efce577925247d87f10d2b1). Copyright 2025 OpenAI, Apache
 * License 2.0 (lib/server/engine/prompts/THIRD_PARTY_NOTICES.txt).
 *
 * Changes by AIQSA: error messages name the patch line and the expected form;
 * context lines keep the file's own text when matched loosely; an addition-only
 * hunk with an `@@` header is inserted after that header line instead of at the
 * end of the file; line endings follow the file (LF or CRLF).
 */

export const APPLY_PATCH_MARKERS = Object.freeze({
  add: "*** Add File: ",
  begin: "*** Begin Patch",
  delete: "*** Delete File: ",
  end: "*** End Patch",
  endOfFile: "*** End of File",
  move: "*** Move to: ",
  update: "*** Update File: "
});

/** Codex's grammar for the freeform (custom) form of the tool. */
export const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;

export class ApplyPatchError extends Error {
  override name = "ApplyPatchError";
  constructor(readonly code: "apply_patch_invalid" | "apply_patch_mismatch", message: string) {
    super(message);
  }
}

type ChunkOp = Readonly<{ kind: "add" | "context" | "remove"; text: string }>;

export type PatchChunk = Readonly<{
  /** Text after `@@ `, a line to find before the chunk's lines. */
  context?: string;
  endOfFile: boolean;
  /** 1-based line of the patch where the chunk starts. */
  line: number;
  ops: readonly ChunkOp[];
}>;

export type PatchHunk =
  | Readonly<{ kind: "add"; contents: string; line: number; path: string }>
  | Readonly<{ kind: "delete"; line: number; path: string }>
  | Readonly<{ chunks: readonly PatchChunk[]; kind: "update"; line: number; movePath?: string; path: string }>;

const HEREDOC_START = new Set(["<<EOF", "<<'EOF'", "<<\"EOF\""]);
const HUNK_HEADERS = `'${APPLY_PATCH_MARKERS.add}<path>', '${APPLY_PATCH_MARKERS.delete}<path>' or '${APPLY_PATCH_MARKERS.update}<path>'`;

function invalid(line: number, message: string): ApplyPatchError {
  return new ApplyPatchError("apply_patch_invalid", `Patch line ${line}: ${message}`);
}

function quoted(text: string): string {
  return JSON.stringify(text.length > 120 ? `${text.slice(0, 120)}…` : text);
}

/** Lines of the patch with their 1-based numbers, inside the begin/end markers. */
function patchBody(patch: string): { first: number; lines: string[] } {
  // Like Codex: trim the whole text, split into lines, drop a CR before LF.
  let lines = patch.trim().split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  let first = 1;
  const bounded = (candidate: string[]) => candidate.length >= 2 &&
    candidate[0]!.trim() === APPLY_PATCH_MARKERS.begin && candidate.at(-1)!.trim() === APPLY_PATCH_MARKERS.end;
  if (!bounded(lines) && lines.length >= 4 && HEREDOC_START.has(lines[0]!) && lines.at(-1)!.endsWith("EOF") &&
    bounded(lines.slice(1, -1))) {
    lines = lines.slice(1, -1);
    first = 2;
  }
  if (lines[0]?.trim() !== APPLY_PATCH_MARKERS.begin) {
    throw invalid(first, `the patch must start with '${APPLY_PATCH_MARKERS.begin}', found ${quoted(lines[0] ?? "")}.`);
  }
  if (lines.length < 2 || lines.at(-1)!.trim() !== APPLY_PATCH_MARKERS.end) {
    throw invalid(first + lines.length - 1, `the patch must end with '${APPLY_PATCH_MARKERS.end}' on its own line.`);
  }
  return { first: first + 1, lines: lines.slice(1, -1) };
}

function pathAfter(line: string, marker: string, number: number): string {
  const path = line.trim().slice(marker.trimEnd().length).trim();
  if (!path) throw invalid(number, `'${marker.trim()}' needs a file path after it.`);
  return path;
}

/**
 * Parses a patch strictly enough that every accepted hunk has one meaning.
 * Errors name the patch line, what was found and the expected form.
 */
export function parsePatch(patch: string): PatchHunk[] {
  const { first, lines } = patchBody(patch);
  const hunks: PatchHunk[] = [];
  let index = 0;
  while (index < lines.length) {
    const number = first + index;
    const header = lines[index]!.trim();
    if (!header) { index += 1; continue; }
    if (header.startsWith(APPLY_PATCH_MARKERS.add.trimEnd())) {
      const path = pathAfter(header, APPLY_PATCH_MARKERS.add, number);
      index += 1;
      let contents = "";
      while (index < lines.length && lines[index]!.startsWith("+")) {
        contents += `${lines[index]!.slice(1)}\n`;
        index += 1;
      }
      hunks.push({ contents, kind: "add", line: number, path });
      continue;
    }
    if (header.startsWith(APPLY_PATCH_MARKERS.delete.trimEnd())) {
      hunks.push({ kind: "delete", line: number, path: pathAfter(header, APPLY_PATCH_MARKERS.delete, number) });
      index += 1;
      continue;
    }
    if (header.startsWith(APPLY_PATCH_MARKERS.update.trimEnd())) {
      const path = pathAfter(header, APPLY_PATCH_MARKERS.update, number);
      index += 1;
      let movePath: string | undefined;
      if (index < lines.length && lines[index]!.trim().startsWith(APPLY_PATCH_MARKERS.move.trimEnd())) {
        movePath = pathAfter(lines[index]!, APPLY_PATCH_MARKERS.move, first + index);
        index += 1;
      }
      const chunks: PatchChunk[] = [];
      while (index < lines.length) {
        if (!lines[index]!.trim()) { index += 1; continue; }
        if (lines[index]!.startsWith("***")) break;
        const parsed = parseChunk(lines, index, first, chunks.length === 0);
        chunks.push(parsed.chunk);
        index = parsed.next;
      }
      if (!chunks.length && !movePath) {
        throw invalid(number, `'${APPLY_PATCH_MARKERS.update}${path}' has no changes. Add a hunk ('@@' then lines starting with ' ', '-' or '+'), or remove the section.`);
      }
      hunks.push({ chunks, kind: "update", line: number, ...(movePath ? { movePath } : {}), path });
      continue;
    }
    throw invalid(number, `${quoted(header)} is not a valid file header. Expected ${HUNK_HEADERS}.`);
  }
  if (!hunks.length) throw invalid(first, `the patch has no file sections. Expected ${HUNK_HEADERS}.`);
  return hunks;
}

function parseChunk(lines: readonly string[], start: number, first: number, allowMissingContext: boolean): { chunk: PatchChunk; next: number } {
  const number = first + start;
  const head = lines[start]!;
  let index = start;
  let context: string | undefined;
  if (head === "@@") index += 1;
  else if (head.startsWith("@@ ")) { context = head.slice(3); index += 1; }
  else if (!allowMissingContext) {
    throw invalid(number, `expected a hunk starting with '@@' (optionally '@@ <line to find>'), found ${quoted(head)}.`);
  }
  const ops: ChunkOp[] = [];
  let endOfFile = false;
  for (; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line === APPLY_PATCH_MARKERS.endOfFile) {
      if (!ops.length) break;
      endOfFile = true;
      index += 1;
      break;
    }
    const sign = line[0];
    if (sign === undefined) ops.push({ kind: "context", text: "" });
    else if (sign === " ") ops.push({ kind: "context", text: line.slice(1) });
    else if (sign === "+") ops.push({ kind: "add", text: line.slice(1) });
    else if (sign === "-") ops.push({ kind: "remove", text: line.slice(1) });
    else if (!ops.length) {
      throw invalid(first + index, `unexpected line ${quoted(line)} in a hunk. Every hunk line starts with ' ' (unchanged context), '-' (removed) or '+' (added).`);
    } else break;
  }
  if (!ops.length) throw invalid(number, "the hunk has no lines. Add lines starting with ' ', '-' or '+' after '@@'.");
  return { chunk: { ...(context !== undefined ? { context } : {}), endOfFile, line: number, ops }, next: index };
}

const PUNCTUATION: Readonly<Record<string, string>> = Object.fromEntries([
  ...["‐", "‑", "‒", "–", "—", "―", "−"].map((c) => [c, "-"]),
  ...["‘", "’", "‚", "‛"].map((c) => [c, "'"]),
  ...["“", "”", "„", "‟"].map((c) => [c, "\""]),
  ...[" ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", "　"].map((c) => [c, " "])
]);

function normalise(line: string): string {
  let result = "";
  for (const char of line.trim()) result += PUNCTUATION[char] ?? char;
  return result;
}

const COMPARISONS: readonly ((line: string) => string)[] = [
  (line) => line,
  (line) => line.trimEnd(),
  (line) => line.trim(),
  normalise
];

/** Codex's `seek_sequence`: exact, then ignoring trailing, then surrounding whitespace, then Unicode punctuation. */
function seekSequence(lines: readonly string[], pattern: readonly string[], start: number, endOfFile: boolean): number | null {
  if (!pattern.length) return start;
  if (pattern.length > lines.length) return null;
  const last = lines.length - pattern.length;
  const from = endOfFile ? Math.max(last, start) : start;
  for (const compare of COMPARISONS) {
    for (let index = from; index <= last; index += 1) {
      let matched = true;
      for (let offset = 0; offset < pattern.length; offset += 1) {
        if (compare(lines[index + offset]!) !== compare(pattern[offset]!)) { matched = false; break; }
      }
      if (matched) return index;
    }
  }
  return null;
}

type Replacement = Readonly<{ count: number; lines: readonly string[]; start: number }>;

/**
 * The file's new text after an update's chunks. Chunks apply in order, each
 * searched after the previous one; a chunk that cannot be found fails the
 * whole update with the lines that did not match.
 */
export function applyChunks(original: string, chunks: readonly PatchChunk[], path: string): string {
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  const replacements: Replacement[] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    let anchor: number | null = null;
    if (chunk.context !== undefined) {
      anchor = seekSequence(lines, [chunk.context], cursor, false);
      if (anchor === null) {
        throw new ApplyPatchError("apply_patch_mismatch",
          `${path}: the '@@ ${chunk.context}' line of the hunk at patch line ${chunk.line} was not found${cursor ? ` after file line ${cursor}` : ""}. Copy that line exactly from the current file, or read the file again.`);
      }
      cursor = anchor + 1;
    }
    let ops = chunk.ops;
    const old = () => ops.filter((op) => op.kind !== "add").map((op) => op.text);
    if (!old().length) {
      // Pure addition: after the `@@` line when one is given, otherwise at the end.
      const at = anchor === null ? lines.length : anchor + 1;
      replacements.push({ count: 0, lines: ops.map((op) => op.text), start: at });
      cursor = Math.max(cursor, at);
      continue;
    }
    let found = seekSequence(lines, old(), cursor, chunk.endOfFile);
    if (found === null && ops.at(-1)?.kind === "context" && ops.at(-1)!.text === "") {
      // A trailing blank context line often stands for the end of the file.
      ops = ops.slice(0, -1);
      found = seekSequence(lines, old(), cursor, chunk.endOfFile);
    }
    if (found === null) {
      const expected = chunk.ops.filter((op) => op.kind !== "add").map((op) => op.text).join("\n");
      throw new ApplyPatchError("apply_patch_mismatch",
        `${path}: the context and removed lines of the hunk at patch line ${chunk.line} were not found${cursor ? ` after file line ${cursor}` : ""}${chunk.endOfFile ? " at the end of the file" : ""}. Expected these lines:\n${expected}\nRead the file again and copy these lines exactly as they are now.`);
    }
    const next: string[] = [];
    let offset = 0;
    for (const op of ops) {
      if (op.kind === "add") next.push(op.text);
      else {
        // Context keeps the file's own text, even when it matched loosely.
        if (op.kind === "context") next.push(lines[found + offset]!);
        offset += 1;
      }
    }
    replacements.push({ count: offset, lines: next, start: found });
    cursor = found + offset;
  }
  const ordered = replacements.map((replacement, order) => ({ ...replacement, order }))
    .sort((left, right) => left.start - right.start || left.order - right.order);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    if (ordered[index]!.start < previous.start + previous.count) {
      throw new ApplyPatchError("apply_patch_mismatch", `${path}: two hunks change overlapping lines. Merge them into one hunk.`);
    }
  }
  for (const replacement of ordered.reverse()) lines.splice(replacement.start, replacement.count, ...replacement.lines);
  return lines.length ? `${lines.join(eol)}${eol}` : "";
}
