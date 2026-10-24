"use client";

import { useState } from "react";
import type { ComposerAttachmentItemV2 } from "@/features/attachments-v2/attachmentPresentation";

/**
 * A plain-text paste at least this long (in UTF-16 code units, `.length`)
 * becomes a text file in the tray instead of filling the message box.
 */
export const PASTE_AS_FILE_MIN_CHARS = 5_000;

type PastedText = Readonly<{
  byteSize: number;
  fileName: string;
  /** The row has appeared in the tray; once it leaves, the text is forgotten. */
  seen: boolean;
  text: string;
}>;

const EMPTY_PASTED_TEXTS: readonly PastedText[] = [];

function matches(entry: PastedText, item: ComposerAttachmentItemV2): boolean {
  // The row changes its id when its upload settles, so it is found by name
  // (unique within the draft) and, once reported, by size.
  return item.status !== "rejected" && item.fileName === entry.fileName &&
    (item.byteSize === undefined || item.byteSize === entry.byteSize);
}

/** "Pasted text.txt", then "Pasted text 2.txt", … skipping names in use. */
export function pastedTextFileName(taken: ReadonlySet<string>): string {
  for (let number = 1; ; number += 1) {
    const name = number === 1 ? "Pasted text.txt" : `Pasted text ${number}.txt`;
    if (!taken.has(name)) return name;
  }
}

function reconcile(entries: readonly PastedText[], items: readonly ComposerAttachmentItemV2[]): readonly PastedText[] {
  let changed = false;
  const next: PastedText[] = [];
  for (const entry of entries) {
    const listed = items.some((item) => matches(entry, item));
    if (listed && !entry.seen) {
      next.push({ ...entry, seen: true });
      changed = true;
    } else if (!listed && entry.seen) changed = true;
    else next.push(entry);
  }
  return changed ? next : entries;
}

/**
 * The text behind each pasted-text attachment of the current draft, kept only
 * in this tab's memory so "Paste as text" can put it back in the message. A
 * text leaves with its row (sent, removed, failed) and with the session; it is
 * never stored, like any other attachment of a draft.
 */
export function usePastedTextAttachmentsV2(items: readonly ComposerAttachmentItemV2[], sessionKey: string) {
  const [state, setState] = useState<Readonly<{ entries: readonly PastedText[]; sessionKey: string }>>(
    () => ({ entries: EMPTY_PASTED_TEXTS, sessionKey })
  );
  const current = state.sessionKey === sessionKey ? state.entries : EMPTY_PASTED_TEXTS;
  const entries = reconcile(current, items);
  // Adjusted while rendering, so a row never shows a stale action for a frame.
  if (entries !== state.entries || state.sessionKey !== sessionKey) setState({ entries, sessionKey });

  function entryFor(id: string): PastedText | null {
    const item = items.find((candidate) => candidate.id === id);
    return item ? entries.find((entry) => matches(entry, item)) ?? null : null;
  }

  return {
    /** Tray rows that came from a paste and can turn back into text. */
    ids: new Set(items.filter((item) => entries.some((entry) => matches(entry, item))).map((item) => item.id)),
    /** A UTF-8 text file for the paste, named after the files already in the draft. */
    fileFor(text: string): File {
      const taken = new Set([...items.map((item) => item.fileName), ...entries.map((entry) => entry.fileName)]);
      return new File([text], pastedTextFileName(taken), { type: "text/plain" });
    },
    forget(id: string) {
      const entry = entryFor(id);
      if (entry) setState({ entries: entries.filter((candidate) => candidate !== entry), sessionKey });
    },
    remember(file: File, text: string) {
      setState({ entries: [...entries, { byteSize: file.size, fileName: file.name, seen: false, text }], sessionKey });
    },
    textFor(id: string): string | null {
      return entryFor(id)?.text ?? null;
    }
  };
}
