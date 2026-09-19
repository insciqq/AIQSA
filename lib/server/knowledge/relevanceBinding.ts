import type { Prisma } from "@prisma/client";
import { createDecisionModelRoleResolver } from "../providerRuntime/decisionModelRole";
import type { AcceptedDecisionRuntimeEvidence } from "../providerRuntime/decisionRuntime";
import { normalizeProviderExecutionSnapshot, type ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import { qualifiedKnowledgeDecisionModel } from "./relevancePolicy";

const BINDING_KEY = "knowledge_relevance_v1";
export type KnowledgeRelevanceRoleResolution =
  | Readonly<{ ok: false; code: "decision_model_absent" }>
  | Readonly<{ ok: true; role: Readonly<{
    authority: Omit<AcceptedDecisionRuntimeEvidence, "executionSnapshot">;
    snapshot: ProviderExecutionSnapshot;
  }> }>;

/** Called in run acceptance. A later role assignment cannot enable, disable or
 * retarget a message already accepted; credential revocation still fences I/O. */
export async function insertAcceptedKnowledgeRelevanceBinding(tx: Prisma.TransactionClient, runId: string): Promise<void> {
  const resolved = await createDecisionModelRoleResolver(tx).resolve("knowledgeRelevance");
  if (!resolved.ok || !qualifiedKnowledgeDecisionModel(resolved.role.snapshot)) return;
  const { authority, snapshot } = resolved.role;
  await tx.providerRunBinding.create({ data: {
    modelRunId: runId, bindingKey: BINDING_KEY, role: "decision", credentialSource: "default",
    connectionId: authority.connectionId, providerModelId: authority.providerModelId,
    credentialId: authority.credentialId, credentialVersionId: authority.credentialVersionId,
    executionSnapshot: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonObject
  } });
}

export async function loadAcceptedKnowledgeRelevanceRole(
  db: Pick<Prisma.TransactionClient, "providerRunBinding">,
  owner: Readonly<{ runId: string; userId: string }>
): Promise<KnowledgeRelevanceRoleResolution> {
  const binding = await db.providerRunBinding.findFirst({ where: {
    modelRunId: owner.runId, modelRun: { userId: owner.userId }, bindingKey: BINDING_KEY, role: "decision"
  } });
  if (!binding) return { ok: false, code: "decision_model_absent" };
  const snapshot = normalizeProviderExecutionSnapshot(binding.executionSnapshot);
  if (!binding.connectionId || !binding.providerModelId || !binding.credentialId || !binding.credentialVersionId ||
    snapshot.connectionId !== binding.connectionId || snapshot.providerModelId !== binding.providerModelId ||
    snapshot.credentialId !== binding.credentialId || snapshot.credentialVersionId !== binding.credentialVersionId ||
    !qualifiedKnowledgeDecisionModel(snapshot)) throw new Error("knowledge_relevance_binding_invalid");
  return { ok: true, role: { snapshot, authority: {
    connectionId: binding.connectionId, providerModelId: binding.providerModelId,
    credentialId: binding.credentialId, credentialVersionId: binding.credentialVersionId
  } } };
}
