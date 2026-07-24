import { Prisma, type PrismaClient } from "@prisma/client";
import { isRunProfileId } from "../../../domain/runProfiles";
import {
  resolveRunProfileModel,
  supportsRunProfileReasoning,
  type RunProfileModelRecord
} from "../../runProfiles/configuration";
import type {
  AdminRunProfileRepository,
  AdminRunProfileState,
  StoredRunProfile
} from "./repositoryContract";

type RunProfileDb = Pick<PrismaClient, "providerModel" | "runProfile">;

async function loadState(db: RunProfileDb): Promise<AdminRunProfileState> {
  const [profiles, models] = await Promise.all([
    db.runProfile.findMany({ orderBy: { id: "asc" } }),
    db.providerModel.findMany({
      include: {
        connection: {
          select: {
            activeConfig: true,
            activeVersion: true,
            activatedAt: true,
            displayName: true,
            enabled: true,
            family: true
          }
        }
      },
      orderBy: [{ connection: { displayName: "asc" } }, { displayName: "asc" }, { id: "asc" }],
      where: { connection: { family: { not: "fake" } } }
    })
  ]);

  return {
    models: models as RunProfileModelRecord[],
    profiles: profiles.map((profile): StoredRunProfile => {
      if (!isRunProfileId(profile.id)) {
        throw new Error("run_profile_id_invalid");
      }
      return {
        description: profile.description,
        enabled: profile.enabled,
        id: profile.id,
        providerModelId: profile.providerModelId,
        reasoningEffort: profile.reasoningEffort,
        reasoningMode: profile.reasoningMode,
        updatedAt: profile.updatedAt,
        version: profile.version
      };
    })
  };
}

export function createPrismaAdminRunProfileRepository(
  prisma: PrismaClient
): AdminRunProfileRepository {
  return {
    loadState: () => loadState(prisma),

    async updateAll(input) {
      return prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string; version: number }>>(Prisma.sql`
          SELECT "id", "version"
          FROM "RunProfile"
          ORDER BY "id"
          FOR UPDATE
        `);
        const lockedVersions = new Map(locked.map((profile) => [profile.id, profile.version]));
        if (
          locked.length !== input.profiles.length ||
          input.profiles.some(
            (profile) => lockedVersions.get(profile.id) !== profile.expectedVersion
          )
        ) {
          return "stale" as const;
        }

        const targetIds = input.profiles.flatMap((profile) =>
          profile.providerModelId ? [profile.providerModelId] : []
        );
        const targets = targetIds.length > 0
          ? await tx.providerModel.findMany({
              include: {
                connection: {
                  select: {
                    activeConfig: true,
                    activeVersion: true,
                    activatedAt: true,
                    displayName: true,
                    enabled: true,
                    family: true
                  }
                }
              },
              where: { id: { in: targetIds } }
            })
          : [];
        const targetsById = new Map(targets.map((model) => [model.id, model]));
        for (const profile of input.profiles) {
          if (!profile.enabled || !profile.providerModelId) continue;
          const target = targetsById.get(profile.providerModelId);
          const resolved = target ? resolveRunProfileModel(target) : null;
          if (
            !resolved ||
            !supportsRunProfileReasoning({
              controls: resolved.controls,
              reasoningEffort: profile.reasoningEffort,
              reasoningMode: profile.reasoningMode
            })
          ) {
            return "invalid_target" as const;
          }
        }

        for (const profile of input.profiles) {
          await tx.runProfile.update({
            data: {
              description: profile.description,
              enabled: profile.enabled,
              providerModelId: profile.enabled ? profile.providerModelId : null,
              reasoningEffort: profile.reasoningEffort,
              reasoningMode: profile.reasoningMode,
              updatedByUserId: input.updatedByUserId,
              version: { increment: 1 }
            },
            where: { id: profile.id }
          });
        }

        return loadState(tx);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    }
  };
}
