import { defaultMemoryNoteHandlers } from "@/lib/server/memoryNote/defaultMemoryNote";

// The user's three Memory switches.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return defaultMemoryNoteHandlers.preferencesGET(request);
}

export async function PATCH(request: Request) {
  return defaultMemoryNoteHandlers.preferencesPATCH(request);
}
