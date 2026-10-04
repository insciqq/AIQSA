import type { PrismaClient } from "@prisma/client";
import type { CatalogImageRoutes, CatalogWireModel } from "../../contracts/catalog";
import { createImageModelRoleResolver, type ImageModelScope } from "../providerRuntime/imageModelRole";
import { createVisionAnalysisPlanResolver } from "../providerRuntime/visionAnalysis";

/** Installation facts behind the image routes of every composer catalog. */
export type ImageRouteFacts = Readonly<CatalogImageRoutes>;

/**
 * Verified editing by the image model a chat run of this scope binds: the
 * user's effective model for personal chats, the administrator default for
 * Project chats. An unusable or generation-only model edits nothing and no
 * other model stands in, exactly as run admission resolves it.
 */
async function imageEditingFor(db: PrismaClient, scope: ImageModelScope): Promise<boolean> {
  const resolved = await createImageModelRoleResolver(db).resolveFor(scope);
  return resolved.ok && resolved.plan.snapshot.model.capabilities.imageEditing === true;
}

/** What run admission would offer now in this chat scope: an available
 * System Vision plan, and editing by the run's image model. */
export async function resolveImageRouteFacts(db: PrismaClient, scope: ImageModelScope): Promise<ImageRouteFacts> {
  const [vision, editing] = await Promise.all([createVisionAnalysisPlanResolver(db)(), imageEditingFor(db, scope)]);
  return { systemVision: vision.available, imageEditing: editing };
}

/** One rule for the personal and Project composers, mirroring run admission:
 * both routes need tool calling; System Vision serves only a model without image input. */
export function withImageRoutes(model: CatalogWireModel, facts: ImageRouteFacts): CatalogWireModel {
  return model.capabilities.toolCalling ? { ...model, capabilities: { ...model.capabilities, imageRoutes: {
    systemVision: facts.systemVision && !model.capabilities.imageInput, imageEditing: facts.imageEditing
  } } } : model;
}
