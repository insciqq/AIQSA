import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createInstructionPresetHandlers } from "@/lib/server/instructions/handlers";
import { createInstructionPresetStore } from "@/lib/server/instructions/store";
import { prisma } from "@/lib/server/prisma";

export const runtime = "nodejs";
const handlers = createInstructionPresetHandlers({ resolveAuth: resolveRequestAuth, store: createInstructionPresetStore(prisma) });
export async function GET(request: Request, context: { params: Promise<{ presetId: string }> }) {
  return handlers.detail(request, (await context.params).presetId);
}
