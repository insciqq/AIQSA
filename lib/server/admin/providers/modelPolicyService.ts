import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  AdminModelDefaultCandidate,
  AdminDefaultAnswerModelCandidate,
  AdminModelPolicyCatalog
} from "../../../contracts/adminModelPolicy";
import { isMcpAutoDiscoveryOutputTokens } from "../../../contracts/mcp";
import { normalizeProviderModelConfiguration } from "../../providers/providerConfiguration";
import { configuredModelParameterControls } from "../../providers/providerModelCapabilities";

export type AdminModelPolicyServiceErrorCode =
  | "model_policy_stale"
  | "model_policy_reasoning_invalid"
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
    family?: string;
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

function reasoningControls(activeConfig: unknown, family: string) {
  return configuredModelParameterControls(
    normalizeProviderModelConfiguration(activeConfig), family
  ).reasoningEffort;
}

function serializeDefaultAnswerModel(row: AdminAnswerModelRow): AdminDefaultAnswerModelCandidate {
  let reasoningEfforts: string[] = [];
  let defaultReasoningEffort: string | null = null;
  try {
    const controls = reasoningControls(row.activeConfig, row.connection.family ?? "");
    if (controls.supported) {
      reasoningEfforts = [...controls.options];
      defaultReasoningEffort = controls.defaultValue;
    }
  } catch {
    // A retained unavailable deployment still has an identity, not trusted controls.
  }
  return { ...serializeAdminAnswerModel(row), defaultReasoningEffort, reasoningEfforts };
}

type LockedModelRow = {
  activeConfig: unknown;
  activeVersion: number;
  activatedAt: Date | null;
  connectionActiveConfig: unknown;
  connectionActivatedAt: Date | null;
  connectionActiveVersion: number;
  connectionEnabled: boolean;
  connectionFamily: string;
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
          ],
          where: { modelClass: "answer" }
        })
      ]);
      if (!policy) throw new Error("installation_model_policy_missing");
      const models = rows as AdminAnswerModelRow[];
      return {
        candidates: models.filter(adminAnswerModelAvailable).map(serializeDefaultAnswerModel),
        policy: {
          defaultModel: policy.defaultProviderModel
            ? {
                ...serializeDefaultAnswerModel(policy.defaultProviderModel as AdminAnswerModelRow),
                available: adminAnswerModelAvailable(
                  policy.defaultProviderModel as AdminAnswerModelRow
                )
              }
            : null,
          reasoningEffort: policy.reasoningEffort,
          mcpAutoDiscoveryTimeoutSeconds: Number(policy.mcpAutoDiscoveryTimeoutSeconds),
          mcpAutoDiscoveryMaxOutputTokens: Number(policy.mcpAutoDiscoveryMaxOutputTokens),
          maxMcpToolsPerDiscovery: Number(policy.maxMcpToolsPerDiscovery),
          maxToolCalls: Number(policy.maxToolCalls),
          maxToolRounds: Number(policy.maxToolRounds),
          updatedAt: policy.updatedAt.toISOString(),
          updatedBy: policy.updatedBy,
          version: policy.version
        }
      };
    },

    /**
     * One optimistic save for the Chat defaults card: the default model pair
     * and the tool limits may arrive together or alone, all under the
     * same expected version, so the administrator sees one result.
     */
    async update(input: Readonly<{
      expectedVersion: number;
      providerModelId?: string | null;
      reasoningEffort?: string | null;
      maxToolCalls?: number;
      maxToolRounds?: number;
      maxMcpToolsPerDiscovery?: number;
      mcpAutoDiscoveryTimeoutSeconds?: number;
      mcpAutoDiscoveryMaxOutputTokens?: number;
      userId: string;
    }>): Promise<void> {
      const hasModel = input.providerModelId !== undefined;
      const limits = [
        input.maxToolCalls,
        input.maxToolRounds,
        input.maxMcpToolsPerDiscovery,
        input.mcpAutoDiscoveryTimeoutSeconds,
        input.mcpAutoDiscoveryMaxOutputTokens
      ];
      const hasLimits = limits.some((value) => value !== undefined);
      if (hasModel !== (input.reasoningEffort !== undefined) ||
        hasLimits && limits.some((value) => value === undefined) ||
        hasLimits && !isMcpAutoDiscoveryOutputTokens(input.mcpAutoDiscoveryMaxOutputTokens) ||
        !hasModel && !hasLimits) {
        throw new Error("model_policy_update_invalid");
      }
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

          if (hasModel && input.providerModelId !== null) {
            const models = await tx.$queryRaw<LockedModelRow[]>(Prisma.sql`
              SELECT
                model."id",
                model."enabled",
                model."activeConfig",
                model."activeVersion",
                model."activatedAt",
                connection."enabled" AS "connectionEnabled",
                connection."family" AS "connectionFamily",
                connection."activeConfig" AS "connectionActiveConfig",
                connection."activeVersion" AS "connectionActiveVersion",
                connection."activatedAt" AS "connectionActivatedAt"
              FROM "ProviderModel" AS model
              INNER JOIN "ProviderConnection" AS connection
                ON connection."id" = model."connectionId"
              WHERE model."id" = ${input.providerModelId}
                AND model."modelClass" = 'answer'::"ProviderModelClass"
              FOR SHARE OF model, connection
            `);
            if (!models[0] || !lockedModelAvailable(models[0])) {
              throw new AdminModelPolicyServiceError("model_policy_target_unavailable");
            }
            if (input.reasoningEffort) {
              const controls = reasoningControls(models[0].activeConfig, models[0].connectionFamily);
              if (!controls.supported || !controls.options.includes(input.reasoningEffort)) {
                throw new AdminModelPolicyServiceError("model_policy_reasoning_invalid");
              }
            }
          } else if (hasModel && input.reasoningEffort !== null) {
            throw new AdminModelPolicyServiceError("model_policy_reasoning_invalid");
          }

          await tx.modelPolicy.update({
            data: {
              ...(hasModel ? {
                defaultProviderModelId: input.providerModelId,
                reasoningEffort: input.reasoningEffort
              } : {}),
              ...(hasLimits ? {
                mcpAutoDiscoveryTimeoutSeconds: BigInt(input.mcpAutoDiscoveryTimeoutSeconds!),
                mcpAutoDiscoveryMaxOutputTokens: BigInt(input.mcpAutoDiscoveryMaxOutputTokens!),
                maxMcpToolsPerDiscovery: BigInt(input.maxMcpToolsPerDiscovery!),
                maxToolCalls: BigInt(input.maxToolCalls!),
                maxToolRounds: BigInt(input.maxToolRounds!)
              } : {}),
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
