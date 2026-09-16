import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createInstructionPreviewHandlers } from "@/lib/server/instructions/previewHandlers";

export const runtime = "nodejs";
export const { GET } = createInstructionPreviewHandlers({ resolveAuth: resolveRequestAuth });
