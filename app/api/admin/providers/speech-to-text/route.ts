import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createSpeechToTextAdminHandlers } from "@/lib/server/speechToText/adminHandlers";
import { speechToTextAdminService } from "@/lib/server/speechToText/defaults";

const handlers = createSpeechToTextAdminHandlers({
  resolveAuth: resolveRequestAuth,
  service: speechToTextAdminService
});

export const runtime = "nodejs";

export const GET = handlers.GET;
export const POST = handlers.POST;
