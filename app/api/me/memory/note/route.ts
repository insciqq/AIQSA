import { defaultMemoryNoteHandlers } from "@/lib/server/memoryNote/defaultMemoryNote";

// The user's memory note: read it, or save the whole text under the revision the editor read.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return defaultMemoryNoteHandlers.noteGET(request);
}

export async function PUT(request: Request) {
  return defaultMemoryNoteHandlers.notePUT(request);
}
