import {
  MEMORY_NOTE_MAX_CHARACTERS,
  memoryNoteCharacterCount,
  memoryNotePassageSchema,
  type MemoryNoteOperation
} from "@/lib/contracts/memoryNote";

/**
 * The agent's operations on the memory note, and an accepted offer's (`manage_memory`, operator decision 2026-11-22):
 * append a line or section, replace an exact passage, or remove one. Pure, so the agent's change, the offer it records
 * and the acceptance that applies it later all run the same rules on the text they read under the owner lock. A note
 * over its limit is refused with the size it would reach, never truncated: the agent condenses it or asks the user.
 */

export type MemoryNoteEdit =
  /** Appends `text`, trimmed, as a new line at the end. */
  | Readonly<{ kind: "add"; text: string }>
  /** Replaces the one occurrence of `find` with `text`, literally. */
  | Readonly<{ kind: "replace"; find: string; text: string }>
  /** Removes the one occurrence of `find`; a passage that is a whole line takes its line break with it. */
  | Readonly<{ kind: "remove"; find: string }>;

export type MemoryNoteEditRefusal =
  /** The passage is not in the note as it is now. */
  | Readonly<{ code: "memory_note_passage_not_found" }>
  | Readonly<{ code: "memory_note_passage_ambiguous"; occurrences: number }>
  | Readonly<{ code: "memory_note_unchanged" }>
  /** The note would be `characters` long, over `MEMORY_NOTE_MAX_CHARACTERS`. */
  | Readonly<{ code: "memory_note_too_long"; characters: number }>;

/** What an edit did: the whole new text and the passage taken out (`before`) and put in (`after`), as its card shows them. */
export type MemoryNoteEditResult = Readonly<{
  operation: MemoryNoteOperation;
  text: string;
  before: string | null;
  after: string | null;
}>;

/** A passage an edit names or inserts: not blank, within the limit, storable. */
export function memoryNotePassageValid(value: unknown): value is string {
  return typeof value === "string" && memoryNotePassageSchema.safeParse(value).success;
}

/** The one place of `find` in `current`, or why there is none. */
function locate(current: string, find: string): number | MemoryNoteEditRefusal {
  const first = current.indexOf(find);
  if (first === -1) return { code: "memory_note_passage_not_found" };
  // Counted as `split` counts them, without overlaps.
  const occurrences = current.split(find).length - 1;
  return occurrences > 1 ? { code: "memory_note_passage_ambiguous", occurrences } : first;
}

/** Removes `[start, end)`, and one line break beside it when the passage is a whole line, so no blank line is left. */
function cut(current: string, start: number, end: number): string {
  const lineStart = start === 0 || current[start - 1] === "\n";
  const lineEnd = end === current.length || current[end] === "\n";
  if (lineStart && lineEnd) {
    if (end < current.length) end += 1;
    else if (start > 0) start -= 1;
  }
  return current.slice(0, start) + current.slice(end);
}

/**
 * The note after an edit, or why it cannot apply. The edit's passages must already be valid (`memoryNotePassageValid`);
 * the result is checked against the limit in code points, as the database counts them.
 */
export function applyMemoryNoteEdit(current: string, edit: MemoryNoteEdit): MemoryNoteEditResult | MemoryNoteEditRefusal {
  let result: MemoryNoteEditResult;
  if (edit.kind === "add") {
    const addition = edit.text.trim();
    const base = current.trimEnd();
    result = { after: addition, before: null, operation: "add", text: base ? `${base}\n${addition}` : addition };
  } else {
    const at = locate(current, edit.find);
    if (typeof at !== "number") return at;
    if (edit.kind === "replace") {
      if (edit.text === edit.find) return { code: "memory_note_unchanged" };
      // Sliced, not `String.replace`, whose replacement would read `$&` and its kin in the user's text.
      result = { after: edit.text, before: edit.find, operation: "replace",
        text: current.slice(0, at) + edit.text + current.slice(at + edit.find.length) };
    } else {
      result = { after: null, before: edit.find, operation: "remove", text: cut(current, at, at + edit.find.length) };
    }
  }
  if (result.text === current) return { code: "memory_note_unchanged" };
  const characters = memoryNoteCharacterCount(result.text);
  return characters > MEMORY_NOTE_MAX_CHARACTERS ? { code: "memory_note_too_long", characters } : result;
}

/** The edit an offer's stored operation stands for, applied again to the note as it is when the user accepts. */
export function memoryNoteEditOf(operation: MemoryNoteOperation, before: string | null, after: string | null): MemoryNoteEdit | null {
  switch (operation) {
    case "add": return after !== null ? { kind: "add", text: after } : null;
    case "replace": return before !== null && after !== null ? { find: before, kind: "replace", text: after } : null;
    case "remove": return before !== null ? { find: before, kind: "remove" } : null;
  }
}

/** The text an edit puts into the note, which the secret screen reads; a removal puts nothing in. */
export function memoryNoteEditInsertion(edit: MemoryNoteEdit): string | null {
  return edit.kind === "remove" ? null : edit.text;
}
