import { defaultKnowledgeSourceLibraryHandlerDeps } from "@/lib/server/knowledge/defaultSourceLibrary";
import { createAddKnowledgeSourceMembershipsHandler } from "@/lib/server/knowledge/sourceLibraryHandlers";

export const runtime = "nodejs";

export const POST = createAddKnowledgeSourceMembershipsHandler(
  defaultKnowledgeSourceLibraryHandlerDeps
);
