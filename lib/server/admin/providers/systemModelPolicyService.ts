import { Prisma, type PrismaClient } from "@prisma/client";
import type { AdminSystemModelPolicyCatalog } from "../../../contracts/adminSystemModelPolicy";
import {
  loadInstallationAnswerProviderRole,
  ProviderAdmissionError
} from "../../providerRuntime/admission";
import { createSystemModelRoleResolver } from "../../providerRuntime/systemModelRole";
import { normalizeProviderModelConfiguration } from "../../providers/providerConfiguration";
import {
  adminAnswerModelAvailable,
  serializeAdminAnswerModel,
  type AdminAnswerModelRow
} from "./modelPolicyService";

export type AdminSystemModelPolicyServiceErrorCode =
  | "system_model_policy_reasoning_unavailable"
  | "system_model_policy_stale"
  | "system_model_policy_target_unavailable";

export class AdminSystemModelPolicyServiceError extends Error {
  constructor(readonly code: AdminSystemModelPolicyServiceErrorCode) {
    super(code);
    this.name = "AdminSystemModelPolicyServiceError";
  }
}

type RoleLoader = typeof loadInstallationAnswerProviderRole;

function serializeSystemModel(row: AdminAnswerModelRow) {
  let reasoningEfforts: string[] = [];
  let defaultReasoningEffort: string | null = null;
  try {
    const capabilities = normalizeProviderModelConfiguration(row.activeConfig).capabilities;
    if (capabilities.reasoning) {
      reasoningEfforts = [...(capabilities.reasoningEfforts ?? [])];
      defaultReasoningEffort = capabilities.defaultReasoningEffort &&
        reasoningEfforts.includes(capabilities.defaultReasoningEffort)
        ? capabilities.defaultReasoningEffort
        : null;
    }
  } catch {
    // An unavailable retained target remains inspectable without trusting its
    // stale or malformed capability payload.
  }
  return {
    ...serializeAdminAnswerModel(row),
    defaultReasoningEffort,
    reasoningEfforts
  };
}

function supportsReasoningEffort(
  role: Awaited<ReturnType<RoleLoader>>,
  effort: string
): boolean {
  const capabilities = role.snapshot.model.capabilities;
  return capabilities.reasoning === true &&
    Array.isArray(capabilities.reasoningEfforts) &&
    capabilities.reasoningEfforts.includes(effort);
}

export function createAdminSystemModelPolicyService(
  prisma: PrismaClient,
  dependencies: Readonly<{
    loadRole?: RoleLoader;
    resolveRole?: ReturnType<typeof createSystemModelRoleResolver>["resolve"];
  }> = {}
) {
  const loadRole = dependencies.loadRole ?? loadInstallationAnswerProviderRole;
  const resolveRole = dependencies.resolveRole ??
    createSystemModelRoleResolver(prisma, { loadRole }).resolve;

  return {
    async list(): Promise<AdminSystemModelPolicyCatalog> {
      const [policy, rows, resolution] = await Promise.all([
        prisma.systemModelPolicy.findUnique({
          include: {
            providerModel: { include: { connection: true } },
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
        }),
        resolveRole()
      ]);
      if (!policy) throw new Error("installation_system_model_policy_missing");
      const models = rows as AdminAnswerModelRow[];
      return {
        candidates: models
          .filter(adminAnswerModelAvailable)
          .map(serializeSystemModel),
        policy: {
          reasoningEffort: policy.reasoningEffort,
          systemModel: policy.providerModel
            ? {
                ...serializeSystemModel(
                  policy.providerModel as AdminAnswerModelRow
                ),
                available: resolution.ok &&
                  resolution.providerModelId === policy.providerModelId &&
                  resolution.policyVersion === policy.version
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
      reasoningEffort: string | null;
      userId: string;
    }>): Promise<void> {
      try {
        await prisma.$transaction(async (tx) => {
          const policies = await tx.$queryRaw<Array<{ version: number }>>(Prisma.sql`
            SELECT "version"
            FROM "SystemModelPolicy"
            WHERE "id" = 'installation'
            FOR UPDATE
          `);
          if (!policies[0]) throw new Error("installation_system_model_policy_missing");
          if (policies[0].version !== input.expectedVersion) {
            throw new AdminSystemModelPolicyServiceError("system_model_policy_stale");
          }

          const administrator = await tx.user.findFirst({
            select: { id: true },
            where: { id: input.userId, role: "admin", status: "active" }
          });
          if (!administrator) {
            throw new AdminSystemModelPolicyServiceError(
              "system_model_policy_target_unavailable"
            );
          }

          if (input.providerModelId === null && input.reasoningEffort !== null) {
            throw new AdminSystemModelPolicyServiceError(
              "system_model_policy_reasoning_unavailable"
            );
          }

          if (input.providerModelId !== null) {
            try {
              const role = await loadRole(tx, {
                providerModelId: input.providerModelId
              });
              if (input.reasoningEffort !== null &&
                !supportsReasoningEffort(role, input.reasoningEffort)) {
                throw new AdminSystemModelPolicyServiceError(
                  "system_model_policy_reasoning_unavailable"
                );
              }
            } catch (error) {
              if (error instanceof AdminSystemModelPolicyServiceError) throw error;
              if (error instanceof ProviderAdmissionError) {
                throw new AdminSystemModelPolicyServiceError(
                  "system_model_policy_target_unavailable"
                );
              }
              throw error;
            }
          }

          await tx.systemModelPolicy.update({
            data: {
              providerModelId: input.providerModelId,
              reasoningEffort: input.reasoningEffort,
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
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          if (error.code === "P2034") {
            throw new AdminSystemModelPolicyServiceError("system_model_policy_stale");
          }
          if (error.code === "P2003") {
            throw new AdminSystemModelPolicyServiceError(
              "system_model_policy_target_unavailable"
            );
          }
        }
        throw error;
      }
    }
  };
}
