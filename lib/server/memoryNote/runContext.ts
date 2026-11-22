import type { Prisma } from "@prisma/client";
import type { MemoryNote, MemorySwitches } from "@/lib/contracts/memoryNote";
import { readMemoryNote, readMemorySwitches } from "./store";

/** What a run's admission reads of Memory: the switches, and the note while Memory is on. */
export type MemoryNoteRunContext = Readonly<{
  switches: MemorySwitches;
  /** Null while `memoryEnabled` is off: such a turn reads no note. */
  note: MemoryNote | null;
}>;

/**
 * The switches and the note as a run's admission freezes them (accepted runs keep their bindings, so a later change
 * applies from the next message). Takes the client or the admission's own transaction; reads only, takes no lock. The
 * caller decides which turns read it at all (Temporary chats, Excluded chats and scheduled tasks with Memory off read
 * nothing), and that the note never changes from a scheduled occurrence.
 */
export async function loadMemoryNoteForRun(
  db: Pick<Prisma.TransactionClient, "userMemoryNote" | "userSettings">,
  userId: string
): Promise<MemoryNoteRunContext> {
  const switches = await readMemorySwitches(db, userId);
  return { note: switches.memoryEnabled ? await readMemoryNote(db, userId) : null, switches };
}
