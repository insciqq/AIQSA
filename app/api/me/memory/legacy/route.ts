import { defaultMemoryNoteHandlers } from "@/lib/server/memoryNote/defaultMemoryNote";

// The old Memory's facts waiting for their owner: one page of them, or remove them all.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return defaultMemoryNoteHandlers.legacyGET(request);
}

export async function DELETE(request: Request) {
  return defaultMemoryNoteHandlers.legacyDELETE(request);
}
