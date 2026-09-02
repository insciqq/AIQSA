import { Prisma, type PrismaClient } from "@prisma/client";
import type { AdminSystemModelPolicyCatalog } from "../../../contracts/adminSystemModelPolicy";
import {
  loadInstallationAnswerProviderRole,
  loadInstallationRerankerProviderRole,
  ProviderAdmissionError
} from "../../providerRuntime/admission";
import { createSystemModelRoleResolver } from "../../providerRuntime/systemModelRole";
import { createRerankerModelRoleResolver } from "../../providerRuntime/rerankerModelRole";
import { normalizeProviderModelConfiguration } from "../../providers/providerConfiguration";
import {
  adminAnswerModelAvailable,
  serializeAdminAnswerModel,
  type AdminAnswerModelRow
} from "./modelPolicyService";
import { structuredOutputVerificationStatus } from "../../providers/structuredOutputEvidence";
import {
  forcedToolCallVerificationStatus,
  supportsForcedToolCallProbe
} from
  "../../providers/forcedToolCallEvidence";
import { supportsStructuredOutputAdapter } from "../../providers/structuredOutput";
import { RERANKER_ROUTE_POLICY_VERSION } from "../../../domain/rerankerModels";
import {
  approvedRerankerDeploymentByProviderModelId,
  approvedRerankerDeployments
} from "./approvedRerankers";

type SystemModelRow = AdminAnswerModelRow & {
  activeCredentialChecks: Array<{
    connectionVersion: number;
    credentialId: string;
    credentialVersionId: string;
    evidence: unknown;
    modelVersion: number;
    status: "available" | "unavailable";
  }>;
  connection: AdminAnswerModelRow["connection"] & {
    defaultCredential: null | {
      activeVersion: null | { id: string };
      id: string;
    };
  };
};

export type AdminSystemModelPolicyServiceErrorCode =
  | "system_model_policy_reasoning_unavailable"
  | "system_model_policy_stale"
  | "system_model_policy_structured_output_unsupported"
  | "system_model_policy_target_unavailable"
  | "system_model_policy_verification_failed";

export class AdminSystemModelPolicyServiceError extends Error {
  constructor(readonly code: AdminSystemModelPolicyServiceErrorCode) {
    super(code);
    this.name = "AdminSystemModelPolicyServiceError";
  }
}

type RoleLoader = typeof loadInstallationAnswerProviderRole;
type RerankerRoleLoader = typeof loadInstallationRerankerProviderRole;

type ActiveRefresh = (input: Readonly<{
  confirmPaidRequest: true;
  connectionId: string;
  credentialId: string;
  providerModelId: string;
  signal?: AbortSignal;
}>) => Promise<Readonly<{
  evidence: unknown;
  status: "available" | "unavailable";
}>>;

function serializeSystemModel(row: SystemModelRow) {
  let reasoningEfforts: string[] = [];
  let defaultReasoningEffort: string | null = null;
  let forcedToolCall: "not_verified" | "unsupported" | "verified" = "unsupported";
  let structuredOutput: "not_verified" | "unsupported" | "verified" = "unsupported";
  try {
    const configuration = normalizeProviderModelConfiguration(row.activeConfig);
    const capabilities = configuration.capabilities;
    if (capabilities.reasoning) {
      reasoningEfforts = [...(capabilities.reasoningEfforts ?? [])];
      defaultReasoningEffort = capabilities.defaultReasoningEffort &&
        reasoningEfforts.includes(capabilities.defaultReasoningEffort)
        ? capabilities.defaultReasoningEffort
        : null;
    }
    const credential = row.connection.defaultCredential;
    const check = credential?.activeVersion
      ? row.activeCredentialChecks.find((candidate) =>
          candidate.connectionVersion === row.connection.activeVersion &&
          candidate.credentialId === credential.id &&
          candidate.credentialVersionId === credential.activeVersion!.id &&
          candidate.modelVersion === row.activeVersion &&
          candidate.status === "available")
      : null;
    structuredOutput = structuredOutputVerificationStatus(
      check?.evidence,
      configuration
    );
    forcedToolCall = forcedToolCallVerificationStatus(
      check?.evidence,
      configuration
    );
  } catch {
    // An unavailable retained target remains inspectable without trusting its
    // stale or malformed capability payload.
  }
  return {
    ...serializeAdminAnswerModel(row),
    defaultReasoningEffort,
    forcedToolCall,
    reasoningEfforts,
    structuredOutput
  };
}

