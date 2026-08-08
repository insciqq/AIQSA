import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  AdminModelDefaultCandidate,
  AdminModelPolicyCatalog
} from "../../../contracts/adminModelPolicy";
import { normalizeProviderModelConfiguration } from "../../providers/providerConfiguration";

export type AdminModelPolicyServiceErrorCode =
  | "model_policy_stale"
  | "model_policy_target_unavailable";

export class AdminModelPolicyServiceError extends Error {
  constructor(readonly code: AdminModelPolicyServiceErrorCode) {
    super(code);
    this.name = "AdminModelPolicyServiceError";
  }
}

export type AdminAnswerModelRow = {
  activeConfig: unknown;
  activeVersion: number;
  activatedAt: Date | null;
  connection: {
    activeConfig: unknown;
    activeVersion: number;
    activatedAt: Date | null;
    displayName: string;
    enabled: boolean;
    id: string;
  };
  connectionId: string;
  displayName: string;
  enabled: boolean;
  id: string;
};

function answerSelectable(value: unknown): boolean {
  try {
    return normalizeProviderModelConfiguration(value).answerSelectable;
  } catch {
    return false;
  }
}

export function adminAnswerModelAvailable(row: AdminAnswerModelRow): boolean {
  return row.enabled && row.activeVersion > 0 && row.activatedAt !== null &&
    row.activeConfig !== null && row.connection.enabled && row.connection.activeVersion > 0 &&
    row.connection.activatedAt !== null && row.connection.activeConfig !== null &&
    answerSelectable(row.activeConfig);
}

export function serializeAdminAnswerModel(
  row: AdminAnswerModelRow
): AdminModelDefaultCandidate {
  return {
    connectionDisplayName: row.connection.displayName,
    connectionId: row.connectionId,
    displayName: row.displayName,
    id: row.id
  };
}

type LockedModelRow = {
  activeConfig: unknown;
  activeVersion: number;
  activatedAt: Date | null;
  connectionActiveConfig: unknown;
  connectionActivatedAt: Date | null;
  connectionActiveVersion: number;
  connectionEnabled: boolean;
  enabled: boolean;
  id: string;
};

function lockedModelAvailable(row: LockedModelRow): boolean {
  return row.enabled && row.activeVersion > 0 && row.activatedAt !== null &&
    row.activeConfig !== null && row.connectionEnabled && row.connectionActiveVersion > 0 &&
    row.connectionActivatedAt !== null && row.connectionActiveConfig !== null &&
    answerSelectable(row.activeConfig);
}

export function createAdminModelPolicyService(prisma: PrismaClient) {
  return {
    async list(): Promise<AdminModelPolicyCatalog> {
      const [policy, rows] = await Promise.all([
        prisma.modelPolicy.findUnique({
          include: {
            defaultProviderModel: { include: { connection: true } },
            updatedBy: { select: { displayName: true, id: true } }
          },
          where: { id: "installation" }
        }),
        prisma.providerModel.findMany({
          include: { connection: true },
          orderBy: [
            { connection: { displayName: "asc" } },
            { displayName: "asc" },
            { id: "asc" }
          ]
        })
      ]);
      if (!policy) throw new Error("installation_model_policy_missing");
      const models = rows as AdminAnswerModelRow[];
      return {
        candidates: models.filter(adminAnswerModelAvailable).map(serializeAdminAnswerModel),
        policy: {
          defaultModel: policy.defaultProviderModel
            ? {
                ...serializeAdminAnswerModel(policy.defaultProviderModel as AdminAnswerModelRow),
                available: adminAnswerModelAvailable(
                  policy.defaultProviderModel as AdminAnswerModelRow
                )
              }
            : null,
          updatedAt: policy.updatedAt.toISOString(),
          updatedBy: policy.updatedBy,
          version: policy.version
        }
      };
    },

    async update(input: Readonly<{
      expectedVersion: number;
      providerModelId: string | null;
      userId: string;
    }>): Promise<void> {
      try {
        await prisma.$transaction(async (tx) => {
          const policies = await tx.$queryRaw<Array<{ version: number }>>(Prisma.sql`
            SELECT "version"
            FROM "ModelPolicy"
            WHERE "id" = 'installation'
            FOR UPDATE
          `);
          if (!policies[0]) throw new Error("installation_model_policy_missing");
          if (policies[0].version !== input.expectedVersion) {
            throw new AdminModelPolicyServiceError("model_policy_stale");
          }

          if (input.providerModelId !== null) {
            const models = await tx.$queryRaw<LockedModelRow[]>(Prisma.sql`
              SELECT
                model."id",
                model."enabled",
                model."activeConfig",
                model."activeVersion",
                model."activatedAt",
                connection."enabled" AS "connectionEnabled",
                connection."activeConfig" AS "connectionActiveConfig",
                connection."activeVersion" AS "connectionActiveVersion",
                connection."activatedAt" AS "connectionActivatedAt"
              FROM "ProviderModel" AS model
              INNER JOIN "ProviderConnection" AS connection
                ON connection."id" = model."connectionId"
              WHERE model."id" = ${input.providerModelId}
              FOR SHARE OF model, connection
            `);
            if (!models[0] || !lockedModelAvailable(models[0])) {
              throw new AdminModelPolicyServiceError("model_policy_target_unavailable");
            }
          }

          await tx.modelPolicy.update({
            data: {
              defaultProviderModelId: input.providerModelId,
              updatedByUserId: input.userId,
              version: { increment: 1 }
            },
            where: { id: "installation" }
          });
        }, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 30_000
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
          throw new AdminModelPolicyServiceError("model_policy_stale");
        }
        throw error;
      }
    }
  };
}
