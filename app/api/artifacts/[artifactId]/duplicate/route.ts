import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { defaultArtifactService } from "@/lib/server/artifacts/defaultArtifacts";
import { createArtifactDuplicateHandler } from "@/lib/server/artifacts/handlers";

export const runtime = "nodejs";
export const POST = createArtifactDuplicateHandler({ resolveAuth: resolveRequestAuth, service: defaultArtifactService() });
