import type { Prisma } from "@prisma/client";
import type { AdmissionPrisma } from "./admission";
import { createMcpGuardModelRoleResolver } from "./mcpGuardModelRole";
import { applySystemModelReasoningEffort } from "./systemModelRole";
import { searchProbeBinding, type SearchProbeBinding } from "../search/probeBinding";
import { normalizeProviderExecutionSnapshot, type ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import { supportsConfiguredReasoningEffort } from "../providers/providerModelCapabilities";

export type AcceptedMcpGuardPlan = Readonly<
  | { version: 1; available: false; code: "mcp_guard_model_absent" | "mcp_guard_model_unavailable" }
  | { version: 1; available: true; policyVersion: number; authority: SearchProbeBinding;
      snapshot: ProviderExecutionSnapshot; reasoningEffort: string | null; verifiedStructuredOutput: true }
>;
export type AvailableMcpGuardPlan = Extract<AcceptedMcpGuardPlan, { available: true }>;

export function decodeAcceptedMcpGuardPlan(value: unknown): AcceptedMcpGuardPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) return null;
  if (raw.available === false) return Object.keys(raw).every(key => ["version", "available", "code"].includes(key)) &&
    (raw.code === "mcp_guard_model_absent" || raw.code === "mcp_guard_model_unavailable")
    ? { version: 1, available: false, code: raw.code } : null;
  if (raw.available !== true || Object.keys(raw).some(key => !["version", "available", "policyVersion", "authority", "snapshot", "reasoningEffort", "verifiedStructuredOutput"].includes(key)) ||
    !Number.isSafeInteger(raw.policyVersion) || Number(raw.policyVersion) < 1 || raw.verifiedStructuredOutput !== true ||
    !(raw.reasoningEffort === null || typeof raw.reasoningEffort === "string")) return null;
  try {
    const authority = searchProbeBinding(raw.authority);
    const snapshot = normalizeProviderExecutionSnapshot(raw.snapshot);
    if (!authority || snapshot.model.adapterKind === "fake" || snapshot.model.modelClass !== "answer" ||
      !snapshot.model.capabilities.structuredOutput || snapshot.connectionId !== authority.connectionId ||
      snapshot.providerModelId !== authority.providerModelId || snapshot.credentialId !== authority.credentialId ||
      snapshot.credentialVersionId !== authority.credentialVersionId || raw.reasoningEffort !== null &&
      !supportsConfiguredReasoningEffort(snapshot.model, snapshot.providerFamily, raw.reasoningEffort)) return null;
    return { version: 1, available: true, policyVersion: Number(raw.policyVersion), authority, snapshot,
      reasoningEffort: raw.reasoningEffort, verifiedStructuredOutput: true };
  } catch { return null; }
}

export function createMcpGuardPlanResolver(db: AdmissionPrisma & Pick<Prisma.TransactionClient, "systemModelPolicy">,
  resolve = createMcpGuardModelRoleResolver(db).resolve) {
  return async (): Promise<AcceptedMcpGuardPlan> => {
    const resolution = await resolve();
    if (!resolution.ok) return { version: 1, available: false,
      code: resolution.code === "system_model_absent" ? "mcp_guard_model_absent" : "mcp_guard_model_unavailable" };
    const plan = decodeAcceptedMcpGuardPlan({ version: 1, available: true, policyVersion: resolution.policyVersion,
      authority: resolution.role.authority, snapshot: applySystemModelReasoningEffort(resolution.role.snapshot, resolution.reasoningEffort),
      reasoningEffort: resolution.reasoningEffort, verifiedStructuredOutput: resolution.role.verifiedStructuredOutput });
    return plan ?? { version: 1, available: false, code: "mcp_guard_model_unavailable" };
  };
}
