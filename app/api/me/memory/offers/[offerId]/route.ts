import { defaultMemoryNoteHandlers } from "@/lib/server/memoryNote/defaultMemoryNote";

// One offer the agent made in an answer: its state, and the user's Remember or No thanks.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ offerId: string }> };

export async function GET(request: Request, context: Context) {
  return defaultMemoryNoteHandlers.offerGET(request, (await context.params).offerId);
}

export async function POST(request: Request, context: Context) {
  return defaultMemoryNoteHandlers.offerPOST(request, (await context.params).offerId);
}
