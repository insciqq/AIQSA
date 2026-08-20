import { z } from "zod";

const decisionIds = [
  "operation_ordinal_and_budget_reservation",
  "canonical_admitted_source_identity",
  "purpose_specific_operation_contract",
  "evidence_dispatch_manifest_checkpoint",
  "table_key_value_temporal_context",
  "claim_segmentation_citation_neighborhood",
  "semantic_validator_selection",
  "grounding_shadow_blocking_repair",
  "knowledge_profile_egress_roles",
  "answer_provider_citation_retry"
] as const;

const decisionSchema = z.strictObject({
  activationStage: z.enum(["H1", "H2", "H3", "H5", "H6", "H7"]),
  durableOwners: z.array(z.enum([
    "agent_docs/BACKEND.md",
    "agent_docs/PERSISTENCE.md",
    "agent_docs/PROVIDERS.md",
    "agent_docs/RUN_CONTRACTS.md",
    "agent_docs/TESTING.md"
  ])).min(1),
  id: z.enum(decisionIds),
  status: z.literal("pending_activation"),
  taskOwner: z.string().regex(/^202608191756\d{5}-knowledge-h[1-7]-[a-z0-9-]+$/u)
});

export const knowledgeH0DecisionRegistrySchema = z.strictObject({
  decisions: z.array(decisionSchema).length(10),
  inactiveBehaviorDocumentedAsLive: z.literal(false),
  version: z.literal("knowledge-hardening-decision-registry-v1")
});

export const KNOWLEDGE_H0_DECISION_REGISTRY = knowledgeH0DecisionRegistrySchema.parse({
  decisions: [
    {
      activationStage: "H1",
      durableOwners: ["agent_docs/PERSISTENCE.md", "agent_docs/RUN_CONTRACTS.md"],
      id: "operation_ordinal_and_budget_reservation",
      status: "pending_activation",
      taskOwner: "20260819175636453-knowledge-h1-p0-source-attribution"
    },
    {
      activationStage: "H1",
      durableOwners: ["agent_docs/PERSISTENCE.md", "agent_docs/RUN_CONTRACTS.md"],
      id: "canonical_admitted_source_identity",
      status: "pending_activation",
      taskOwner: "20260819175636453-knowledge-h1-p0-source-attribution"
    },
    {
      activationStage: "H3",
      durableOwners: ["agent_docs/BACKEND.md", "agent_docs/RUN_CONTRACTS.md"],
      id: "purpose_specific_operation_contract",
      status: "pending_activation",
      taskOwner: "20260819175637525-knowledge-h3-operation-planner-semantics"
    },
    {
      activationStage: "H2",
      durableOwners: ["agent_docs/PERSISTENCE.md", "agent_docs/RUN_CONTRACTS.md"],
      id: "evidence_dispatch_manifest_checkpoint",
      status: "pending_activation",
      taskOwner: "20260819175636966-knowledge-h2-durable-execution-dispatch"
    },
    {
      activationStage: "H5",
      durableOwners: ["agent_docs/BACKEND.md", "agent_docs/PERSISTENCE.md"],
      id: "table_key_value_temporal_context",
      status: "pending_activation",
      taskOwner: "20260819175638675-knowledge-h5-document-context-integrity"
    },
    {
      activationStage: "H6",
      durableOwners: ["agent_docs/RUN_CONTRACTS.md", "agent_docs/TESTING.md"],
      id: "claim_segmentation_citation_neighborhood",
      status: "pending_activation",
      taskOwner: "20260819175639286-knowledge-h6-semantic-shadow"
    },
    {
      activationStage: "H6",
      durableOwners: ["agent_docs/PROVIDERS.md", "agent_docs/TESTING.md"],
      id: "semantic_validator_selection",
      status: "pending_activation",
      taskOwner: "20260819175639286-knowledge-h6-semantic-shadow"
    },
    {
      activationStage: "H6",
      durableOwners: ["agent_docs/RUN_CONTRACTS.md", "agent_docs/TESTING.md"],
      id: "grounding_shadow_blocking_repair",
      status: "pending_activation",
      taskOwner: "20260819175639286-knowledge-h6-semantic-shadow"
    },
    {
      activationStage: "H2",
      durableOwners: ["agent_docs/PROVIDERS.md", "agent_docs/RUN_CONTRACTS.md"],
      id: "knowledge_profile_egress_roles",
      status: "pending_activation",
      taskOwner: "20260819175636966-knowledge-h2-durable-execution-dispatch"
    },
    {
      activationStage: "H7",
      durableOwners: [
        "agent_docs/PROVIDERS.md",
        "agent_docs/RUN_CONTRACTS.md",
        "agent_docs/TESTING.md"
      ],
      id: "answer_provider_citation_retry",
      status: "pending_activation",
      taskOwner: "20260819175639889-knowledge-h7-local-repair"
    }
  ],
  inactiveBehaviorDocumentedAsLive: false,
  version: "knowledge-hardening-decision-registry-v1"
});

if (new Set(KNOWLEDGE_H0_DECISION_REGISTRY.decisions.map(({ id }) => id)).size !==
  decisionIds.length) {
  throw new Error("knowledge_h0_decision_registry_duplicate");
}
