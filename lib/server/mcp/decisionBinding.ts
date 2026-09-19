import type { Prisma } from "@prisma/client";
import type { CatalogAdapterKind } from "../../domain/catalog";
import { createDecisionModelRoleResolver } from "../providerRuntime/decisionModelRole";
import { qualifiedInteractiveDecisionModel } from "../providerRuntime/optionalDecision";
import { createSystemModelRoleResolver, applySystemModelReasoningEffort } from "../providerRuntime/systemModelRole";
import { normalizeProviderExecutionSnapshot, type ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import type { AcceptedDecisionRuntimeEvidence } from "../providerRuntime/decisionRuntime";
import type { McpRouterModelResolution } from "./router";

const SYSTEM_KEY = "mcp_system_v1";
const DECISION_KEY = "mcp_decision_v1";

/** Both destinations (including absence) are selected only at acceptance. */
export async function insertAcceptedMcpRoutingBindings(tx: Prisma.TransactionClient, runId: string): Promise<void> {
  const system = await createSystemModelRoleResolver(tx).resolve();
  const decision = await createDecisionModelRoleResolver(tx).resolve("toolDiscovery");
  const insert = async (bindingKey: string, role: "search" | "decision", snapshot: ProviderExecutionSnapshot) => {
    await tx.providerRunBinding.create({ data: {
      modelRunId: runId, bindingKey, role, credentialSource: "default",
      connectionId: snapshot.connectionId, providerModelId: snapshot.providerModelId,
      credentialId: snapshot.credentialId, credentialVersionId: snapshot.credentialVersionId,
      executionSnapshot: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonObject
    } });
  };
  if (system.ok) await insert(SYSTEM_KEY, "search", applySystemModelReasoningEffort(system.role.snapshot, system.reasoningEffort));
  if (decision.ok && qualifiedInteractiveDecisionModel(decision.role.snapshot)) await insert(DECISION_KEY, "decision", decision.role.snapshot);
}

export async function loadAcceptedMcpRoutingBindings(db: Pick<Prisma.TransactionClient, "providerRunBinding">,
  owner: Readonly<{ runId: string; userId: string }>
): Promise<Readonly<{ system: McpRouterModelResolution; decision: AcceptedDecisionRuntimeEvidence | null }>> {
  const rows = await db.providerRunBinding.findMany({ where: {
    modelRunId: owner.runId, modelRun: { userId: owner.userId }, bindingKey: { in: [SYSTEM_KEY, DECISION_KEY] }
  } });
  const snapshotFor = (key: string) => {
    const row = rows.find(r => r.bindingKey === key);
    if (!row) return null;
    const snapshot = normalizeProviderExecutionSnapshot(row.executionSnapshot);
    if (!row.connectionId || !row.providerModelId || !row.credentialId || !row.credentialVersionId ||
      snapshot.connectionId !== row.connectionId || snapshot.providerModelId !== row.providerModelId ||
      snapshot.credentialId !== row.credentialId || snapshot.credentialVersionId !== row.credentialVersionId ||
      row.role !== (key === SYSTEM_KEY ? "search" : "decision")) throw new Error("mcp_routing_binding_invalid");
    if (key === SYSTEM_KEY) {
      // General configuration normalization deliberately drops evidence-only
      // capabilities. This flag comes from the immutable admitted binding,
      // never from a browser setting or the current mutable deployment.
      const accepted = row.executionSnapshot as unknown as ProviderExecutionSnapshot;
      if (accepted.model.capabilities.structuredOutput !== true) throw new Error("mcp_routing_binding_invalid");
      return { ...snapshot, model: { ...snapshot.model, capabilities: { ...snapshot.model.capabilities, structuredOutput: true } } };
    }
    return snapshot;
  };
  const system = snapshotFor(SYSTEM_KEY);
  const decision = snapshotFor(DECISION_KEY);
  if (system && (system.model.adapterKind === "fake" || system.model.modelClass !== "answer" || system.model.capabilities.structuredOutput !== true) ||
    decision && !qualifiedInteractiveDecisionModel(decision)) throw new Error("mcp_routing_binding_invalid");
  const reasoning = system?.model.defaultParams.reasoning;
  const effort = reasoning && typeof reasoning === "object" && !Array.isArray(reasoning) &&
    typeof (reasoning as Record<string, unknown>).effort === "string" ? (reasoning as { effort: string }).effort : null;
  return {
    system: system ? { ok: true, reasoningEffort: effort, role: {
      credentialSource: "default", snapshot: system,
      modelConfiguration: { ...system.model, adapterKind: system.model.adapterKind as CatalogAdapterKind }
    } } : { ok: false, code: "system_model_absent" },
    decision: decision ? { connectionId: decision.connectionId, providerModelId: decision.providerModelId,
      credentialId: decision.credentialId!, credentialVersionId: decision.credentialVersionId!, executionSnapshot: decision } : null
  };
}
