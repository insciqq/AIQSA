import { defaultComposerConfigHandlerDeps } from "@/lib/server/composerConfig/defaultComposerConfig";
import { createComposerConfigHandler } from "@/lib/server/composerConfig/handlers";

export const runtime = "nodejs";

export const GET = createComposerConfigHandler(defaultComposerConfigHandlerDeps);
