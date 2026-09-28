import type { AssistantCapabilityFingerprint } from "../../contracts/assistants";
import type { KnowledgeSelection } from "../../contracts/knowledge";

/** Privacy-safe Knowledge copy of the capability fingerprint: counts, never ids or names. */
export function assistantKnowledgeFingerprint(
  selection: KnowledgeSelection
): Pick<AssistantCapabilityFingerprint, "knowledgeLabel" | "knowledgeResourceCount"> {
  if (selection.mode === "all_my_knowledge") return { knowledgeLabel: "All Knowledge", knowledgeResourceCount: 0 };
  if (selection.mode === "inherited") return { knowledgeLabel: "Knowledge", knowledgeResourceCount: 0 };
  const count = selection.mode === "explicit" ? selection.baseIds.length + selection.sourceIds.length : 0;
  return { knowledgeLabel: count > 0 ? `Knowledge · ${count}` : null, knowledgeResourceCount: count };
}