function rerankerModelAvailable(row: AdminAnswerModelRow): boolean {
  if (!row.enabled || row.activeVersion < 1 || row.activatedAt === null ||
    row.activeConfig === null || !row.connection.enabled ||
    row.connection.activeVersion < 1 || row.connection.activatedAt === null ||
    row.connection.activeConfig === null) return false;
  try {
    const configuration = normalizeProviderModelConfiguration(row.activeConfig);
    return configuration.modelClass === "reranker" &&
      configuration.adapterKind === "openrouter_rerank" &&
      configuration.answerSelectable === false;
  } catch {
    return false;
  }
}

function serializeRerankerModel(row: AdminAnswerModelRow) {
  return serializeAdminAnswerModel(row);
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
    loadRerankerRole?: RerankerRoleLoader;
    refreshActive?: ActiveRefresh;
    resolveRerankerRole?: ReturnType<typeof createRerankerModelRoleResolver>["resolve"];
    resolveRole?: ReturnType<typeof createSystemModelRoleResolver>["resolve"];
  }> = {}
) {
  const loadRole = dependencies.loadRole ?? loadInstallationAnswerProviderRole;
  const resolveRole = dependencies.resolveRole ??
    createSystemModelRoleResolver(prisma, { loadRole }).resolve;
  const loadRerankerRole = dependencies.loadRerankerRole ??
    loadInstallationRerankerProviderRole;
  const resolveRerankerRole = dependencies.resolveRerankerRole ??
    createRerankerModelRoleResolver(prisma, {
      loadRole: loadRerankerRole
    }).resolve;

  return {
    async list(): Promise<AdminSystemModelPolicyCatalog> {
      // Resolve the reranker role first: resolution performs one-time
      // fresh-install default adoption, and the catalog read below must see
      // the adopted selection rather than a pre-adoption snapshot.
      const rerankerResolution = await resolveRerankerRole();
      const [policy, rows, rerankerRows, resolution] =
        await Promise.all([
        prisma.systemModelPolicy.findUnique({
          include: {
            providerModel: {
              include: {
                activeCredentialChecks: {
                  select: {
                    connectionVersion: true,
                    credentialId: true,
                    credentialVersionId: true,
                    evidence: true,
                    modelVersion: true,
                    status: true
                  }
                },
                connection: {
                  include: {
                    defaultCredential: {
                      include: { activeVersion: { select: { id: true } } }
                    }
                  }
                }
              }
            },
            rerankerProviderModel: {
              include: { connection: true }
            },
            updatedBy: { select: { displayName: true, id: true } }
          },
          where: { id: "installation" }
        }),
        prisma.providerModel.findMany({
          include: {
            activeCredentialChecks: {
              select: {
                connectionVersion: true,
                credentialId: true,
                credentialVersionId: true,
                evidence: true,
                modelVersion: true,
                status: true
              }
            },
            connection: {
              include: {
                defaultCredential: {
                  include: { activeVersion: { select: { id: true } } }
                }
              }
            }
          },
          orderBy: [
            { connection: { displayName: "asc" } },
            { displayName: "asc" },
            { id: "asc" }
          ],
          where: { modelClass: "answer" }
        }),
        prisma.providerModel.findMany({
          include: { connection: true },
          orderBy: [
            { connection: { displayName: "asc" } },
            { displayName: "asc" },
            { id: "asc" }
          ],
          where: { modelClass: "reranker" }
        }),
        resolveRole()
      ]);
      if (!policy) throw new Error("installation_system_model_policy_missing");
      const models = rows as SystemModelRow[];
      const typedRerankerRows = rerankerRows as AdminAnswerModelRow[];
      const selectedRerankerId = policy.rerankerProviderModelId;
      const routeIds = selectedRerankerId
        ? approvedRerankerDeploymentByProviderModelId(selectedRerankerId)
          ? [
              selectedRerankerId,
              ...approvedRerankerDeployments
                .map(({ providerModelId }) => providerModelId)
                .filter((providerModelId) => providerModelId !== selectedRerankerId)
            ]
          : [selectedRerankerId]
        : [];
      const availableRerankerIds = new Set(rerankerResolution.ok
        ? (rerankerResolution.routes ?? [{
            providerModelId: rerankerResolution.providerModelId,
            role: rerankerResolution.role
          }]).map(({ providerModelId }) => providerModelId)
        : []);
      const rerankerRoute = routeIds.flatMap((providerModelId, position) => {
        const row = typedRerankerRows.find(({ id }) => id === providerModelId);
        if (!row) return [];
        return [{
          ...serializeRerankerModel(row),
          available: availableRerankerIds.has(providerModelId),
          position,
          relevanceScoreFloor:
            approvedRerankerDeploymentByProviderModelId(providerModelId)
              ?.preset.relevanceScoreFloor ?? null,
          role: position === 0 ? "primary" as const : "fallback" as const
        }];
      });
      return {
        candidates: models
          .filter(adminAnswerModelAvailable)
          .map(serializeSystemModel),
        rerankerCandidates: typedRerankerRows
          .filter(rerankerModelAvailable)
          .map(serializeRerankerModel),
        policy: {
          reasoningEffort: policy.reasoningEffort,
          rerankerModel: policy.rerankerProviderModel
            ? {
                ...serializeRerankerModel(
                  policy.rerankerProviderModel as AdminAnswerModelRow
                ),
                available: availableRerankerIds.has(
                  policy.rerankerProviderModelId as string
                ) && rerankerResolution.ok &&
                  rerankerResolution.policyVersion === policy.version
              }
            : null,
          rerankerRoute: {
            entries: rerankerRoute,
            policyVersion: RERANKER_ROUTE_POLICY_VERSION
          },
          systemModel: policy.providerModel
            ? {
                ...serializeSystemModel(
                  policy.providerModel as SystemModelRow
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

    async verifyStructuredOutput(input: Readonly<{
      providerModelId: string;
      signal?: AbortSignal;
    }>): Promise<void> {
      const policy = await prisma.systemModelPolicy.findUnique({
        select: {
          providerModel: {
            select: {
              activeConfig: true,
              activeCredentialChecks: {
                select: {
                  connectionVersion: true,
                  credentialId: true,
                  credentialVersionId: true,
                  evidence: true,
                  modelVersion: true,
                  status: true
                }
              },
              activeVersion: true,
              connection: {
                select: {
                  activeConfig: true,
                  activeVersion: true,
                  defaultCredential: {
                    select: {
                      activeVersion: { select: { id: true, revokedAt: true } },
                      enabled: true,
                      id: true
                    }
                  },
                  enabled: true,
                  id: true
                }
              },
              enabled: true,
              id: true
            }
          },
          providerModelId: true
        },
        where: { id: "installation" }
      });
      const model = policy?.providerModel;
      const credential = model?.connection.defaultCredential;
      if (
        !policy || !model || policy.providerModelId !== input.providerModelId ||
        model.id !== input.providerModelId || !model.enabled ||
        !model.activeConfig || model.activeVersion < 1 ||
        !model.connection.enabled || !model.connection.activeConfig ||
        model.connection.activeVersion < 1 || !credential?.enabled ||
        !credential.activeVersion || credential.activeVersion.revokedAt
      ) {
        throw new AdminSystemModelPolicyServiceError(
          "system_model_policy_target_unavailable"
        );
      }

      let configuration;
      try {
        configuration = normalizeProviderModelConfiguration(model.activeConfig);
      } catch {
        throw new AdminSystemModelPolicyServiceError(
          "system_model_policy_target_unavailable"
        );
      }
      if (!supportsStructuredOutputAdapter(configuration.adapterKind) ||
        !supportsForcedToolCallProbe(configuration.adapterKind)) {
        throw new AdminSystemModelPolicyServiceError(
          "system_model_policy_structured_output_unsupported"
        );
      }

      const existingCheck = model.activeCredentialChecks.find((check) =>
        check.connectionVersion === model.connection.activeVersion &&
        check.credentialId === credential.id &&
        check.credentialVersionId === credential.activeVersion!.id &&
        check.modelVersion === model.activeVersion &&
        check.status === "available"
      );
      if (
        structuredOutputVerificationStatus(existingCheck?.evidence, configuration) ===
          "verified" &&
        forcedToolCallVerificationStatus(existingCheck?.evidence, configuration) ===
          "verified"
      ) return;

      if (!dependencies.refreshActive) {
        throw new AdminSystemModelPolicyServiceError(
          "system_model_policy_verification_failed"
        );
      }
      try {
        const result = await dependencies.refreshActive({
          confirmPaidRequest: true,
          connectionId: model.connection.id,
          credentialId: credential.id,
          providerModelId: model.id,
          signal: input.signal
        });
        if (
          result.status !== "available" ||
          structuredOutputVerificationStatus(result.evidence, configuration) !== "verified" ||
          forcedToolCallVerificationStatus(result.evidence, configuration) !== "verified"
        ) {
          throw new Error("structured_output_not_verified");
        }
      } catch {
        throw new AdminSystemModelPolicyServiceError(
          "system_model_policy_verification_failed"
        );
      }
    },

    async update(input: Readonly<{
      expectedVersion: number;
      /** Utility fields are present together for an explicit utility-role
       * save/clear; absent preserves that independent role. */
      providerModelId?: string | null;
      /** Absent preserves the independent reranker role. Present (including
       * null) is an explicit administrator save/clear and permanently closes
       * fresh-install default adoption for this installation. */
      rerankerProviderModelId?: string | null;
      reasoningEffort?: string | null;
      userId: string;
    }>): Promise<void> {
      const providerModelId = input.providerModelId;
      const reasoningEffort = input.reasoningEffort;
      const rerankerProviderModelId = input.rerankerProviderModelId;
      const hasUtilityUpdate = providerModelId !== undefined;
      const hasReasoningUpdate = reasoningEffort !== undefined;
      if (hasUtilityUpdate !== hasReasoningUpdate ||
        !hasUtilityUpdate && rerankerProviderModelId === undefined) {
        throw new Error("system_model_policy_update_invalid");
      }
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

          if (providerModelId === null && reasoningEffort !== null) {
            throw new AdminSystemModelPolicyServiceError(
              "system_model_policy_reasoning_unavailable"
            );
          }

          if (providerModelId !== undefined && providerModelId !== null) {
            try {
              const role = await loadRole(tx, {
                providerModelId
              });
              if (reasoningEffort !== undefined && reasoningEffort !== null &&
                !supportsReasoningEffort(role, reasoningEffort)) {
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

          if (rerankerProviderModelId !== undefined &&
            rerankerProviderModelId !== null) {
            try {
              await loadRerankerRole(tx, {
                providerModelId: rerankerProviderModelId
              });
            } catch (error) {
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
              ...(hasUtilityUpdate ? {
                providerModelId,
                reasoningEffort
              } : {}),
              // Utility and reranker are independent roles. Only a request
              // that explicitly carries the reranker field fixes that role;
              // a utility-only save must not suppress later default adoption.
              ...(rerankerProviderModelId !== undefined ? {
                rerankerConfiguredAt: new Date(),
                rerankerProviderModelId
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
