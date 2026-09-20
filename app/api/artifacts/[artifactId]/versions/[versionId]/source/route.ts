import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { createArtifactSourceHandler } from "@/lib/server/artifacts/handlers";
import { defaultArtifactService } from "@/lib/server/artifacts/defaultArtifacts";

export const runtime = "nodejs";
export const GET = createArtifactSourceHandler({ resolveAuth: resolveRequestAuth, service: defaultArtifactService() });
