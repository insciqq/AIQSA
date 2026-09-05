import type { Prisma } from "@prisma/client";
import {
  type AdmissionPrisma,
  loadInstallationAnswerProviderRole,
  ProviderAdmissionError,
  type ProviderAdmissionRole
} from "./admission";
import { systemModelRoleEligible } from "./systemModelCapabilities";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";

export const SYSTEM_MODEL_ABSENT = "system_model_absent" as const;
export const SYSTEM_MODEL_UNAVAILABLE = "system_model_unavailable" as const;

export type SystemModelRoleResolution =
  | Readonly<{
      code: typeof SYSTEM_MODEL_ABSENT | typeof SYSTEM_MODEL_UNAVAILABLE;
      ok: false;
    }>
  | Readonly<{
      credentialScope: "installation";
      ok: true;
      policyVersion: number;
      providerModelId: string;
      reasoningEffort: string | null;
      role: ProviderAdmissionRole;
    }>;

type SystemModelRolePrisma = AdmissionPrisma & Pick<
  Prisma.TransactionClient,
  "systemModelPolicy"
>;

type RoleLoader = typeof loadInstallationAnswerProviderRole;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function applySystemModelReasoningEffort(
  snapshot: ProviderExecutionSnapshot,
  reasoningEffort: string | null
): ProviderExecutionSnapshot {
  if (reasoningEffort === null) return snapshot;
  const currentReasoning = record(snapshot.model.defaultParams.reasoning)
    ? snapshot.model.defaultParams.reasoning
    : {};
  return {
    ...snapshot,
    model: {
      ...snapshot.model,
      defaultParams: {
        ...snapshot.model.defaultParams,
        reasoning: {
          ...currentReasoning,
          effort: reasoningEffort
        }
      }
    }
  };
}

export function createSystemModelRoleResolver(
  db: SystemModelRolePrisma,
  dependencies: Readonly<{ loadRole?: RoleLoader }> = {}
) {
  const loadRole = dependencies.loadRole ?? loadInstallationAnswerProviderRole;
  return {
    async resolve(): Promise<SystemModelRoleResolution> {
      const policy = await db.systemModelPolicy.findUnique({
        select: {
          providerModelId: true,
          reasoningEffort: true,
          version: true
        },
        where: { id: "installation" }
      });
      if (!policy?.providerModelId) {
        return { code: SYSTEM_MODEL_ABSENT, ok: false };
      }
      try {
        const role = await loadRole(db, {
          providerModelId: policy.providerModelId
        });
        if (!systemModelRoleEligible(role, "memory")) {
          return { code: SYSTEM_MODEL_UNAVAILABLE, ok: false };
        }
        if (policy.reasoningEffort !== null) {
          const capabilities = role.snapshot.model.capabilities;
          if (capabilities.reasoning !== true ||
            !capabilities.reasoningEfforts?.includes(policy.reasoningEffort)) {
            return { code: SYSTEM_MODEL_UNAVAILABLE, ok: false };
          }
        }
        return {
          credentialScope: "installation",
          ok: true,
          policyVersion: policy.version,
          providerModelId: policy.providerModelId,
          reasoningEffort: policy.reasoningEffort,
          role
        };
      } catch (error) {
        if (error instanceof ProviderAdmissionError) {
          return { code: SYSTEM_MODEL_UNAVAILABLE, ok: false };
        }
        throw error;
      }
    }
  };
}
