import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { transcriptionHandlerDeps } from "@/lib/server/speechToText/defaults";
import { createTranscriptionHandler } from "@/lib/server/speechToText/transcriptionHandlers";

export const runtime = "nodejs";

export const POST = createTranscriptionHandler({ ...transcriptionHandlerDeps, resolveAuth: resolveRequestAuth });
