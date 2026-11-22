import { defaultMemoryNoteHandlers } from "@/lib/server/memoryNote/defaultMemoryNote";

// Keep one suggestion (it moves into the note) or remove it.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ suggestionId: string }> }) {
  return defaultMemoryNoteHandlers.legacyItemPOST(request, (await context.params).suggestionId);
}
