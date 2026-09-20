import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createArtifactEditHandler } from "@/lib/server/artifacts/handlers";
import { defaultArtifactService } from "@/lib/server/artifacts/defaultArtifacts";

export const runtime = "nodejs";
export const POST = createArtifactEditHandler({ resolveAuth: resolveRequestAuth, service: defaultArtifactService() });
