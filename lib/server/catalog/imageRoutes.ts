import type { PrismaClient } from "@prisma/client";
import type { CatalogImageRoutes, CatalogWireModel } from "../../contracts/catalog";
import { createImageModelRoleResolver } from "../providerRuntime/imageModelRole";
import { createVisionAnalysisPlanResolver } from "../providerRuntime/visionAnalysis";

/** Installation facts behind the image routes of every composer catalog. */
export type ImageRouteFacts = Readonly<CatalogImageRoutes>;

/**
 * Verified editing by the image model a chat run binds: today the installation
 * image model, for personal and Project chats alike. This is the one editing
 * source to replace when personal chats bind a user-chosen image model.
 */
export async function installationImageEditing(db: PrismaClient): Promise<boolean> {
  return (await createImageModelRoleResolver(db).resolve())?.snapshot.model.capabilities.imageEditing === true;
}

/** What run admission would offer now: an available System Vision plan, and editing by the run's image model. */
export async function resolveImageRouteFacts(db: PrismaClient,
  imageEditing: () => Promise<boolean> = () => installationImageEditing(db)): Promise<ImageRouteFacts> {
  const [vision, editing] = await Promise.all([createVisionAnalysisPlanResolver(db)(), imageEditing()]);
  return { systemVision: vision.available, imageEditing: editing };
}

/** One rule for the personal and Project composers, mirroring run admission:
 * both routes need tool calling; System Vision serves only a model without image input. */
export function withImageRoutes(model: CatalogWireModel, facts: ImageRouteFacts): CatalogWireModel {
  return model.capabilities.toolCalling ? { ...model, capabilities: { ...model.capabilities, imageRoutes: {
    systemVision: facts.systemVision && !model.capabilities.imageInput, imageEditing: facts.imageEditing
  } } } : model;
}
