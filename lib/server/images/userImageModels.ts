import { Prisma, type PrismaClient } from "@prisma/client";
import type { UserImageModelOption, UserImageModelSettings } from "../../contracts/imageModels";
import { loadInstallationImageProviderRole } from "../providerRuntime/admission";
import { createImageModelRoleResolver } from "../providerRuntime/imageModelRole";

export class UserImageModelError extends Error {
  constructor(readonly code: "image_model_not_published") {
    super(code);
    this.name = "UserImageModelError";
  }
}

/** Every published image model is available to every user; the choice only
 * selects one of them and never changes the administrator's parameters. */
export function createUserImageModelService(prisma: PrismaClient, loadRole = loadInstallationImageProviderRole) {
  const resolver = createImageModelRoleResolver(prisma, loadRole);
  const service = {
    async read(userId: string): Promise<UserImageModelSettings> {
      const [policy, settings, publications] = await Promise.all([
        prisma.systemModelPolicy.findUnique({ where: { id: "installation" }, select: { version: true, imageProviderModelId: true } }),
        prisma.userSettings.findUnique({ where: { userId }, select: { imageProviderModelId: true } }),
        prisma.publishedImageModel.findMany({
          select: { providerModelId: true, paramsJson: true,
            providerModel: { select: { displayName: true, connection: { select: { displayName: true } } } } },
          orderBy: [{ providerModel: { displayName: "asc" } }, { providerModelId: "asc" }]
        })
      ]);
      const models: UserImageModelOption[] = [];
      for (const publication of publications) {
        // The same admission path as a run: usability is never inferred from names.
        const resolved = await resolver.resolvePublished(publication, policy?.version ?? 1);
        const capabilities = resolved.ok ? resolved.plan.snapshot.model.capabilities : null;
        models.push({ id: publication.providerModelId, displayName: publication.providerModel.displayName,
          providerName: publication.providerModel.connection.displayName,
          generation: capabilities?.imageGeneration === true, editing: capabilities?.imageEditing === true,
          unavailableReason: resolved.ok ? null : resolved.reason });
      }
      const organizationDefaultId = policy?.imageProviderModelId ?? null;
      const selectedId = settings?.imageProviderModelId ?? null;
      const effectiveId = selectedId ?? organizationDefaultId;
      return { models, organizationDefaultId, selectedId,
        effective: effectiveId === null ? null : { id: effectiveId, source: selectedId === null ? "organization" : "personal" } };
    },

    /** Null follows the administrator default. Only a published model is
     * accepted; its foreign key keeps it published until withdrawal resets it. */
    async select(userId: string, providerModelId: string | null): Promise<UserImageModelSettings> {
      try {
        await prisma.$transaction(async (tx) => {
          if (providerModelId !== null && !await tx.publishedImageModel.findUnique({
            where: { providerModelId }, select: { providerModelId: true }
          })) throw new UserImageModelError("image_model_not_published");
          await tx.userSettings.upsert({ where: { userId }, create: { userId, imageProviderModelId: providerModelId },
            update: { imageProviderModelId: providerModelId } });
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
          throw new UserImageModelError("image_model_not_published");
        }
        throw error;
      }
      return service.read(userId);
    }
  };
  return service;
}

export type UserImageModelService = ReturnType<typeof createUserImageModelService>;
